# Go cooperative-close payout accounting — #3919

Synthetic evidence for [#3919](https://github.com/x402-foundation/x402/issues/3919), separate from the implementation diff.

- Investigated upstream: [`4241d56cae2f`](https://github.com/x402-foundation/x402/commit/4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54).
- Final signed implementation: [`ec95e3d91ba3`](https://github.com/AkshatGada/x402/commit/ec95e3d91ba384908445a889319d3129d1fdfba8).
- TypeScript reference: merged [#3606](https://github.com/x402-foundation/x402/pull/3606).
- [Complete implementation diff](implementation.patch), [attribution correction](correction.patch), [machine-readable results](results.json).

## Verified problem

Go's public settlement lifecycle confirms a cooperative seal/refund but upstream never calls the configured merchant-payout accounting hook. A saved-result replay also skips it. Submission, confirmation and transaction metadata below are synthetic; no Solana program, live RPC, transactions or funds were used.

| Close | Merchant payout | Outward amount | Upstream callbacks | Fixed callbacks |
|---|---:|---:|---:|---:|
| Seal | 2500 | 2500 | 0 | 1 |
| Refund | 2500 | 7000 | 0 | 1 |

The [original public-lifecycle probes](logs/baseline-probe.log) and [fixed probes](logs/fixed-probe.log) record one submission per flow. These historical probes use the initial implementation; the final implementation adds confirmed-metadata attribution and broader tests below.

The baseline-compatible accounting suite uses the same original test sources on upstream and the initial implementation: upstream has 18 regression failures, four passing accounting/authentication controls, and seven passing existing controls. The final suite expands to **54 passing cases**. Baseline and final case counts differ deliberately; this is not a claim that all 54 tests compile against upstream.

## Sweep/refund attribution regression

An ordinary sweep can pay the merchant after the refund's initial channel read. The refund transaction then pays only the remainder. A pre-submit channel snapshot overstates that transaction's payout.

| Step | Actual modeled merchant payout | Initial implementation ledger | Corrected ledger |
|---|---:|---:|---:|
| Sweep | 500 | 500 | 500 |
| Refund | 2000 | 2500 | 2000 |
| Total | 2500 | 3000 | 2500 |

The outward payer refund remains 7000. This reproduces an accounting error, not an onchain overpayment. Both public SDK flows use distinct mocked signatures. The [identical standalone regression](harness/sweep_refund_regression_test.go) fails on `4c444151` and passes on `ec95e3d9`: [baseline output](logs/payout-baseline.log), [fixed output](logs/payout-fixed.log). Test SHA256: `8f7b8d9ce1e90e32e113b1f620a02dab05e2ef4e19af7474c1c710be00fd3485`.

## Final checks and reviews

With Go 1.24.13, cached locked dependencies and at most two jobs:

- [Focused suite](logs/fixed-focused.log): 54 cases pass. Includes authentication expiry, missing/ambiguous metadata, attribution persistence faults, callback/marker failures, legacy results, metadata pruning, zero payouts, and concurrent readers/writers/waiters.
- `go test -p=2 -count=1 -race -cover ./mechanisms/svm/batch-settlement/...`: four packages pass; facilitator coverage 76.6%. [Output](logs/fixed-batch-race.log).
- `golangci-lint run --concurrency=2 ./mechanisms/svm/batch-settlement/...`: v2.7.2, zero issues. [Output](logs/lint.log).
- `go build -p=2 ./mechanisms/svm/batch-settlement/...`: success. [Empty output](logs/build.log).
- Changed-file `goimports` and `git diff --check`: clean. Full Go SDK suite not run.

The [final review](reviews/final-review.txt) verified the repaired stale-reader and late-writer races. A [fresh review](reviews/fresh-review.txt) independently traced the complete change and passed all 54 focused cases: [output](logs/fresh-review-focused.log). Broader race/lint/build logs were inspected by those reviews, not independently rerun by each reviewer. Reports describe the pre-commit frozen source, which exactly matches the signed correction.

## Reproduce

Use a clean checkout at the final implementation commit with Go and dependencies already available. From this evidence branch:

```sh
python3 harness/run.py baseline /path/to/implementation
python3 harness/run.py fixed /path/to/implementation
python3 harness/run.py payout-baseline /path/to/implementation
python3 harness/run.py payout-fixed /path/to/implementation
python3 harness/run.py race /path/to/implementation
```

`baseline` intentionally exits 1 with assertion failures. `payout-baseline` intentionally exits 1 for the overcount. The fixed modes exit 0. The original baseline mode overlays upstream production and the baseline-compatible original test sources; payout modes use identical standalone regression source. Both macOS path aliases are handled. No files in the implementation checkout are overwritten. Downloads are disabled; existing cache environment variables are preserved. `--go` selects an installed Go binary.

## Recovery limits and remaining validation

Recovery begins after a close response is durably saved. The existing earlier broadcast-completion/first-result-save crash window remains. Ledger callbacks must atomically deduplicate by `(network, transaction)` across failures and replicas. Coalescing is process-local and requires the same store object. Already-recorded legacy ledger entries are not reconciled automatically.

A zero-payout fixture includes an existing recipient token account. Whether the deployed canonical program permits a successful zero-payout close with that account absent remains unverified; synthetic SDK tests do not establish it. Missing recipient post-balance metadata currently returns pending. No deployed-program or full SDK validation is claimed.

Logs and review reports are sanitized to remove machine paths; diagnostics and outcomes are retained. `SHA256SUMS` covers all current evidence files except itself. Earlier evidence commits are historical and do not describe the final implementation.
