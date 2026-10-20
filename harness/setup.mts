// One-time devnet setup: a 6-decimal test mint, token accounts, and a payer balance.
import { existsSync, writeFileSync } from "node:fs";
import { generateKeyPairSigner } from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getCreateMintInstructionPlan,
  getMintToInstruction,
} from "@solana-program/token";
import { CONFIG_FILE, explorer, funder, keys, send } from "./lib.mts";

if (existsSync(CONFIG_FILE)) {
  console.log("config.json exists; setup already done");
  process.exit(0);
}
const authority = await funder();
const k = await keys();
const mint = await generateKeyPairSigner();

const plan = getCreateMintInstructionPlan({
  payer: authority,
  newMint: mint,
  decimals: 6,
  mintAuthority: authority.address,
}) as unknown as { plans: { instruction: never }[] };
const createMintSig = await send(
  authority,
  plan.plans.map(p => p.instruction),
);
console.log("test mint", mint.address, explorer(createMintSig));

const instructions = [];
for (const owner of [k.payer.address, k.payTo.address]) {
  instructions.push(
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: authority,
      owner,
      mint: mint.address,
    }),
  );
}
const [payerAta] = await findAssociatedTokenPda({
  owner: k.payer.address,
  mint: mint.address,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
instructions.push(
  getMintToInstruction({
    mint: mint.address,
    token: payerAta,
    mintAuthority: authority,
    amount: 100_000_000n,
  }),
);
const fundSig = await send(authority, instructions);
console.log("payer funded with 100 test tokens", explorer(fundSig));

writeFileSync(
  CONFIG_FILE,
  JSON.stringify({ mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }, null, 2),
);
console.log({
  facilitatorFeePayer: authority.address,
  payer: k.payer.address,
  operator: k.operator.address,
  receiverAuthorizer: k.receiverAuthorizer.address,
  payTo: k.payTo.address,
});
