# SVM pending-settlement store read-failure recovery

Baseline: [`4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54`](https://github.com/x402-foundation/x402/commit/4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54).
Fix: [`1074daf60c3d5bf1d7f38a090299e8bfa7a93f32`](https://github.com/AkshatGada/x402/commit/1074daf60c3d5bf1d7f38a090299e8bfa7a93f32).

This evidence branch contains only documentation, test evidence and a regression-test patch. The fix is on `codex/svm-pending-store-recovery`. Both branches are currently local; GitHub links become available only after an authorized push.

## Reproduced problem

A failing shared-store read must not be treated as a missing pending transaction. Go exact and upto ignored `Get` errors, permitting new settlement work or consuming a partial result. TypeScript exact propagated the error but retained a newly acquired duplicate entry, blocking a healthy retry for up to its 120-second TTL.

The fix propagates Go errors before recovery/new settlement and handles the error at both upto callers. TypeScript catches only the lookup failure, releases its newly acquired entry, and preserves an existing owner's entry. It does not remove pending records or add an automatic retry policy.

## Independent results

| Check | Baseline | Fix |
| --- | --- | --- |
| Go exact/upto lookup-error regressions | Seven leaf cases fail | Seven pass |
| TS pending-settlement suite | 1 fails, 14 pass | 15 pass |
| Complete Go exact/upto facilitator race tests | Not rerun on baseline | Both packages pass |

The TS failure is the immediate retry after an initial lookup outage. Its other new cases protect pending-signature recovery and concurrent ownership: request A pauses in its lookup, duplicate B's lookup fails, request C must still be rejected as a duplicate, and A eventually sends once. These controls pass on baseline as well as the fix.

Go tests cover error precedence over partial results, existing pending locks, preservation of stored signatures and recovery after reads resume. Both upto deposit and claim tests call public `Settle`. Exact tests count simulation/sign/send/confirm calls; upto tests count simulation/broadcast and pending writes/deletes.

A fresh Astra high reviewer independently reran the five `audit-*` checks and verified source/test hashes. See [the audit](independent-final-audit.txt). Earlier design review: [design-audit.txt](design-audit.txt). Codex implemented the fix and initial validation; Astra high audited the design, diff and evidence.

## Other checks and limits

- Full TS SVM suite: 54 files, 1,030 tests pass.
- Go SVM suite: all 15 tested packages pass; generated package has no tests.
- Scoped Go lint/build and changed TS source/test lint pass.
- TS SVM ESM/CJS/declaration build and declaration mirroring pass.
- `tsc --noEmit` reports five identical diagnostics on baseline/fix: two in unchanged `signatureVerification.ts`, three in unchanged `index.test.ts`. This is not a clean typecheck claim.
- goimports/Prettier and Git whitespace checks pass.

Only synthetic fixtures, ephemeral test signing keys and loopback mock RPC were used. No production credentials, real-user keys, funded wallets or live chain calls. This establishes incorrect control flow and retry blockage, not an actual double charge. Tests use cached dependencies/core outputs; Go 1.24.13 and at most two workers. No full repository build/test claim. Default memory stores do not fail reads; the affected configuration is a custom/shared store that can fail. Distributed locking and TTL-generation ownership remain outside scope.

## Reproduce

Use separate checkouts of the baseline and fix, with the repository's dependencies already available. This evidence does not run installations. Apply `regression-tests.patch` only to the baseline checkout; it supplies the same three test files already present in the fix.

From each checkout's `go/` directory:

```sh
GOMAXPROCS=2 go test -p=2 -count=1 -v -run PendingStoreReadError ./mechanisms/svm/exact/facilitator ./mechanisms/svm/upto/facilitator
```

From each checkout's `typescript/packages/mechanisms/svm/` directory:

```sh
pnpm exec vitest run test/unit/pendingSettlement.test.ts --coverage.enabled=false --maxWorkers=2 --minWorkers=1 --no-file-parallelism
```

The baseline commands intentionally exit 1; the fix exits 0. Go tests require permission to bind a loopback HTTP server. For the fixed Go packages, run `GOMAXPROCS=2 go test -p=2 -race -count=1 ./mechanisms/svm/exact/facilitator ./mechanisms/svm/upto/facilitator`.

Each log has matching JSON command/exit metadata. Local checkout/cache paths are replaced with descriptive placeholders and ANSI colour codes removed; assertions and results are preserved. `source-manifest.json` hashes the exact three production and three test files and the original six-file implementation diff; `source-commit.json` identifies the signed eight-file source commit including changelogs. `SHA256SUMS` covers these sanitized evidence files.
