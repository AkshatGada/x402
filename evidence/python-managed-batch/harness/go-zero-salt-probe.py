"""Default-zero salt interoperability against real Go; all chain state synthetic."""
import json,os,sys
from pathlib import Path
source=Path(os.environ['X402_AUDIT_SOURCE_ROOT'])
sys.path.insert(0,str(source/'python'))
import x402
assert Path(x402.__file__).resolve().is_relative_to(source.resolve()),x402.__file__
import httpx
from eth_account import Account
from x402 import x402ResourceServerSync
from x402.http import FacilitatorConfig,HTTPFacilitatorClientSync
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.client.channel import BatchSettlementClientDeps,build_channel_config
from x402.mechanisms.evm.batch_settlement.client.storage import InMemoryClientChannelStorage
from x402.mechanisms.evm.batch_settlement.client.voucher import sign_voucher
from x402.mechanisms.evm.batch_settlement.server.scheme import BatchSettlementEvmScheme,BatchSettlementEvmSchemeServerConfig
from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
from x402.mechanisms.evm.signers import EthAccountSigner
from x402.schemas import PaymentPayload,PaymentRequirements
url=os.environ['X402_PROBE_URL'];assert url.startswith('http://127.0.0.1:')
reports=[]
with httpx.Client(base_url=url) as control:
 fixture=control.get('/fixture').json()
 for signed in [False,True]:
  signer=LocalAuthorizerSigner(Account.create()) if signed else None
  remote=HTTPFacilitatorClientSync(FacilitatorConfig(url=url))
  scheme=BatchSettlementEvmScheme(fixture['requirements']['payTo'],BatchSettlementEvmSchemeServerConfig(voucher_store_mode='facilitator',refund_authorizer_signer=signer))
  server=x402ResourceServerSync(remote).register(fixture['requirements']['network'],scheme);server.initialize()
  req=scheme.enhance_payment_requirements(PaymentRequirements.model_validate(fixture['requirements']),remote.get_supported().kinds[0],[])
  wallet=EthAccountSigner(Account.create());config=build_channel_config(BatchSettlementClientDeps(wallet,InMemoryClientChannelStorage(),'0'),req);cid=compute_channel_id(config,req.network)
  voucher=sign_voucher(wallet,cid,'2000',req.network).to_dict();p=PaymentPayload(x402_version=2,accepted=req,payload={'type':'voucher','channelConfig':config.to_dict(),'voucher':voucher})
  setup=control.post('/setup',json={'config':config.to_dict(),'signature':voucher['signature'],'requirements':req.model_dump(by_alias=True)});setup.raise_for_status()
  # setup.channelId uses Go ComputeChannelId on the supplied immutable config.
  # Its optional canonicalConfig helper re-packs an already packed salt, so it
  # is deliberately not used as a channel-salt derivation oracle here.
  assert setup.json()['channelId'].lower()==cid.lower()
  assert config.salt[:26]=='0x'+'00'*12
  assert server.verify_payment(p,req).is_valid
  paid=server.settle_payment(p,req);assert paid.success,paid
  assert paid.extra['chargeCount']==1
  rp=PaymentPayload(x402_version=2,accepted=req,payload={'type':'refund','channelConfig':config.to_dict(),'voucher':sign_voucher(wallet,cid,'2000',req.network).to_dict(),'amount':'500'})
  verified=server.verify_payment(rp,req);assert verified.is_valid and verified.skip_handler is not None
  refunded=server.settle_payment(rp,req);assert refunded.success,refunded
  state=control.get('/state').json();assert not state['held'] and state['channel']['chargeCount']==0
  reports.append({'consent':'signed' if signed else 'delegated','salt':config.salt,'channelId':cid,'calls':state['calls'],'refundSucceeded':True})
  remote.close()
print(json.dumps({'result':'zero-salt-passed','source':x402.__file__,'scenarios':reports},separators=(',',':')))
