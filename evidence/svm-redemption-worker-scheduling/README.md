# SVM redemption-worker scheduling evidence

- Baseline: [`cb0e0487e252f42114225c5a25abdd6968a0d0db`](https://github.com/x402-foundation/x402/commit/cb0e0487e252f42114225c5a25abdd6968a0d0db)
- Implementation: [`4706be4da705e5bcc8a0cd5c2467be2abe9ccf0b`](https://github.com/AkshatGada/x402/commit/4706be4da705e5bcc8a0cd5c2467be2abe9ccf0b)
- Investigated and tested: 27 October 2026
- Status: prepared locally; the implementation link becomes available after an approved push.

## Problem and scope

A slow TypeScript SVM redemption pass lets every interval callback append another pass to the serial queue. Clearing the interval stops future callbacks but drains those historical automatic passes. The fix skips ticks while one automatic job is queued or running, invalidates obsolete queued timer work on stop/restart, and preserves each explicit manual redemption and final flush request. A pass that has entered `runPass` finishes normally. Each stop waits its captured queue boundary, not later work from a restarted interval or manual caller.

This is worker scheduling and shutdown hardening. The evidence establishes redundant work and stop/restart behavior, not duplicate payments, lost funds, production frequency, chain correctness or performance gains. The same SDK's rent-cleanup worker already skips outstanding automatic ticks. The protocol leaves scheduling topology to implementations.

## Baseline versus fix

The focused test bytes are identical in both trees and match `tests/batch.channelManager.scheduling.test.ts`. The baseline manager was checked against the pinned Git blob; the fixed source and test match the signed implementation commit. The second reviewer also compared 206 tracked source, test and configuration files across the snapshots: only the manager differs, with the same new focused test in both.

| Run | Baseline | Fix |
| --- | --- | --- |
| Implementation validation | 5 expected failures, 6 controls pass | 11 pass |
| First independent final review | 5 expected failures, 6 controls pass | 11 pass |
| Second independent final review | 5 expected failures, 6 controls pass | 11 pass |

Five ticks during a blocked empty-store pass cause **ten reads** on baseline, versus **two reads** with the fix. A final flush causes twelve baseline reads versus four fixed reads. Other baseline failures exercise obsolete automatic work after stop, old queued work after restart, and an old flush waiting for a newer interval's blocked pass. Manual-call and lifecycle controls remain passing. All reads and clocks are synthetic; an empty store submits no payment.

The second reviewer also ran three scratch cases: stopping after timer admission but before its first promise microtask; synchronous stop/restart from `onError`; and a rejected flush whose `onError` queues later blocked manual work. All three passed. These supplement the committed regression tests; they are not additional production code.

## Broader validation and limits

- Full SVM unit suite: **1,115 passed**, 58 result files, coverage disabled. Nested describe-suite totals are not file counts.
- Scoped Core dependency and SVM builds: ESM, CJS, declarations and declaration mirroring passed. ESM/declaration work and CJS were sequenced to keep at most two build jobs active.
- Changed source/test lint, source/test/changeset formatting and `git diff --check` passed.
- Normal package `tsc --noEmit` reports **five pre-existing diagnostics**, byte-identical baseline/fix: `signatureVerification.ts:56,85`; duplicate imports at `index.test.ts:12,23`; signer mismatch at `index.test.ts:212`.
- Supplemental compilation including the new scheduler test reports **two pre-existing signatureVerification.ts diagnostics**, also byte-identical baseline/fix. Neither compiler command is green; neither reports a new scheduler/test diagnostic.
- Tests ran sequentially at one or two configured workers. No full repository build, live integration suite, coverage-threshold claim, RPC, transaction submission or real funds.
- An isolated, approved dependency setup used the unchanged repository lockfile versions. Install scripts were disabled. No new production dependency or repository manifest/lockfile change.

## Reproduce with prepared disposable checkouts

Prepare baseline and implementation checkouts at the commits above, with the repository's locked SVM/Core dependencies already installed and Core built. Copy `tests/batch.channelManager.scheduling.test.ts` into the baseline's `typescript/packages/mechanisms/svm/test/unit/` directory; the implementation already contains it. Do not apply the production fix to baseline. Avoid running installation scripts or using credentials for this validation.

From the SVM package in each tree:

```sh
node node_modules/vitest/vitest.mjs run test/unit/batch.channelManager.scheduling.test.ts --coverage.enabled=false --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

Expected baseline exit: 1 (five assertion failures). Expected implementation exit: 0 (eleven passing tests). Full implementation unit suite:

```sh
node node_modules/vitest/vitest.mjs run --coverage.enabled=false --maxWorkers=2 --minWorkers=1 --no-file-parallelism
```

To run the portable scratch probes, set `X402_SOURCE_ROOT` to an absolute prepared implementation checkout and `EVIDENCE_ROOT` to this evidence directory, then run from any directory:

```sh
export X402_SOURCE_ROOT=/path/to/prepared-implementation
export EVIDENCE_ROOT=/path/to/evidence/svm-redemption-worker-scheduling
node "$X402_SOURCE_ROOT/typescript/packages/mechanisms/svm/node_modules/vitest/vitest.mjs" run --config "$EVIDENCE_ROOT/probes/vitest.config.mjs" --coverage.enabled=false --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

The portable probe replaces only SDK import prefixes and supplies the matching Vitest alias. Its test bodies are unchanged; `probes/original-second-audit.test.ts` preserves the original audit source, which depends on the original sibling validation-directory layout. The portable configuration uses explicit source selection so it cannot silently test the wrong tree. Its relocated copy was rerun against the identical fixed source: three of three passed; results are recorded under `portable-evidence-probes.*`.

For builds, `harness/build.mjs` reads the package's actual tsup configuration, builds each configuration sequentially, and runs the declaration mirror. With `EVIDENCE_ROOT` set as above, run from Core and then SVM respectively:

```sh
GOMAXPROCS=2 node "$EVIDENCE_ROOT/harness/build.mjs" ../../scripts/mirror-cjs-dts.mjs
GOMAXPROCS=2 node "$EVIDENCE_ROOT/harness/build.mjs" ../../../scripts/mirror-cjs-dts.mjs
```

The build helper was exercised with Node 24.19.0's native TypeScript loader for `tsup.config.ts`. It is an evidence harness, not a replacement repository build configuration. Commands for lint, formatting and compiler comparisons are preserved in the metadata. For the supplemental compiler check, temporarily copy `tests/scheduler.typecheck.json` into each disposable SVM package and run `tsc --noEmit --pretty false --project scheduler.typecheck.json`. Expect the two inherited diagnostics. Plain package `tsc --noEmit --pretty false` yields the five inherited diagnostics.

## Records and integrity

`results/` contains exact outputs, JSON assertions, command arguments, working directories, exit codes and elapsed times. Machine-specific absolute paths use placeholders, tabs are expanded and trailing whitespace normalized. Original unsanitized records remain local. Result values, assertion messages, exit codes and timings were not altered. `manifest.json` records source/test/dependency hashes and validation limits; `SHA256SUMS` covers all evidence files except itself.

`reviews/` records the pre-implementation design audit and both independent final reviews. The design was approved before source edits. The first reviewer requested two additional controls, both included: repeated explicit flush requests and an earlier stop with later blocked manual work. Neither final reviewer required a production correction.

The second reviewer initially ran the fixed tree under a baseline-looking output name. Its cwd exposed the error; those artifacts are retained under `excluded/second-audit-initial-fixed-root.*` and are **not baseline evidence**. The authoritative baseline/fixed reruns explicitly selected the proper roots and independently verified their hashes. This bookkeeping mistake did not affect the original baseline results or implementation.

Implementation and evidence preparation used Codex. Design and final reviews used Sol 6.1 extra-high agents, including a different reviewer for the second final audit. No Claude or Astra contribution is credited.
