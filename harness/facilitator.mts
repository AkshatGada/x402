// Devnet facilitator, trimmed from examples/typescript/facilitator/batch-settlement (SVM part).
import express from "../../../../node_modules/.pnpm/express@4.21.2/node_modules/express/index.js";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "../dist/esm/index.mjs";
import {
  BatchSvmScheme,
  InMemoryBatchChannelStorage,
} from "../dist/esm/batch-settlement/facilitator/index.mjs";
import { NETWORK, RPC_URL, funder } from "./lib.mts";

const account = await funder();
const facilitator = new x402Facilitator();
facilitator.register(
  NETWORK as never,
  new BatchSvmScheme(toFacilitatorSvmSigner(account, { defaultRpcUrl: RPC_URL }), {
    channelStorage: new InMemoryBatchChannelStorage(),
  }),
);

const app = express();
app.use(express.json());
app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    const response = await facilitator.verify(paymentPayload, paymentRequirements);
    if (!response.isValid) console.log("[facilitator] verify invalid:", JSON.stringify(response));
    res.json(response);
  } catch (error) {
    console.error("verify error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    const response = await facilitator.settle(paymentPayload, paymentRequirements);
    console.log(`[facilitator] settle success=${response.success} tx=${response.transaction}`);
    res.json(response);
  } catch (error) {
    console.error("settle error:", error);
    if (error instanceof Error && error.message.includes("Settlement aborted:")) {
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network ?? "unknown",
      });
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));
app.listen(4020, () => console.log(`facilitator on :4020, fee payer ${account.address}`));
