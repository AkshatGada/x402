# Go cooperative-close payout accounting — issue #3919

Synthetic evidence for [#3919](https://github.com/x402-foundation/x402/issues/3919), separate from the implementation diff.

- Investigated upstream: [`4241d56cae2f`](https://github.com/x402-foundation/x402/commit/4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54).
- Signed implementation: [`4c444151ba0d`](https://github.com/AkshatGada/x402/commit/4c444151ba0defa92c66d8fcab378d4484c2ea08), branch `codex/go-svm-close-accounting`.
- Reference behavior: merged TypeScript [#3606](https://github.com/x402-foundation/x402/pull/3606).
- AI-assisted implementation and two independent AI reviews. The second reviewer reran the original 20 accounting cases; two expiry cases were added and checked afterward.

## Reproduction

Go's public `scheme.Settle` close lifecycle returns success but upstream never invokes the configured payout-accounting callback. Submission and confirmation are mocked; these are local synthetic unit results, not observed token transfers. No RPC, live transactions, funds, or production credentials were used.

| Close | Merchant payout | Outward amount | Baseline callbacks | Fixed callbacks | Submission count in each run |
|---|---:|---:|---:|---:|---:|
| Seal | 2500 | 2500 | 0 | 1 | 1 |
| Cooperative refund | 2500 | 7000 | 0 | 1 | 1 |

Saved-result replay leaves the fixed callback count at one and does not submit again. See [baseline probe](logs/baseline-probe.log) and [fixed probe](logs/fixed-probe.log).

## Identical regression tests

| Cases | Upstream production files | Fixed production files |
|---|---:|---:|
| Existing close controls | 7 pass | 7 pass |
| Accounting/recovery/authentication | 18 fail, 4 pass | 22 pass |

The saved-result authorization-expiry cases pass on both versions. They preserve an existing authentication rule, rather than establish another bug. They reject at `now == validBefore`, leave the saved result unchanged, write no recorded marker, call no accounting hook, and submit no transaction.

Other cases cover exact merchant/refund amounts, zero payouts, callback and marker read/write faults, fresh-instance recovery with the closed channel absent, legacy records, nil hooks, callback mutation of scalar Amount, overlapping owner/waiter success and failure, and canceled waiters. See [baseline log](logs/baseline.log) and [fixed log](logs/fixed-focused.log).

## Validation and reproduction commands

Recorded with Go 1.24.13 and golangci-lint v2.7.2, using existing locked dependencies and at most two jobs:

- `go test -p=2 -count=1 -race -cover ./mechanisms/svm/batch-settlement/...`: four packages pass; facilitator coverage 76.3%. [Log](logs/fixed-batch-race.log).
- `golangci-lint run --concurrency=2 ./mechanisms/svm/batch-settlement/...`: zero issues. [Log](logs/lint.log).
- `go build -p=2 ./mechanisms/svm/batch-settlement/...`: success; [empty output log](logs/build.log).
- Changed-file `goimports` and `git diff --check`: clean.
- Full Go SDK suite: not run. Existing loopback `httptest` listeners required sandbox permission for the race suite.

With the implementation commit checked out cleanly and Go/dependencies already available, run from this evidence branch:

```sh
python3 harness/run.py baseline /path/to/implementation
python3 harness/run.py fixed /path/to/implementation
python3 harness/run.py race /path/to/implementation
```

Baseline intentionally exits 1 with the 18 regression failures. Fixed/race exit 0. The harness overlays only four production files from the pinned upstream commit, leaving the tests identical and the checkout unchanged. Both macOS path aliases are included. It disables toolchain/dependency downloads and preserves caller-supplied cache locations; use `--go` to select an existing Go binary. No installation is performed.

## Recovery limits

Accounting recovery begins after the close `:result` is saved. The existing earlier broadcast-completion/result-write crash window remains. Callbacks must atomically deduplicate ledger writes by `(network, transaction)`; same-process coalescing requires the same store object and gives no cross-process exactly-once guarantee. Replay still requires valid authentication and recoverable receiver binding. Older unrecorded refunds without `paidToReceiver` need external reconciliation.

[Design/diff review](reviews/design-and-diff-review.txt) and [second independent review](reviews/independent-review.txt) found no introduced blocking defect within this scope. The second review's rerun was not captured in a separate raw log; it is reported as reviewer testimony, not an additional recorded run.

Local paths in logs were replaced with placeholders. Test diagnostics and outcomes were retained. `SHA256SUMS` records file hashes.
