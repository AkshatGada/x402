"""Ordinary refund signer outage: real SDK and Go scheme, synthetic channel only."""
import json, os, sys
from pathlib import Path
source=Path(os.environ["X402_AUDIT_SOURCE_ROOT"])
sys.path.insert(0,str(source/"python"))
import httpx
from eth_account import Account
from x402 import x402ResourceServerSync
from x402.http import FacilitatorConfig, HTTPFacilitatorClientSync
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.client.channel import BatchSettlementClientDeps, build_channel_config
from x402.mechanisms.evm.batch_settlement.client.storage import InMemoryClientChannelStorage
from x402.mechanisms.evm.batch_settlement.client.voucher import sign_voucher
from x402.mechanisms.evm.batch_settlement.server.scheme import BatchSettlementEvmScheme, BatchSettlementEvmSchemeServerConfig
from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
from x402.mechanisms.evm.signers import EthAccountSigner
from x402.schemas import PaymentPayload, PaymentRequirements
import x402
assert Path(x402.__file__).resolve().is_relative_to(source.resolve()),x402.__file__
url=os.environ['X402_PROBE_URL']
assert url.startswith('http://127.0.0.1:')
class UnavailableRefundSigner:
 def __init__(self): self.address=Account.create().address
 def sign_typed_data(self, **kwargs): raise RuntimeError('synthetic refund signer unavailable')
with httpx.Client(base_url=url) as control:
 fixture=control.get('/fixture').json()
 signer=UnavailableRefundSigner()
 remote=HTTPFacilitatorClientSync(FacilitatorConfig(url=url))
 scheme=BatchSettlementEvmScheme(fixture['requirements']['payTo'],BatchSettlementEvmSchemeServerConfig(voucher_store_mode='facilitator',refund_authorizer_signer=signer))
 server=x402ResourceServerSync(remote).register(fixture['requirements']['network'],scheme)
 server.initialize()
 req=scheme.enhance_payment_requirements(PaymentRequirements.model_validate(fixture['requirements']),remote.get_supported().kinds[0],[])
 buyer=EthAccountSigner(Account.create())
 config=build_channel_config(BatchSettlementClientDeps(buyer,InMemoryClientChannelStorage(),'1'),req)
 channel_id=compute_channel_id(config,req.network)
 raw={'type':'refund','channelConfig':config.to_dict(),'voucher':sign_voucher(buyer,channel_id,'1000',req.network).to_dict(),'amount':'500'}
 p=PaymentPayload(x402_version=2,accepted=req,payload=raw)
 setup=control.post('/setup',json={'config':config.to_dict(),'signature':raw['voucher']['signature'],'requirements':req.model_dump(by_alias=True)})
 setup.raise_for_status()
 verified=server.verify_payment(p,req)
 assert verified.is_valid, verified
 before=control.get('/state').json()
 assert before['held'] is True and before['calls']=={'verify':1,'settle':0},before
 try: server.settle_payment(p,req)
 except RuntimeError as error: assert str(error)=='synthetic refund signer unavailable'
 else: raise AssertionError('expected local signer outage')
 after=control.get('/state').json()
 second=server.verify_payment(PaymentPayload(x402_version=2,accepted=req,payload=raw),req)
 report={'result':os.environ['X402_PROBE_RESULT'],'source':x402.__file__,'before':before,'after':after,'retainedContext':scheme.read_request_context(p) is not None,'nextIsValid':second.is_valid,'nextInvalidReason':second.invalid_reason}
 if os.environ.get('X402_EXPECT_SIGNER_FIX')=='1':
  assert after['calls']=={'verify':1,'settle':1} and after['held'] is False,report
  assert second.is_valid,report
 else:
  assert after['calls']=={'verify':1,'settle':0} and after['held'] is True,report
  assert not second.is_valid and second.invalid_reason=='invalid_batch_settlement_evm_channel_busy',report
 print(json.dumps(report,separators=(',',':')))
 remote.close()
