import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { BatchSettlementEvmScheme as BatchClient } from '__SOURCE_ROOT__/typescript/packages/mechanisms/evm/src/batch-settlement/client/scheme';
import { InMemoryClientChannelStorage } from '__SOURCE_ROOT__/typescript/packages/mechanisms/evm/src/batch-settlement/client/storage';
import { buildChannelConfig } from '__SOURCE_ROOT__/typescript/packages/mechanisms/evm/src/batch-settlement/client/channel';
import { BatchSettlementEvmScheme as BatchServer } from '__SOURCE_ROOT__/typescript/packages/mechanisms/evm/src/batch-settlement/server/scheme';
import { InMemoryChannelStorage } from '__SOURCE_ROOT__/typescript/packages/mechanisms/evm/src/batch-settlement/server/storage';
import { computeChannelId } from '__SOURCE_ROOT__/typescript/packages/mechanisms/evm/src/batch-settlement/utils';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

const url = process.env.X402_PROBE_URL!;
assert.ok(url?.startsWith('http://127.0.0.1:'), 'probe must use a loopback fixture');
const fixture = await fetch(`${url}/fixture`).then(r => r.json());
const requirements = fixture.requirements as PaymentRequirements;
const account = privateKeyToAccount(generatePrivateKey());
const salt = `0x${'ab'.repeat(32)}` as const;
const facilitator = new HTTPFacilitatorClient({ url });
const evidence: Record<string, unknown> = { revision: 'dbe1080ac7f65e2e05cc8430a834c255a6800828' };
async function setup(payload: PaymentPayload, req: PaymentRequirements) {
  const raw = payload.payload as any;
  const r = await fetch(`${url}/setup`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:raw.channelConfig,signature:raw.voucher.signature,requirements:req})});
  assert.equal(r.status,200,await r.clone().text());
  return r.json();
}
async function state() { return fetch(`${url}/state`).then(r=>r.json()); }
async function makeVoucher(req: PaymentRequirements, selectedSalt: `0x${string}` = salt, charged = '1000') {
  const storage = new InMemoryClientChannelStorage();
  const config = buildChannelConfig({signer:account,storage,salt:selectedSalt},req);
  const channelId = computeChannelId(config,req.network);
  await storage.set(channelId,{balance:'10000',chargedCumulativeAmount:charged,totalClaimed:'0'});
  const client = new BatchClient(account,{storage,salt:selectedSalt});
  const result = await client.createPaymentPayload(2,req);
  return {x402Version:2,accepted:req,payload:result.payload} as PaymentPayload;
}
async function directCommit(payload: PaymentPayload, req: PaymentRequirements) {
  const verified = await facilitator.verify(payload,req);
  assert.equal(verified.isValid,true,JSON.stringify(verified));
  assert.equal(typeof verified.extra?.pendingId,'string');
  const enriched = {...payload,payload:{...payload.payload,pendingId:verified.extra!.pendingId}};
  const settled = await facilitator.settle(enriched,req);
  assert.equal(settled.success,true,JSON.stringify(settled));
  assert.equal(settled.extra?.chargedAmount,'1000');
  const remote = await state();
  assert.equal(remote.channel.chargedCumulativeAmount,'2000');
  assert.equal(remote.channel.chargeCount,1);
  assert.equal(remote.held,false);
  return {verified,settled,remote};
}
// An ordinary refund signing-service error happens before facilitator settlement.
const refundSigner = privateKeyToAccount(generatePrivateKey());
const signedTerms = {...requirements,extra:{...requirements.extra,refundAuthorizer:refundSigner.address}};
const clientStorage = new InMemoryClientChannelStorage();
const config = buildChannelConfig({signer:account,storage:clientStorage,salt},signedTerms);
const channelId = computeChannelId(config,signedTerms.network);
await clientStorage.set(channelId,{balance:'10000',chargedCumulativeAmount:'1000',totalClaimed:'0'});
const client = new BatchClient(account,{storage:clientStorage,salt});
await setup(await makeVoucher({...signedTerms,amount:'0'}),signedTerms);
const unavailableSigner = {address:refundSigner.address,signTypedData:async () => {throw new Error('simulated_signer_unavailable');}};
const scheme = new BatchServer(requirements.payTo as `0x${string}`,{voucherManager:'facilitator',refundAuthorizerSigner:unavailableSigner});
const server = new x402ResourceServer(facilitator).register(requirements.network,scheme);
await server.initialize();
let signingError = '';
const resource = {url:'https://fixture.invalid/paid'};
await client.refund(resource.url,{fetch:async (_input,init)=>{
  const header = new Headers(init?.headers).get('PAYMENT-SIGNATURE');
  if(!header) return new Response('{}',{status:402,headers:{'PAYMENT-REQUIRED':encodePaymentRequiredHeader({x402Version:2,resource,accepts:[signedTerms]})}});
  const submitted = decodePaymentSignatureHeader(header);
  assert.equal((await server.verifyPayment(submitted,signedTerms)).isValid,true);
  try { await server.settlePayment(submitted,signedTerms); }
  catch(error) { signingError = error instanceof Error ? error.message : String(error); }
  const response = {success:false,errorReason:signingError,network:signedTerms.network,transaction:''};
  return new Response('{}',{status:500,headers:{'PAYMENT-RESPONSE':encodePaymentResponseHeader(response)}});
}});
assert.equal(signingError,'simulated_signer_unavailable');
const remote = await state();
const result = {scenario:'ordinary-refund-signer-failure',signingError,held:remote.held,calls:remote.calls};
writeFileSync(process.env.X402_EVIDENCE_OUTPUT!,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
assert.equal(remote.held,false,'a pre-settle refund signing failure must release verified admission');
console.log(JSON.stringify({result:'ordinary-signer-failure-passed'}));
