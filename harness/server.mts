// One resource-server replica, wired like examples/typescript/servers/batch-settlement
// (SVM, server-signed), but with a store shared by both replicas.
// Usage: REPLICA=A PORT=4021 DB=run.db tsx server.mts
import express from "../../../../node_modules/.pnpm/express@4.21.2/node_modules/express/index.js";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  paymentMiddlewareFromHTTPServer,
  setSettlementOverrides,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "../../../http/express/dist/esm/index.mjs";
import {
  BatchSvmScheme,
  MemoryBatchOperationStore,
  MemoryChannelStore,
} from "../dist/esm/batch-settlement/server/index.mjs";
import { FACILITATOR_URL, NETWORK, config, explorer, keys } from "./lib.mts";
import { SqliteBatchOperationStore, SqliteChannelStore, encode, logEvent, openDb } from "./stores.mts";

const replica = process.env.REPLICA ?? "A";
const port = Number(process.env.PORT ?? 4021);
const db = openDb(process.env.DB!);
const { mint } = config();
const k = await keys();

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
// STORE=memory is the control: the SDK's own in-memory stores (one replica).
const memory = process.env.STORE === "memory";
const store = memory ? new MemoryChannelStore() : new SqliteChannelStore(db);
const operationStore = memory ? new MemoryBatchOperationStore() : new SqliteBatchOperationStore(db);
const scheme = new BatchSvmScheme({
  withdrawDelay: 86_400,
  receiverAuthorizer: k.receiverAuthorizer,
  operator: k.operator,
  store,
  operationStore,
});
const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK as never, scheme);

// Ceiling 0.01 test tokens per impression; the handler meters the actual charge.
const accepts = [
  {
    scheme: "batch-settlement",
    price: { amount: "10000", asset: mint },
    network: NETWORK,
    payTo: k.payTo.address,
  },
];
const httpServer = new x402HTTPResourceServer(resourceServer, {
  "GET /impression": { accepts, description: "Ad impression", mimeType: "application/json" },
});
await httpServer.initialize();

const app = express();
app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
app.get("/impression", (req, res) => {
  const requestId = String(req.query.id ?? "");
  // Metered: bill 25% of the authorized ceiling (2500 atomic units).
  setSettlementOverrides(res, { amount: "25%" });
  logEvent(db, replica, "handler_served", { requestId });
  res.json({ replica, requestId, ad: "creative-42" });
});

// Redemption worker (replica A only), as in the example: claims the stored
// vouchers onchain and distributes what they settle to payTo.
if (replica === "A") {
  const supported = await facilitatorClient.getSupported();
  const kind = supported.kinds.find(
    kd => kd.scheme === "batch-settlement" && kd.network === NETWORK,
  )!;
  const requirements = await scheme.enhancePaymentRequirements(
    {
      scheme: "batch-settlement",
      network: NETWORK as never,
      amount: "10000",
      asset: mint,
      payTo: k.payTo.address,
      maxTimeoutSeconds: 300,
      extra: {},
    },
    kind,
    [],
  );
  const manager = scheme.createChannelManager(facilitatorClient, requirements, {
    onClaim: (r: { vouchers: number; transaction: string }) => {
      console.log(`[A] claimed ${r.vouchers} vouchers ${explorer(r.transaction)}`);
      logEvent(db, replica, "claim", r);
    },
    onSettle: (r: { transaction: string }) => {
      console.log(`[A] settled to payTo ${explorer(r.transaction)}`);
      logEvent(db, replica, "settle", r);
    },
    onError: (e: unknown) => console.error("[A] redemption error:", e),
  });
  app.post("/admin/redeem", async (_req, res) => {
    try {
      res.json(await manager.redeem());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

app.get("/admin/conflicts", (_req, res) =>
  res.json({ replica, conflicts: (store as { conflicts?: number }).conflicts ?? 0 }),
);
app.get("/admin/state", async (req, res) => {
  const channelId = String(req.query.channel);
  const ids = String(req.query.ids ?? "").split(",").filter(Boolean);
  const operations = await Promise.all(ids.map(id => operationStore.get(channelId, id)));
  res.type("json").send(encode({ channel: await store.get(channelId), operations: operations.filter(Boolean) }));
});
app.listen(port, () => console.log(`replica ${replica} on :${port}`));
