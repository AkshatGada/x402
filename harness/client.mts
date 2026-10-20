// Drives one evidence run against the two replicas and writes RUN_DIR/result.json.
// 1. The official x402 client opens a server-signed channel on devnet (deposit).
// 2. Parallel workers for the same payer send signed per-request authorizations
//    to both replicas at once (the spec allows concurrent server-mode requests).
// 3. Replica A's redemption worker claims and settles onchain; we reconcile the
//    shared store against the devnet channel account.
// 4. The official client cooperatively refunds the rest of the deposit.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  wrapFetchWithPayment,
  x402Client,
  x402HTTPClient,
} from "../../../http/fetch/dist/esm/index.mjs";
import { signBatchAuthorization } from "../dist/esm/index.mjs";
import { BatchSvmScheme } from "../dist/esm/batch-settlement/client/index.mjs";
import type { BatchClientChannelRecord } from "../src/batch-settlement/client/scheme.ts";
import { NETWORK, REPLICAS, RPC_URL, config, explorer, explorerAddress, keys, readChannel } from "./lib.mts";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
import { decode, encode, openDb } from "./stores.mts";

const RUN_DIR = process.env.RUN_DIR!;
const LABEL = process.env.LABEL!;
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const WORKERS = Number(process.env.WORKERS ?? 8);
const SINGLE = process.env.SINGLE === "1";
const { mint } = config();
const k = await keys();
const db = openDb(`${RUN_DIR}/run.db`);
const log = (...a: unknown[]) => console.log(`[${LABEL}]`, ...a);

// 1. Deposit through the official client.
const records = new Map<string, BatchClientChannelRecord>();
const svm = new BatchSvmScheme(k.payer, {
  rpcUrl: RPC_URL,
  salt: BigInt(Date.now()),
  depositAmount: 500_000n,
  channelStorage: {
    get: async key => records.get(key),
    set: async (key, record) => void records.set(key, record),
    delete: async key => void records.delete(key),
  },
  serverSignedChannelsPolicy: {
    allowedOperators: [k.operator.address],
    allowedAssets: [{ network: NETWORK as never, asset: mint, maxDeposit: "1000000" }],
  },
});
const client = new x402Client().setSpendControls({
  allowedAssets: [{ network: NETWORK as never, asset: mint, maxAmountPerPayment: "1000000" }],
});
client.register("solana:*", svm);
client.registerPolicy(svm.paymentPolicy);
const httpClient = new x402HTTPClient(client);
const paidFetch = wrapFetchWithPayment(fetch, httpClient);

const depositResponse = await paidFetch(`${REPLICAS.A}/impression?id=deposit`);
const depositResult = await httpClient.processResponse(depositResponse);
const depositHeader = depositResponse.headers.get("payment-response");
const depositSettle = depositHeader ? decodePaymentResponseHeader(depositHeader) : undefined;
const record = [...records.values()][0];
if (!record) throw new Error(`deposit failed: ${depositResponse.status} ${JSON.stringify(depositResult)}`);
log("channel opened", record.channelId, depositSettle?.transaction ? explorer(depositSettle.transaction) : "");

// Server-signed requirements exactly as the replicas advertise them.
const unpaid = await fetch(`${REPLICAS.A}/impression`);
const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!);
const accepted = required.accepts.find(
  a => a.extra?.voucherSigner === "server",
) as PaymentRequirements;

// 2. Concurrent workers for the same payer and channel.
type Outcome = {
  round: number;
  replica: "A" | "B";
  requestId: string;
  status: number;
  success: boolean;
  chargedAmount?: string;
  cumulative?: string;
  error?: string;
};
const outcomes: Outcome[] = [];
async function worker(round: number, replica: "A" | "B"): Promise<Outcome> {
  const requestId = randomUUID();
  const authorization = await signBatchAuthorization(
    k.payer,
    record.channelId,
    k.operator.address,
    requestId,
    BigInt(accepted.amount),
    Math.floor(Date.now() / 1000) + 300,
  );
  const payment: PaymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { type: "authorization", channelConfig: record.channelConfig, authorization },
  };
  const res = await fetch(`${REPLICAS[replica]}/impression?id=${requestId}`, {
    headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment) },
  });
  const header = res.headers.get("payment-response");
  const settle = header ? decodePaymentResponseHeader(header) : undefined;
  const body = await res.text();
  const extra = (settle?.extra ?? {}) as { chargedAmount?: string; voucher?: { maxClaimableAmount?: string } };
  return {
    round,
    replica,
    requestId,
    status: res.status,
    success: res.status === 200 && settle?.success === true,
    chargedAmount: extra.chargedAmount,
    cumulative: extra.voucher?.maxClaimableAmount,
    ...(res.status === 200
      ? {}
      : { error: `${settle?.errorReason ?? ""}: ${settle?.errorMessage ?? body.slice(0, 300)}` }),
  };
}
for (let round = 1; round <= ROUNDS; round++) {
  const batch = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => worker(round, SINGLE || i % 2 === 0 ? "A" : "B")),
  );
  outcomes.push(...batch);
  log(`round ${round}: ${batch.filter(o => o.success).length}/${batch.length} paid requests succeeded`);
}

writeFileSync(`${RUN_DIR}/outcomes.json`, JSON.stringify(outcomes, null, 2));
// Store state via the replica, so the same code reads SQLite or in-memory stores.
async function state() {
  const ids = outcomes.map(o => o.requestId).join(",");
  const res = await fetch(`${REPLICAS.A}/admin/state?channel=${record.channelId}&ids=${ids}`);
  return decode<{
    channel: { chargedCumulativeAmount: bigint; settled: bigint; reservations?: Record<string, unknown> };
    operations: { requestId: string; status: string; actual?: bigint; cumulative?: bigint }[];
  }>(await res.text());
}

// 3. Onchain redemption (retried while devnet confirmation is pending), then
// reconcile the shared store against the devnet channel account.
const redeemAttempts: unknown[] = [];
for (let attempt = 1; attempt <= 6; attempt++) {
  redeemAttempts.push(await (await fetch(`${REPLICAS.A}/admin/redeem`, { method: "POST" })).json());
  const charged = (await state()).channel.chargedCumulativeAmount;
  const chain = await readChannel(record.channelId);
  log(`redeem attempt ${attempt}: server charged ${charged}, onchain settled ${chain?.settled}, paid out ${chain?.payoutWatermark}`);
  if (chain && chain.settled === charged && chain.payoutWatermark === charged) break;
  await sleep(8000);
}
const redeem = redeemAttempts;
const events = (db.prepare("SELECT at, replica, kind, detail FROM events ORDER BY at").all() as {
  at: number; replica: string; kind: string; detail: string;
}[]).map(e => ({ ...e, detail: decode<Record<string, unknown>>(e.detail) }));
const final = await state();
writeFileSync(`${RUN_DIR}/state.json`, encode(final));
const channel = final.channel;
const operations = final.operations;
const onchain = await readChannel(record.channelId);
const conflicts = await Promise.all(
  Object.values(REPLICAS).map(async u => (await (await fetch(`${u}/admin/conflicts`)).json()).conflicts as number),
);

const workerIds = new Set(outcomes.map(o => o.requestId));
const workerOps = operations.filter(o => workerIds.has(o.requestId));
const completedActual = workerOps
  .filter(o => o.status === "completed")
  .reduce((s, o) => s + (o.actual ?? 0n), 0n);
const servedWorkers = events.filter(e => e.kind === "handler_served" && workerIds.has(String(e.detail.requestId))).length;
const result = {
  label: LABEL,
  channelId: record.channelId,
  channelUrl: explorerAddress(record.channelId),
  depositTx: depositSettle?.transaction,
  requests: outcomes.length,
  succeeded: outcomes.filter(o => o.success).length,
  failed: outcomes.filter(o => !o.success).length,
  failureReasons: [...new Set(outcomes.filter(o => !o.success).map(o => o.error?.trim()))],
  handlerServed: servedWorkers,
  storeWriteConflicts: conflicts.reduce((a, b) => a + b, 0),
  operations: {
    completed: workerOps.filter(o => o.status === "completed").length,
    reserved: workerOps.filter(o => o.status === "reserved").length,
    completedActualSum: completedActual.toString(),
  },
  store: SINGLE ? "memory (SDK default), 1 replica" : "shared SQLite, optimistic retry, 2 replicas",
  heldReservations: Object.keys(channel.reservations ?? {}).length,
  serverChannelChargedCumulative: channel.chargedCumulativeAmount.toString(),
  // Deposit request was charged 2500 before the workers ran.
  serverChargedForWorkers: (channel.chargedCumulativeAmount - 2500n).toString(),
  onchainSettledAfterRedeem: onchain ? onchain.settled.toString() : "closed",
  onchainDeposit: onchain ? onchain.deposit.toString() : "closed",
  redeem,
  claimAndSettleTxs: events.filter(e => e.kind === "claim" || e.kind === "settle").map(e => ({
    kind: e.kind,
    tx: String(e.detail.transaction),
    url: explorer(String(e.detail.transaction)),
  })),
  outcomes,
};

// 4. Cooperative refund of the remaining deposit.
try {
  const refund = await svm.refund(`${REPLICAS.A}/impression`);
  (result as Record<string, unknown>).refund = refund;
  log("refund response", JSON.stringify(refund));
} catch (error) {
  (result as Record<string, unknown>).refundError = error instanceof Error ? error.message : String(error);
  log("refund failed:", (result as Record<string, unknown>).refundError);
}

writeFileSync(`${RUN_DIR}/result.json`, JSON.stringify(result, null, 2));
const { outcomes: _o, redeem: _r, ...summary } = result;
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
