// Create the payment-channels devnet treasury ATA for the test mint (required by the facilitator).
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { config, explorer, funder, send } from "./lib.mts";
const DEVNET_TREASURY_OWNER = "4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap"; // src/payment-channels/onchain.ts
const authority = await funder();
const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({
  payer: authority,
  owner: DEVNET_TREASURY_OWNER as never,
  mint: config().mint as never,
});
console.log("treasury ATA", explorer(await send(authority, [ix])));
