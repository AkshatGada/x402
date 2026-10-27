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
// The corrected TS client packs the announced refund authorizer into channel identity.
const refundReq = {...requirements,extra:{...requirements.extra,refundAuthorizer:fixture.refundAuthorizer}};
const refundPayload = await makeVoucher(refundReq);
const canonical = await setup(refundPayload,refundReq);
const rejected = await facilitator.verify(refundPayload,refundReq);
assert.equal(rejected.isValid,true,JSON.stringify(rejected));
assert.equal((refundPayload.payload as any).channelConfig.salt,canonical.canonicalConfig.salt);
evidence.client = {actualSalt:(refundPayload.payload as any).channelConfig.salt,canonicalSalt:canonical.canonicalConfig.salt,goRejection:rejected.invalidReason};
// Explicit canonical salt remains a compatible control.
const prepacked = await makeVoucher(refundReq,canonical.canonicalConfig.salt);
await setup(prepacked,refundReq);
const packedControl = await directCommit(prepacked,refundReq);
evidence.clientControl = {success:packedControl.settled.success,facilitatorCharged:packedControl.remote.channel.chargedCumulativeAmount};
// With identity-authenticated refunds, TS channel construction is compatible; isolate server routing.
const payload = await makeVoucher(requirements);
await setup(payload,requirements);
const local = new InMemoryChannelStorage();
const raw = payload.payload as any;
await local.updateChannel(raw.voucher.channelId,()=>({channelId:raw.voucher.channelId,channelConfig:raw.channelConfig,chargedCumulativeAmount:'1000',signedMaxClaimable:'1000',signature:raw.voucher.signature,balance:'10000',totalClaimed:'0',withdrawRequestedAt:0,refundNonce:0,onchainSyncedAt:Date.now(),lastRequestTimestamp:Date.now()}));
const scheme = new BatchServer(requirements.payTo as `0x${string}`,{storage:local,voucherManager:'facilitator'});
const server = new x402ResourceServer(facilitator).register(requirements.network,scheme);
await server.initialize();
const verified = await server.verifyPayment(payload,requirements);
assert.equal(verified.isValid,true,JSON.stringify(verified));
const settled = await server.settlePayment(payload,requirements);
assert.equal(settled.success,true,JSON.stringify(settled));
const remote = await state();
const localAfter = await local.get(raw.voucher.channelId);
assert.equal(localAfter?.chargedCumulativeAmount,'2000');
assert.equal(remote.channel.chargedCumulativeAmount,'2000');
assert.deepEqual(remote.calls,{verify:1,settle:1});
assert.equal(remote.channel.chargeCount,1);
evidence.server = {typescriptSuccess:settled.success,typescriptCharged:localAfter!.chargedCumulativeAmount,facilitatorCharged:remote.channel.chargedCumulativeAmount,facilitatorChargeCount:remote.channel.chargeCount,facilitatorCalls:remote.calls};
await setup(payload,requirements);
const direct = await directCommit(payload,requirements);
evidence.serverControl = {success:direct.settled.success,facilitatorCharged:direct.remote.channel.chargedCumulativeAmount,facilitatorChargeCount:direct.remote.channel.chargeCount,facilitatorCalls:direct.remote.calls};
// A new server instance can use facilitator state without a shared local channel store.
await setup(payload,requirements);
const coldScheme = new BatchServer(requirements.payTo as `0x${string}`,{voucherManager:'facilitator'});
const coldServer = new x402ResourceServer(facilitator).register(requirements.network,coldScheme);
await coldServer.initialize();
assert.equal((await coldServer.verifyPayment(payload,requirements)).isValid,true);
assert.equal((await coldServer.settlePayment(payload,requirements)).success,true);
const laterPayload = await makeVoucher(requirements,salt,'2000');
const laterServer = new x402ResourceServer(facilitator).register(requirements.network,new BatchServer(requirements.payTo as `0x${string}`,{voucherManager:'facilitator'}));
await laterServer.initialize();
assert.equal((await laterServer.verifyPayment(laterPayload,requirements)).isValid,true);
assert.equal((await laterServer.settlePayment(laterPayload,requirements)).success,true);
const coldState = await state();
assert.equal(coldState.channel.chargedCumulativeAmount,'3000');
assert.equal(coldState.channel.chargeCount,2);
evidence.coldAndRestart={facilitatorCharged:coldState.channel.chargedCumulativeAmount,chargeCount:coldState.channel.chargeCount};

await setup(payload,requirements);
const cancelScheme = new BatchServer(requirements.payTo as `0x${string}`,{voucherManager:'facilitator'});
const cancelServer = new x402ResourceServer(facilitator).register(requirements.network,cancelScheme);
await cancelServer.initialize();
assert.equal((await cancelServer.verifyPayment(payload,requirements)).isValid,true);
assert.equal((await state()).held,true);
const cancel = cancelServer.createPaymentCancellationDispatcher(payload,requirements);
await cancel.cancel({reason:'handler_threw'});
await cancel.cancel({reason:'handler_threw'});
const canceled = await state();
assert.equal(canceled.held,false);
assert.equal(canceled.channel.chargedCumulativeAmount,'1000');
assert.equal(canceled.channel.chargeCount,0);
assert.deepEqual(canceled.calls,{verify:1,settle:1});
assert.equal((await cancelScheme.getStorage().list()).length,0);
evidence.cancel={held:canceled.held,facilitatorCharged:canceled.channel.chargedCumulativeAmount,chargeCount:canceled.channel.chargeCount,calls:canceled.calls};

// The real TS refund client talks to a TS resource server and the real Go scheme.
const refundSigner = privateKeyToAccount(generatePrivateKey());
const signedTerms={...requirements,extra:{...requirements.extra,refundAuthorizer:refundSigner.address}};
const refundStorage=new InMemoryClientChannelStorage();
const refundConfig=buildChannelConfig({signer:account,storage:refundStorage,salt},signedTerms);
const refundChannel=computeChannelId(refundConfig,requirements.network);
await refundStorage.set(refundChannel,{balance:'10000',chargedCumulativeAmount:'1000',totalClaimed:'0'});
const refundClient=new BatchClient(account,{storage:refundStorage,salt});
const zeroVoucher=await makeVoucher({...signedTerms,amount:'0'});
await setup(zeroVoucher,signedTerms);
const refundServer=new x402ResourceServer(facilitator).register(requirements.network,new BatchServer(requirements.payTo as `0x${string}`,{voucherManager:'facilitator',refundAuthorizerSigner:refundSigner}));
await refundServer.initialize();
const resource={url:'https://fixture.invalid/paid'};
let handlerCalls=0;
const refundResponse=await refundClient.refund(resource.url,{fetch:async (_input, init)=>{
  const paymentHeader=new Headers(init?.headers).get('PAYMENT-SIGNATURE');
  if(!paymentHeader) return new Response('{}',{status:402,headers:{'PAYMENT-REQUIRED':encodePaymentRequiredHeader({x402Version:2,resource,accepts:[signedTerms]})}});
  const submitted=decodePaymentSignatureHeader(paymentHeader);
  const verified=await refundServer.verifyPayment(submitted,signedTerms);
  assert.equal(verified.isValid,true,JSON.stringify(verified));
  if(!(verified as any).skipHandler) handlerCalls++;
  const result=await refundServer.settlePayment(submitted,signedTerms);
  assert.equal(result.success,true,JSON.stringify(result));
  return new Response('{}',{status:200,headers:{'PAYMENT-RESPONSE':encodePaymentResponseHeader(result)}});
}});
assert.equal(refundResponse.success,true);
assert.equal(refundResponse.amount,'9000');
const refunded=await state();
assert.equal((refundResponse.extra?.channelState as {balance:string}).balance,'1000');
assert.equal(refunded.held,false);
assert.equal(refundResponse.extra?.chargeCount,0);
assert.equal(handlerCalls,0);
evidence.signedRefund={amount:refundResponse.amount,balance:(refundResponse.extra?.channelState as {balance:string}).balance,chargeCount:refundResponse.extra?.chargeCount,calls:refunded.calls,handlerCalls};
evidence.result='implemented-control-passed';
writeFileSync(process.env.X402_EVIDENCE_OUTPUT!,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence));
