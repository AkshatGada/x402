# SVM pending-batch recovery evidence

Synthetic reproduction of a distribution accounting gap when a redemption worker changes the channels in a pending batch. No live RPC, real funds, credentials or onchain experiment is involved.

- Baseline: [`4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54`](https://github.com/x402-foundation/x402/commit/4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54)
- Fix: `b751b8d7dd2c28ce61f795612d1410c754f38a84` (prepared locally; the fork link becomes available after an approved push)
- Reviewed source: [source-snapshot.json](source-snapshot.json), including all 14 file hashes and the full diff hash

## Reproduction

The facilitator identifies pending distributions by the exact sorted channel set. Original `[A]` is pending. Before the next pass, confirmation becomes visible and newly payable `B` joins. Baseline submits `[A,B]`, which misses the original pending key. Its transaction pays only B. Local payout watermark reconciliation leaves no further work, while A's original transaction remains unaccounted.

| Outcome | Baseline | Fix |
| --- | --- | --- |
| Stable `[A]` control | Recovers 800 | Recovers 800 |
| Original 800-unit transaction when B joins | Callback missing; pending key remains | Accounted; pending key cleared |
| New B payout | Accounts 1,000 | Accounts 1,000 after original recovery |
| New replacement transaction for A | None demonstrated | None |
| Focused TS/Go regression exits | 1 / 1 (expected assertion failures) | 0 / 0 |

The tests exercise actual manager and facilitator distribution/accounting logic. Confirmation, submission, channel reads and transaction metadata are synthetic. Metadata is selected by the queried transaction signature and includes the expected recipient and escrow token balances: original recipient 200→1,000; new recipient 1,000→2,000. This establishes an accounting/recovery defect, not live-chain fund loss or a double payout.

## Run the same regression against both implementations

Use the prepared fix checkout with its existing Node dependencies and Go module cache. The runner never installs, fetches, checks out another revision or overwrites tracked source. It verifies the reviewed source hashes, then substitutes only the pinned baseline manager through a Go overlay and temporary Vite plugin. Both versions run the same current tests. Generated config files are removed afterwards. Test execution is sequential, with at most two jobs.

```sh
python3 /path/to/this/evidence/reproduce.py \
  --checkout /path/to/prepared/fix-checkout \
  --out /path/to/new-output-directory
```

`node` and a compatible `go` must already be on `PATH`. Set `GOMODCACHE`/`GOCACHE` if using an isolated prepared cache. Go downloads and automatic toolchain downloads are disabled. The runner returns success only if baseline fails at the expected assertion and the fix passes, writing the actual test exits to `run-statuses.json`. Missing dependencies or setup failures are not reproductions. The test fixture source is in the fix commit; no replacement facilitator implementation is used.

## Validation

- TS: 54 SVM unit test files, 1,061 tests passed. ESM/CJS builds, declarations, scoped ESLint and formatting passed.
- Go: four SVM batch-settlement packages passed `go test -count=1 -race -cover ./mechanisms/svm/batch-settlement/...`; server coverage 80.3%. Scoped build, pinned golangci-lint (0 issues) and goimports passed.
- Independent rerun: both TS/Go baseline and fix regressions plus all 1,061 TS unit tests. Other build/lint/Go race outputs were inspected. The Go race suite was also rerun after review.
- Full-repository tests and TS coverage thresholds were not run. These logs concern the scoped SDK checks only.

The portable runner was itself validated against both versions: [its logs and actual exit statuses](logs/portable/). See [results.json](results.json), [raw outcome logs](logs/) and [independent rerun logs](logs/independent/). Workspace/runtime prefixes are normalized to placeholders; assertion text and outcomes are preserved. Empty build output is retained honestly, with its successful process exit recorded in the results manifest.

## Recovery contract and remaining limits

The fix saves original batch membership, channel configuration and requirements in an explicit distribution journal before sending. It recovers retained jobs before new grouping, fencing those members for the pass while unrelated payouts continue. Success retires the job despite partial local watermark failures, before application notifications. Journal failures do not prevent time-critical claim/seal attempts.

The existing channel store permits weak listing, so channel rows alone cannot reliably enumerate pending jobs. The separate journal requires complete enumeration, immutable generation IDs and persist-before-send. Its default is memory-only per manager. Durable restart recovery requires an application-supplied durable journal plus durable channel and facilitator pending stores. Only one active redemption owner per journal/scope is supported. No durable backend or distributed lease is added.

No protocol, wire or channel-program change is made. Pre-upgrade orphaned transactions are not discovered. Permanently ambiguous accounting, malformed records or incompatible scope rotation can require operator reconciliation. Callbacks are best effort; facilitator accounting must deduplicate by network/transaction. The new SDK storage API still needs normal maintainer review.
