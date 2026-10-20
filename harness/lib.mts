// Shared helpers for the devnet evidence harness (not part of any commit).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";

export const DIR = new URL(".", import.meta.url).pathname;
export const RPC_URL = "https://api.devnet.solana.com";
export const WS_URL = "wss://api.devnet.solana.com";
export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const FACILITATOR_URL = "http://127.0.0.1:4020";
export const REPLICAS = { A: "http://127.0.0.1:4021", B: "http://127.0.0.1:4022" } as const;

export const rpc = createSolanaRpc(RPC_URL);
export const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);

export const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (a: string) =>
  `https://explorer.solana.com/address/${a}?cluster=devnet`;

/** The user-supplied devnet test wallet: facilitator fee payer and test-mint authority. */
export async function funder(): Promise<KeyPairSigner> {
  const b64 = readFileSync(`${DIR}funder.key.b64`, "utf8").trim();
  return createKeyPairSignerFromBytes(new Uint8Array(Buffer.from(b64, "base64")));
}

type KeyName = "payer" | "operator" | "receiverAuthorizer" | "payTo";
const KEYS_FILE = `${DIR}keys.json`;

/** Locally generated devnet-only keys, persisted as 32-byte seeds. */
export async function keys(): Promise<Record<KeyName, KeyPairSigner>> {
  const names: KeyName[] = ["payer", "operator", "receiverAuthorizer", "payTo"];
  const seeds: Record<string, string> = existsSync(KEYS_FILE)
    ? JSON.parse(readFileSync(KEYS_FILE, "utf8"))
    : {};
  let changed = false;
  for (const name of names) {
    if (!seeds[name]) {
      seeds[name] = randomBytes(32).toString("base64");
      changed = true;
    }
  }
  if (changed) writeFileSync(KEYS_FILE, JSON.stringify(seeds, null, 2), { mode: 0o600 });
  const out = {} as Record<KeyName, KeyPairSigner>;
  for (const name of names) {
    out[name] = await createKeyPairSignerFromPrivateKeyBytes(
      new Uint8Array(Buffer.from(seeds[name], "base64")),
    );
  }
  return out;
}

export type HarnessConfig = { mint: string; tokenProgram: string };
export const CONFIG_FILE = `${DIR}config.json`;
export const config = (): HarnessConfig => JSON.parse(readFileSync(CONFIG_FILE, "utf8"));

/** Sign, send and confirm a transaction paid by `feePayer`. */
export async function send(feePayer: KeyPairSigner, instructions: Instruction[]): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(signed as never, {
    commitment: "confirmed",
  });
  return getSignatureFromTransaction(signed);
}

/** Read deposit and settlement watermarks from the payment-channels Channel account. */
export async function readChannel(channelId: string) {
  const { value } = await withRetry(() =>
    rpc.getAccountInfo(channelId as never, { encoding: "base64", commitment: "confirmed" }).send(),
  );
  if (!value) return undefined;
  const data = Buffer.from(value.data[0], "base64");
  return {
    status: data.readUInt8(3),
    deposit: data.readBigUInt64LE(12),
    settled: data.readBigUInt64LE(20),
    payoutWatermark: data.readBigUInt64LE(28),
  };
}

/** Retry public-devnet RPC rate limits (HTTP 429) with backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i >= attempts || !String(error).includes("429")) throw error;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}
