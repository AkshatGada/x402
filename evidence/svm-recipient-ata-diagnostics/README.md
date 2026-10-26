# Exact SVM recipient ATA diagnostics: reproduction and results

Follow-up: [#2802](https://github.com/x402-foundation/x402/pull/2802#issuecomment-6336803142).

- Baseline: `b187119bf270a50c09057d7798c713788f823ca9`
- Implementation: `599a9e36c8c07d56e96c3e675648d3a9db7b5981`
- Date: 26 October 2026

## What these tests establish

The exact v2 facilitators already reject a failed static simulation correctly. This change adds a failure-only optional recipient-account lookup and a distinct reason for missing accounts or wrong token-program ownership. It preserves the original simulation detail and payer, adds no read after success/earlier rejection, and keeps generic failures when diagnosis is unavailable or inconclusive. The same verifier serves pre-broadcast settlement.

The tests use actual SDK verifier code, genuine ephemeral payer signatures, and ordinary SPL Token/Token-2022 transactions. Simulation outcomes and account replies are scripted. They do not execute a Solana bank, reproduce an actual missing-account execution failure, prove historical causation from a later account snapshot, measure latency or estimate production incident frequency. No live RPC, funds, production credentials or new installations were used.

## Baseline versus implementation

| Focused suite | Baseline | Implementation |
| --- | --- | --- |
| TypeScript | 16 fail, 10 controls pass | 26 pass |
| Go | 22 fail, 10 controls pass | 32 leaf cases pass |

The final test files are byte-identical across baseline and implementation; hashes are in `manifest.json`. Fresh ephemeral keys are generated per run, so generated wire transactions differ. The baseline is a disposable materialized archive of the pinned revision, with only the two new test files added. Its 282 materialized SVM production files were checked against baseline Git blobs.

Baseline failures demonstrate the requested enhancement and its optional lookup are absent. They do not imply the generic baseline rejection violated an existing public diagnostic contract. The `audit-*` logs record independent focused baseline/fix reruns, including Go race detection, with the same results.

Cases cover confirmed lookup at the validated destination/network, both token programs, TypeScript method receiver binding, Go wrapped `rpc.ErrNotFound`, nil-value versus inconclusive nil-result distinctions, read errors with partial data, original message/payer preservation, successful simulation, early amount/mint/decode rejection, smart-wallet fallback exclusion, and settlement rejection without signing/broadcast/confirmation.

## Broader checks and limits

- Full SVM TypeScript suite: **1,053 pass**, 55 files. Coverage instrumentation disabled; no live integration suite.
- Go exact v2 facilitator package: race detector and coverage pass, **69.3%** statement coverage. Scoped package build passes.
- TypeScript ESM/CJS build, declarations and declaration-mirroring step pass.
- Changed TypeScript/test lint/format and Go package lint/import checks pass. Go lint v2.7.2 reports zero issues.
- Whole-package `tsc --noEmit` retains **five baseline diagnostics**, with identical output before/after.
- Supplemental compilation including the new test and ES2020+DOM retains **six imported source/helper diagnostics**, also identical before/after; none points to a new test or changed production line. This is baseline parity, not a clean typecheck claim. SDK tsconfig was unchanged.
- No full Go SDK or monorepo suite, minimum-peer-version matrix or deployment test is claimed. Cached Kit 6.1.0, TypeScript 5.9.2, Vitest 3.2.7 and Go 1.24 were used.

## Reproduce

Use disposable source trees at the baseline and implementation commits with repository dependencies already available. Copy the two test files from this directory into their normal package locations in the baseline tree; they already exist in the implementation. Do not apply the production fix to baseline.

From `typescript/packages/mechanisms/svm` in each tree:

```sh
node node_modules/vitest/vitest.mjs run test/unit/recipientAtaDiagnostics.test.ts --coverage.enabled=false --maxWorkers=2 --minWorkers=1 --no-file-parallelism
```

From `go/` in each tree:

```sh
GOMAXPROCS=2 go test -mod=readonly -p=2 -count=1 -race -v ./mechanisms/svm/exact/facilitator -run TestRecipientATADiagnostics
```

Expected exits: baseline 1, implementation 0. All test inputs are synthetic. No network setup is required for the test logic; dependencies must already be present. Recorded Go runs used `GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off` to prevent downloads.

For the full implementation SVM suite/build:

```sh
node node_modules/vitest/vitest.mjs run --coverage.enabled=false --maxWorkers=2 --minWorkers=1 --no-file-parallelism
GOMAXPROCS=2 node node_modules/tsup/dist/cli-default.js
node ../../../scripts/mirror-cjs-dts.mjs
```

For the Go facilitator package:

```sh
GOMAXPROCS=2 go test -mod=readonly -p=2 -count=1 -race -cover ./mechanisms/svm/exact/facilitator
GOMAXPROCS=2 go build -mod=readonly -p=2 ./mechanisms/svm/exact/facilitator
```

To repeat the supplemental compiler comparison, temporarily copy `tsconfig.ata-check.json` into the SVM package in each disposable tree and run `tsc --noEmit -p tsconfig.ata-check.json`. Expect the six inherited source/helper diagnostics. Plain package `tsc --noEmit` reports the five inherited diagnostics. Remove only that temporary config afterward.

## Integrity

Each paired `.json` and `.log` contains the exact command, working directory, elapsed time, exit code and full output. Machine-specific paths were replaced by placeholders. Log tabs were expanded and trailing whitespace trimmed; results and diagnostic text are otherwise unchanged. Tests/builds used at most two workers/jobs, with heavy checks sequential. SHA256SUMS covers every evidence file. No secrets or local absolute paths are included.
