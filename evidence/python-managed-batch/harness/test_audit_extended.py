"""Additional protocol controls, distinct from implementation-mirroring unit tests."""
from types import SimpleNamespace
import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data
import test_audit_lifecycle as h
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.client.channel import BatchSettlementClientDeps
from x402.mechanisms.evm.batch_settlement.client.hooks import create_batch_settlement_client_hooks
from x402.mechanisms.evm.batch_settlement.client.storage import BatchSettlementClientContext, InMemoryClientChannelStorage
from x402.mechanisms.evm.batch_settlement.constants import REFUND_TYPES
from x402.mechanisms.evm.batch_settlement.utils import coerce_bytes32, get_batch_settlement_eip712_domain
from x402.schemas import PaymentResponseContext, SettleError, SkipSettleResult

@pytest.mark.parametrize('async_mode',[False,True])
@pytest.mark.parametrize('bad',['01','+1',' 1',True,1.5,2**53])
def test_noncanonical_admitted_uint_rejected_and_known_admission_canceled(async_mode,bad):
 remote,scheme,server,p=h.scenario(async_mode,kind='voucher')
 remote.verify_extra['refundNonce']=bad
 result=h.verify(async_mode,server,p)
 assert not result.is_valid
 assert len(h.cancel_calls(remote))==1
 assert h.cancel_calls(remote)[0][1].payload['pendingId']=='trusted-admission'

@pytest.mark.parametrize('async_mode',[False,True])
@pytest.mark.parametrize('bad',['01','+1',' 1',True,1.5,2**53])
def test_noncanonical_committed_uint_is_receipt_abort_not_replica_warning(async_mode,bad,caplog):
 remote,scheme,server,p=h.scenario(async_mode)
 assert h.verify(async_mode,server,p).is_valid
 receipt=remote.receipt(p);receipt.extra['channelState']['refundNonce']=bad;remote.outcomes=[receipt]
 result=h.settle(async_mode,server,p)
 assert result is receipt and not result.success and result.after_settle_aborted
 assert result.transaction=='0xsynthetic' and result.amount=='500'
 assert not h.cancel_calls(remote)
 assert 'replica' not in caplog.text

@pytest.mark.parametrize('async_mode',[False,True])
def test_optional_replica_outage_preserves_receipt_and_real_buyer_advances(async_mode,monkeypatch,caplog):
 remote,scheme,server,p=h.scenario(async_mode,kind='voucher')
 assert h.verify(async_mode,server,p).is_valid
 class BrokenStore:
  def update_channel(self,*args):raise OSError('synthetic replica offline')
 monkeypatch.setattr(scheme,'get_storage',lambda:BrokenStore())
 receipt=remote.receipt(p);receipt.transaction='';receipt.amount='';receipt.extra['chargeCount']=2;receipt.extra['chargedAmount']='100';receipt.extra['channelState']['chargedCumulativeAmount']='1100';remote.outcomes=[receipt]
 result=h.settle(async_mode,server,p)
 assert result is receipt and result.success and result.extra['chargeCount']==2
 assert scheme.read_request_context(p) is None and not h.cancel_calls(remote)
 assert len([r for r in caplog.records if 'replica' in r.message.lower()])==1
 client_storage=InMemoryClientChannelStorage();cid=p.payload['voucher']['channelId'];client_storage.set(cid,BatchSettlementClientContext(balance='10000',charged_cumulative_amount='1000'))
 hooks=create_batch_settlement_client_hooks(BatchSettlementClientDeps(SimpleNamespace(address=p.payload['channelConfig']['payer']),client_storage,'1'))
 hooks.on_payment_response(PaymentResponseContext(payment_payload=p,requirements=p.accepted,settle_response=result))
 assert client_storage.get(cid).charged_cumulative_amount=='1100'

@pytest.mark.parametrize('async_mode',[False,True])
@pytest.mark.parametrize('transaction,reason',[('0xalready-broadcast','synthetic'),(None,'settlement_pending')])
def test_receipt_bearing_local_enrichment_error_does_not_cancel(async_mode,transaction,reason,monkeypatch):
 remote,scheme,server,p=h.scenario(async_mode)
 assert h.verify(async_mode,server,p).is_valid
 error=SettleError(reason,transaction=transaction)
 def enrich(ctx):raise error
 monkeypatch.setattr(scheme,'enrich_settlement_payload',enrich)
 with pytest.raises(SettleError) as raised:h.settle(async_mode,server,p)
 assert raised.value is error and not h.cancel_calls(remote)
 assert scheme.read_request_context(p).pending_id=='trusted-admission'

@pytest.mark.parametrize('async_mode',[False,True])
def test_thrown_before_settle_hook_preserves_existing_behavior(async_mode):
 remote,scheme,server,p=h.scenario(async_mode)
 assert h.verify(async_mode,server,p).is_valid
 def thrown(ctx):raise RuntimeError('synthetic user hook failure')
 server.on_before_settle(thrown)
 with pytest.raises(RuntimeError,match='synthetic user hook failure'):h.settle(async_mode,server,p)
 assert not h.cancel_calls(remote)
 assert scheme.read_request_context(p).pending_id=='trusted-admission'

@pytest.mark.parametrize('async_mode',[False,True])
def test_skip_settle_result_preserves_existing_behavior(async_mode):
 remote,scheme,server,p=h.scenario(async_mode)
 assert h.verify(async_mode,server,p).is_valid
 receipt=remote.receipt(p)
 server.on_before_settle(lambda ctx:SkipSettleResult(result=receipt))
 assert h.settle(async_mode,server,p) is receipt
 assert [call[0] for call in remote.calls]==['verify']

@pytest.mark.parametrize('async_mode',[False,True])
def test_actual_refund_signature_carries_uint256_nonce_exactly(async_mode):
 signer=LocalAuthorizerSigner(Account.create());remote,scheme,server,p=h.scenario(async_mode,signer=signer)
 nonce=(1<<200)+12345;remote.verify_extra['refundNonce']=str(nonce)
 assert h.verify(async_mode,server,p).is_valid
 assert h.settle(async_mode,server,p).success
 enriched=remote.calls[-1][1].payload
 message=encode_typed_data(domain_data=get_batch_settlement_eip712_domain(84532),message_types=REFUND_TYPES,message_data={'channelId':coerce_bytes32(p.payload['voucher']['channelId']),'nonce':nonce,'amount':500})
 assert Account.recover_message(message,signature=enriched['refundAuthorizerSignature'])==signer.address

@pytest.mark.parametrize('async_mode',[False,True])
@pytest.mark.parametrize('shape',['missing-state','invalid-nonce'])
def test_committed_receipt_validation_does_not_depend_on_local_context(async_mode,shape):
 remote,scheme,server,p=h.scenario(async_mode,kind='voucher')
 receipt=remote.receipt(p)
 if shape=='missing-state':receipt.extra.pop('channelState')
 else:receipt.extra['channelState']['refundNonce']='01'
 # An application hook can return an already obtained authoritative receipt.
 # Its validation must not depend on a previous local verify cache entry.
 server.on_before_settle(lambda ctx:SkipSettleResult(result=receipt))
 assert scheme.read_request_context(p) is None
 result=h.settle(async_mode,server,p)
 assert result is receipt and not result.success and result.after_settle_aborted
 assert result.transaction=='0xsynthetic' and not remote.calls

@pytest.mark.parametrize('async_mode',[False,True])
@pytest.mark.parametrize('kind',['voucher','deposit'])
@pytest.mark.parametrize('shape',['complete','missing-nonce'])
def test_direct_paid_settle_without_local_verify_reaches_remote_and_validates_receipt(async_mode,kind,shape):
 remote,scheme,server,p=h.scenario(async_mode,kind=kind)
 if kind=='deposit':
  p.payload['deposit']={'amount':'10000','authorization':{'erc3009Authorization':{'validAfter':'0','validBefore':'9999999999','salt':'0x'+'00'*32,'signature':'0x'+'12'*65}}}
 receipt=remote.receipt(p);receipt.extra['chargedAmount']='100'
 if shape=='missing-nonce':receipt.extra['channelState'].pop('refundNonce')
 remote.outcomes=[receipt]
 assert scheme.read_request_context(p) is None
 result=h.settle(async_mode,server,p)
 assert result is receipt and result.success==(shape=='complete')
 assert [call[0] for call in remote.calls]==['settle']
 assert 'pendingId' not in remote.calls[0][1].payload
 assert 'pendingId' not in p.payload and not h.cancel_calls(remote)
 if shape!='complete':assert result.after_settle_aborted and result.transaction=='0xsynthetic'
