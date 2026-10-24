package facilitator

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"sync/atomic"
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

func TestConcurrentCloseInitialResultWrite(t *testing.T) {
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
	channel := live(func(ch *generated.Channel) { ch.Status = uint8(generated.ChannelStatus_Open); ch.ClosureStartedAt = 0 })
	voucher := sealPayload(t, 3_000)
	payload := batchsettlement.BatchRefundPayload{
		Type: batchsettlement.PayloadTypeRefund, ChannelConfig: config,
		Voucher: &voucher.Voucher, CloseAuthorization: voucher.CloseAuthorization,
	}
	key := fmt.Sprintf("batch:refund:%s:%s:3000", network, channelID)
	store := &auditGatedInitialWriteStore{PendingSettlementStore: NewInMemoryPendingSettlementStore(), key: key + ":result", closeKey: key + ":close", captured: make(chan struct{}), release: make(chan struct{})}
	var calls atomic.Int32
	cfg := Config{PendingSettlementStore: store, OnDistributionConfirmed: func(_ context.Context, response *x402.SettleResponse, _ types.PaymentRequirements) error {
		calls.Add(1)
		assert.Equal(t, "2000", response.Amount)
		return nil
	}}
	owner, delayed := facilitator(t, channel, true, cfg), facilitator(t, channel, true, cfg)
	for _, fixture := range []*sealFixture{owner, delayed} {
		fixture.transaction = lifecyclePayoutEvidence(t, channelID, requirements.PayTo, requirements.Asset, "600", "2600")
		fixture.transaction.Meta.PostTokenBalances = fixture.transaction.Meta.PostTokenBalances[:1]
	}
	ownerReady, ownerRelease := make(chan struct{}), make(chan struct{})
	submitOwner := owner.scheme.hooks.submitRedemption
	owner.scheme.hooks.submitRedemption = func(ctx context.Context, fee, net string, instructions []solana.Instruction, operation, payer string) (durableResult, error) {
		// Both callers have read their pre-submit channel snapshots before either
		// returns from confirmation. The second returns the same broadcast result.
		close(ownerReady)
		select {
		case <-ownerRelease:
		case <-ctx.Done():
			return durableResult{}, ctx.Err()
		}
		return submitOwner(ctx, fee, net, instructions, operation, payer)
	}
	submitDelayed := delayed.scheme.hooks.submitRedemption
	delayed.scheme.hooks.submitRedemption = func(ctx context.Context, fee, net string, instructions []solana.Instruction, operation, payer string) (durableResult, error) {
		result, err := submitDelayed(ctx, fee, net, instructions, operation, payer)
		result.Replayed = true
		return result, err
	}
	payment := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: asMap(t, payload)}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type outcome struct {
		response *x402.SettleResponse
		err      error
	}
	ownerDone, delayedDone := make(chan outcome, 1), make(chan outcome, 1)
	go func() {
		response, err := owner.scheme.Settle(ctx, payment, requirements, nil)
		ownerDone <- outcome{response, err}
	}()
	select {
	case <-ownerReady:
	case <-ctx.Done():
		t.Fatal("owner did not read its channel snapshot")
	}
	go func() {
		response, err := delayed.scheme.Settle(ctx, payment, requirements, nil)
		delayedDone <- outcome{response, err}
	}()
	select {
	case <-store.captured:
	case <-ctx.Done():
		t.Fatal("delayed caller did not pause before initial result write")
	}
	close(ownerRelease)
	select {
	case complete := <-ownerDone:
		require.NoError(t, complete.err)
		require.True(t, complete.response.Success)
		require.Equal(t, "2000", complete.response.Extra["paidToReceiver"])
	case <-ctx.Done():
		t.Fatal("owner did not complete accounting")
	}
	require.Equal(t, int32(1), calls.Load())
	close(store.release)
	select {
	case late := <-delayedDone:
		require.NoError(t, late.err)
		require.True(t, late.response.Success)
		assert.Equal(t, "7000", late.response.Amount)
		assert.Equal(t, "2000", late.response.Extra["paidToReceiver"], "a late initial write must not discard transaction-attributed payout")
	case <-ctx.Done():
		t.Fatal("delayed initial writer did not finish")
	}
	cached, ok, err := store.Get(ctx, key+":payout")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, "2000", cached)
	raw, ok, err := store.Get(ctx, key+":result")
	require.NoError(t, err)
	require.True(t, ok)
	var persisted x402.SettleResponse
	require.NoError(t, json.Unmarshal([]byte(raw), &persisted))
	assert.Equal(t, "2000", persisted.Extra["paidToReceiver"], "recorded result must preserve verified payout")
	assert.Equal(t, int32(1), calls.Load())
}

type auditGatedInitialWriteStore struct {
	PendingSettlementStore
	key      string
	paused   atomic.Bool
	captured chan struct{}
	release  chan struct{}
	closeKey string
}

func (s *auditGatedInitialWriteStore) Set(ctx context.Context, key, value string) error {
	if (key == s.key || key == s.closeKey) && s.paused.CompareAndSwap(false, true) {
		close(s.captured)
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return s.PendingSettlementStore.Set(ctx, key, value)
}
