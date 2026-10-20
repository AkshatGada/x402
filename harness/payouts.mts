// For each run's channel: find devnet transactions that touched both the channel and the
// payTo token account, and the payTo token delta in each. Writes evidence/payouts.json.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { DIR, config, explorer, keys, rpc, withRetry } from "./lib.mts";
const k = await keys();
const [ata] = await findAssociatedTokenPda({ owner: k.payTo.address, mint: config().mint as never, tokenProgram: TOKEN_PROGRAM_ADDRESS });
const sigs = await withRetry(() => rpc.getSignaturesForAddress(ata, { limit: 50 }).send());
const txs = [];
for (const s of sigs) {
  const tx = await withRetry(() => rpc.getTransaction(s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send());
  if (!tx) continue;
  const keysList = tx.transaction.message.accountKeys.map((a: { pubkey: string }) => String(a.pubkey));
  const idx = keysList.indexOf(ata);
  const pre = tx.meta?.preTokenBalances?.find(b => b.accountIndex === idx)?.uiTokenAmount.amount ?? "0";
  const post = tx.meta?.postTokenBalances?.find(b => b.accountIndex === idx)?.uiTokenAmount.amount ?? "0";
  txs.push({ signature: s.signature, keys: keysList, payToDelta: (BigInt(post) - BigInt(pre)).toString() });
  await new Promise(r => setTimeout(r, 300));
}
const out: Record<string, unknown> = {};
for (const dir of readdirSync(`${DIR}runs`).filter(d => /^(baseline|fix)(-control-memory)?-\d/.test(d))) {
  const r = JSON.parse(readFileSync(`${DIR}runs/${dir}/result.json`, "utf8"));
  out[dir] = txs.filter(t => t.keys.includes(r.channelId)).map(t => ({ tx: t.signature, url: explorer(t.signature), payToDelta: t.payToDelta }));
}
writeFileSync(`${DIR}evidence/payouts.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
