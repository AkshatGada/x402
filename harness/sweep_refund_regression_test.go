package facilitator

import (
	"context"
	"math/big"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestSweepRefundPayoutAttribution(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	payer := mustKey(t)
	feePayer := mustKey(t)
	authorizer := mustKey(t)
	salt := uint64(0)
	binding := batchsettlement.EncodeReceiverBindingMemo(authorizer.PublicKey().String())
	open, err := paymentchannels.BuildOpenTransaction(paymentchannels.BuildOpenArgs{
		Payer:            payer.PublicKey(),
		Payee:            feePayer.PublicKey(),
		Mint:             solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
		AuthorizedSigner: payer.PublicKey(),
		FeePayer:         feePayer.PublicKey(),
		TokenProgram:     solana.MustPublicKeyFromBase58(svm.TokenProgramAddress),
		Deposit:          10_000,
		Blockhash:        solana.Hash(solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress)),
		OpenSlot:         1,
		GracePeriod:      900,
		Recipients:       []paymentchannels.Split{{Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS}},
		Salt:             &salt,
		BindingMemo:      &binding,
	})
	require.NoError(t, err)
	channelID := open.ChannelID.String()
	config := batchsettlement.BatchChannelConfig{
		OpenSlot:           1,
		Payer:              payer.PublicKey().String(),
		PayerAuthorizer:    payer.PublicKey().String(),
		Receiver:           svm.USDCMainnetAddress,
		ReceiverAuthorizer: authorizer.PublicKey().String(),
		Salt:               "0",
		Token:              svm.USDCDevnetAddress,
		WithdrawDelay:      900,
	}
	requirements := types.PaymentRequirements{
		Amount: "1000",
		Asset:  svm.USDCDevnetAddress,
		Extra: map[string]any{
			"feePayer":           feePayer.PublicKey().String(),
			"receiverAuthorizer": authorizer.PublicKey().String(),
			"tokenProgram":       svm.TokenProgramAddress,
			"withdrawDelay":      900,
		},
		MaxTimeoutSeconds: 300,
		Network:           network,
		PayTo:             svm.USDCMainnetAddress,
		Scheme:            batchsettlement.Scheme,
	}
	hash, err := paymentchannels.GetChannelDistributionHash([]paymentchannels.Split{{
		Recipient: svm.USDCMainnetAddress, BPS: batchsettlement.FullSplitBPS,
	}})
	require.NoError(t, err)
	live := func(overrides func(*generated.Channel)) *generated.Channel {
		channel := &generated.Channel{
			Discriminator:    uint8(generated.AccountDiscriminator_Channel),
			Bump:             1,
			Version:          1,
			Status:           uint8(generated.ChannelStatus_Closing),
			Salt:             0,
			Deposit:          10_000,
			Settlement:       generated.SettlementWatermarks{Settled: 1_000, PayoutWatermark: 500},
			ClosureStartedAt: sealNow - 60,
			GracePeriod:      900,
			DistributionHash: hash,
			Payer:            payer.PublicKey(),
			Payee:            feePayer.PublicKey(),
			AuthorizedSigner: payer.PublicKey(),
			Mint:             solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
			RentPayer:        feePayer.PublicKey(),
			OpenSlot:         1,
		}
		if overrides != nil {
			overrides(channel)
		}
		return channel
	}
	signature := solana.Signature{7}.String()
	type sealFixture struct {
		signer      *capabilitySigner
		transaction *svm.FacilitatorConfirmedTransaction
		scheme      *BatchSvmScheme
		storage     *activityRecordingStorage
		submits     []submitCall
	}
	facilitator := func(t *testing.T, channel *generated.Channel, bound bool, configs ...Config) *sealFixture {
		t.Helper()
		if channel == nil {
			channel = live(nil)
		}
		storage := newActivityRecordingStorage()
		if bound {
			_, err := storage.RecordOpen(context.Background(), paymentchannels.PaymentChannelRecord{
				Network: network, ChannelID: channelID, ReceiverAuthorizer: authorizer.PublicKey().String(), LastActivityAt: time.Now(),
			})
			require.NoError(t, err)
		}
		fixture := &sealFixture{storage: storage}
		cfg := Config{}
		if len(configs) != 0 {
			cfg = configs[0]
		}
		cfg.ChannelStorage = storage
		paid := uint64(0)
		if channel.Settlement.PayoutWatermark < 3_000 {
			paid = 3_000 - channel.Settlement.PayoutWatermark
		}
		fixture.transaction = lifecyclePayoutEvidence(t, channelID, requirements.PayTo, requirements.Asset, "100", uintString(100+paid))
		fixture.transaction.Meta.PreTokenBalances[1].UITokenAmount.Amount = uintString(channel.Deposit - channel.Settlement.PayoutWatermark)
		fixture.transaction.Meta.PostTokenBalances = fixture.transaction.Meta.PostTokenBalances[:1]
		fixture.signer = &capabilitySigner{scriptedSigner: newScriptedSigner(t, 1), confirmed: func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error) {
			return fixture.transaction, nil
		}}
		scheme := NewBatchSvmScheme(context.Background(), fixture.signer, &cfg)
		scheme.hooks.waitForChannelRead = func(int) error { return nil }
		terms := BatchTerms{
			FeePayer:           feePayer.PublicKey().String(),
			ReceiverAuthorizer: authorizer.PublicKey().String(),
			TokenProgram:       svm.TokenProgramAddress,
			VoucherSigner:      batchsettlement.VoucherSignerClient,
			WithdrawDelay:      900,
		}
		scheme.hooks.resolveTerms = func(context.Context, batchsettlement.BatchChannelConfig, types.PaymentRequirements, VoucherModeBinding) (BatchTerms, error) {
			return terms, nil
		}
		scheme.hooks.deriveChannelID = func(context.Context, batchsettlement.BatchChannelConfig, string) (string, error) {
			return channelID, nil
		}
		scheme.hooks.fetchChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return channel, nil
		}
		scheme.hooks.readChannel = func(context.Context, string, string) (*generated.Channel, error) {
			return nil, nil
		}
		scheme.hooks.distributeInstruction = func(context.Context, string, *generated.Channel, BatchTerms, types.PaymentRequirements) (solana.Instruction, error) {
			return solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress), nil, []byte{9}), nil
		}
		scheme.hooks.submitRedemption = func(_ context.Context, fee, net string, instructions []solana.Instruction, key, payer string) (durableResult, error) {
			fixture.submits = append(fixture.submits, submitCall{fee, net, instructions, key, payer})
			return durableResult{OK: true, Signature: signature}, nil
		}
		scheme.hooks.sealDependencies = func() SealDependencies {
			deps := scheme.defaultSealDependencies()
			deps.NowSeconds = func() int64 { return sealNow }
			return deps
		}
		fixture.scheme = scheme
		return fixture
	}
	sealPayload := func(t *testing.T, cumulative uint64) batchsettlement.BatchSealPayload {
		t.Helper()
		voucherSig, err := paymentchannels.SignVoucher(context.Background(), ed25519Signer{payer}, open.ChannelID, cumulative, batchsettlement.ClientVoucherExpiresAt)
		require.NoError(t, err)
		closeAuth, err := batchsettlement.SignCloseAuthorization(context.Background(), ed25519Signer{authorizer}, batchsettlement.CloseAuthorizationBinding{
			Network:            network,
			FeePayer:           feePayer.PublicKey().String(),
			ChannelID:          channelID,
			MaxClaimableAmount: new(big.Int).SetUint64(cumulative),
			VoucherExpiresAt:   batchsettlement.ClientVoucherExpiresAt,
			ValidBefore:        sealNow + 120,
		})
		require.NoError(t, err)
		return batchsettlement.BatchSealPayload{
			Type:               batchsettlement.PayloadTypeSeal,
			ChannelID:          channelID,
			ChannelConfig:      config,
			Voucher:            batchsettlement.BatchVoucher{ChannelID: channelID, MaxClaimableAmount: uintString(cumulative), ExpiresAt: 0, Signature: voucherSig},
			CloseAuthorization: &closeAuth,
		}
	}
	settle := func(t *testing.T, scheme *BatchSvmScheme, payload any) *x402.SettleResponse {
		t.Helper()
		response, err := scheme.Settle(context.Background(), types.PaymentPayload{
			X402Version: 2,
			Accepted:    requirements,
			Payload:     asMap(t, payload),
		}, requirements, nil)
		require.NoError(t, err)
		return response
	}

	t.Run("accounts only the refund payout after an intervening sweep", func(t *testing.T) {
		program := live(func(ch *generated.Channel) { ch.Status = uint8(generated.ChannelStatus_Open); ch.ClosureStartedAt = 0 })
		snapshot := *program
		var ledgerPaid uint64
		var signatures []string
		cfg := Config{OnDistributionConfirmed: func(_ context.Context, response *x402.SettleResponse, _ types.PaymentRequirements) error {
			ledgerPaid += mustParseU64(t, response.Amount)
			signatures = append(signatures, response.Transaction)
			return nil
		}}
		refund := facilitator(t, &snapshot, true, cfg)
		sweep := facilitator(t, program, true, cfg)
		sweepSignature := solana.Signature{8}.String()
		sweep.transaction = lifecyclePayoutEvidence(t, channelID, requirements.PayTo, requirements.Asset, "100", "600")
		submitSweep := sweep.scheme.hooks.submitRedemption
		sweep.scheme.hooks.submitRedemption = func(ctx context.Context, fee, net string, instructions []solana.Instruction, key, payer string) (durableResult, error) {
			result, err := submitSweep(ctx, fee, net, instructions, key, payer)
			result.Signature = sweepSignature
			return result, err
		}
		submitRefund := refund.scheme.hooks.submitRedemption
		refund.scheme.hooks.submitRedemption = func(ctx context.Context, fee, net string, instructions []solana.Instruction, key, payer string) (durableResult, error) {
			// Run the public sweep flow after the refund reads its channel snapshot.
			// Program transitions and confirmed token balances are synthetic.
			response := settle(t, sweep.scheme, batchsettlement.BatchSettlePayload{
				Type:     batchsettlement.PayloadTypeSettle,
				Channels: []batchsettlement.BatchSettleChannel{{ChannelID: channelID, ChannelConfig: config}},
			})
			require.True(t, response.Success)
			require.Equal(t, "500", response.Amount)
			program.Settlement.PayoutWatermark = program.Settlement.Settled
			merchantPaid := uint64(3_000) - program.Settlement.PayoutWatermark
			refund.transaction = lifecyclePayoutEvidence(t, channelID, requirements.PayTo, requirements.Asset, "600", uintString(600+merchantPaid))
			refund.transaction.Meta.PostTokenBalances = refund.transaction.Meta.PostTokenBalances[:1]
			return submitRefund(ctx, fee, net, instructions, key, payer)
		}
		voucher := sealPayload(t, 3_000)
		response := settle(t, refund.scheme, batchsettlement.BatchRefundPayload{
			Type: batchsettlement.PayloadTypeRefund, ChannelConfig: config,
			Voucher: &voucher.Voucher, CloseAuthorization: voucher.CloseAuthorization,
		})
		require.True(t, response.Success)
		assert.Equal(t, "7000", response.Amount)
		assert.Equal(t, "2000", response.Extra["paidToReceiver"])
		assert.Equal(t, uint64(2_500), ledgerPaid, "500 sweep plus 2000 refund payout")
		assert.Equal(t, []string{sweepSignature, signature}, signatures)
		assert.Len(t, sweep.submits, 1)
		assert.Len(t, refund.submits, 1)
		again := settle(t, refund.scheme, batchsettlement.BatchRefundPayload{
			Type: batchsettlement.PayloadTypeRefund, ChannelConfig: config,
			Voucher: &voucher.Voucher, CloseAuthorization: voucher.CloseAuthorization,
		})
		assert.True(t, again.Success)
		assert.Equal(t, "2000", again.Extra["paidToReceiver"])
		assert.Equal(t, uint64(2_500), ledgerPaid)
		assert.Len(t, refund.submits, 1)
	})

}
