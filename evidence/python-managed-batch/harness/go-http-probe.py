"""Real Go scheme and real Python HTTP adapter; synthetic chain, no funds/RPC."""
import json
import os

import httpx
from eth_account import Account

from x402 import x402ResourceServerSync
from x402.http import FacilitatorConfig, HTTPFacilitatorClientSync
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.client.channel import BatchSettlementClientDeps, build_channel_config
from x402.mechanisms.evm.batch_settlement.client.config import BatchSettlementEvmSchemeOptions
from x402.mechanisms.evm.batch_settlement.client.scheme import BatchSettlementEvmScheme as Buyer
from x402.mechanisms.evm.batch_settlement.client.storage import BatchSettlementClientContext, InMemoryClientChannelStorage
from x402.mechanisms.evm.batch_settlement.server.scheme import BatchSettlementEvmScheme, BatchSettlementEvmSchemeServerConfig
from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
from x402.mechanisms.evm.signers import EthAccountSigner
from x402.interfaces import SchemePaymentRequiredContext
from x402.schemas import AbortResult, PaymentPayload, PaymentRequired, PaymentRequirements
from x402.mechanisms.evm.batch_settlement.client.voucher import sign_voucher
from x402.mechanisms.evm.batch_settlement.client.recovery import process_corrective_payment_required
from x402.schemas.hooks import VerifiedPaymentCancelOptions

url = os.environ['X402_PROBE_URL']
assert url.startswith('http://127.0.0.1:')
control = httpx.Client(base_url=url)
fixture = control.get('/fixture').json()
class SyntheticReadSigner(EthAccountSigner):
    def read_contract(self, address, abi, function, *args):
        assert function == 'channels' and args[-1] == self.expected_channel_id
        return [10000, 0]  # Same synthetic on-chain view as the Go fixture.

results = []
for signed_refund in (False, True):
    refund_signer = LocalAuthorizerSigner(Account.create().key.hex()) if signed_refund else None
    remote = HTTPFacilitatorClientSync(FacilitatorConfig(url=url))
    schemes = [BatchSettlementEvmScheme(fixture['requirements']['payTo'], BatchSettlementEvmSchemeServerConfig(
        voucher_store_mode='facilitator', refund_authorizer_signer=refund_signer,
    )) for _ in range(2)]
    servers = [x402ResourceServerSync(remote).register(fixture['requirements']['network'], s) for s in schemes]
    for server in servers:
        server.initialize()
    req = schemes[0].enhance_payment_requirements(
        PaymentRequirements.model_validate(fixture['requirements']), remote.get_supported().kinds[0], []
    )
    wallet = SyntheticReadSigner(Account.create())
    storage = InMemoryClientChannelStorage()
    salt = '1'
    deps = BatchSettlementClientDeps(wallet, storage, salt)
    config = build_channel_config(deps, req)
    channel_id = compute_channel_id(config, req.network)
    wallet.expected_channel_id = channel_id
    storage.set(channel_id.lower(), BatchSettlementClientContext(balance='10000', charged_cumulative_amount='1000', total_claimed='0'))
    buyer = Buyer(wallet, BatchSettlementEvmSchemeOptions(salt=salt, storage=storage))
    p = PaymentPayload(x402_version=2, accepted=req, payload=buyer.create_payment_payload(req))
    setup = control.post('/setup', json={'config':config.to_dict(), 'signature':p.payload['voucher']['signature'], 'requirements':req.model_dump(by_alias=True)})
    setup.raise_for_status()
    assert setup.json()['canonicalChannelId'].lower() == channel_id.lower()
    assert setup.json()['canonicalConfig']['salt'].lower() == config.salt.lower()
    vr = servers[0].verify_payment(p, req)
    assert vr.is_valid, str(vr.invalid_reason)
    assert vr.extra['pendingId']
    receipt = servers[0].settle_payment(p, req)
    assert receipt.success, str(receipt)
    assert receipt.extra['chargedAmount'] == '1000'
    state = control.get('/state').json()
    assert state['channel']['chargedCumulativeAmount'] == '2000'
    assert state['channel']['chargeCount'] == 1 and not state['held']
    assert state['calls'] == {'verify':1, 'settle':1}
    replay = servers[0].settle_payment(p, req)
    assert not replay.success
    state = control.get('/state').json()
    assert state['channel']['chargeCount'] == 1
    assert state['calls'] == {'verify':1, 'settle':2}  # No retry of an off-chain commit.
    stale = servers[1].verify_payment(p, req)
    assert not stale.is_valid
    corrective = schemes[1].enrich_payment_required_response(SchemePaymentRequiredContext(
        requirements=[req.model_copy(deep=True)], resource_info=None, error=stale.invalid_reason,
        payment_required_response=PaymentRequired(x402_version=2, accepts=[req]), payment_payload=p,
    ))
    assert corrective[0].extra['channelState']['chargedCumulativeAmount'] == '2000'
    assert corrective[0].extra['voucherState']['signedMaxClaimable'] == '2000'
    assert corrective[0].extra['voucherState']['signature'] == p.payload['voucher']['signature']
    assert process_corrective_payment_required(deps, PaymentRequired(x402_version=2, accepts=corrective, error=stale.invalid_reason))
    assert storage.get(channel_id.lower()).charged_cumulative_amount == '2000'
    # The other resource server has no local authoritative row. It still admits
    # and cancels at the same Go facilitator, releasing its admission lock.
    p2 = PaymentPayload(x402_version=2, accepted=req, payload=buyer.create_payment_payload(req))
    assert servers[1].verify_payment(p2, req).is_valid
    dispatcher = servers[1].create_payment_cancellation_dispatcher(p2, req)
    cancelled = dispatcher.cancel_sync(VerifiedPaymentCancelOptions(reason='handler_failed'))
    assert cancelled.success, str(cancelled)
    assert dispatcher.cancel_sync(VerifiedPaymentCancelOptions(reason='handler_failed')) is cancelled
    state = control.get('/state').json()
    assert state['channel']['chargedCumulativeAmount'] == '2000'
    assert state['channel']['chargeCount'] == 1 and not state['held']
    assert state['calls'] == {'verify':3, 'settle':3}
    abort_scheme = BatchSettlementEvmScheme(req.pay_to, BatchSettlementEvmSchemeServerConfig(voucher_store_mode='facilitator', refund_authorizer_signer=refund_signer))
    abort_server = x402ResourceServerSync(remote).register(req.network, abort_scheme)
    abort_server.on_after_verify(lambda _: AbortResult(reason='application_declined'))
    abort_server.initialize()
    aborted = abort_server.verify_payment(p2, req)
    assert not aborted.is_valid and aborted.invalid_reason == 'application_declined'
    state = control.get('/state').json()
    assert state['channel']['chargeCount'] == 1 and not state['held']
    assert state['calls'] == {'verify':4, 'settle':4}
    refund_payload = PaymentPayload(x402_version=2, accepted=req, payload={
        'type':'refund', 'channelConfig':config.to_dict(), 'voucher':sign_voucher(wallet, channel_id, '2000', req.network).to_dict(), 'amount':'500'
    })
    refund_verified = servers[1].verify_payment(refund_payload, req)
    assert refund_verified.is_valid and refund_verified.skip_handler is not None
    refunded = servers[1].settle_payment(refund_payload, req)
    assert refunded.success, str(refunded)
    assert refunded.extra['chargeCount'] == 0
    state = control.get('/state').json()
    assert state['channel']['chargeCount'] == 0 and not state['held'], state
    assert state['channel']['totalClaimed'] == '2000', state
    results.append({'consent':'signed' if signed_refund else 'delegated', 'channelId':channel_id, 'chargeCount':1, 'cancelReleased':True,'refundSucceeded':True,'correctiveProofPreserved':True,'replayDidNotCharge':True,'earlyHookAbortReleased':True,'buyerRecovered':True})
    remote.close()
control.close()
print(json.dumps({'result':'managed-custody-passed','scenarios':results}, separators=(',',':')))
