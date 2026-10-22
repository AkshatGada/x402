# SVM failed local charge cleanup: synthetic evidence

This branch contains evidence for **fix(svm): release batch reservations after failed local charges**. It contains no production implementation changes.

- Investigated upstream: [`2b06a54edf2b239c3bcf97aa5e514edcea63d777`](https://github.com/x402-foundation/x402/commit/2b06a54edf2b239c3bcf97aa5e514edcea63d777).
- Implementation commit: [`839967485f0179bc2aa05f692628067e5c1c37c5`](https://github.com/AkshatGada/x402/commit/839967485f0179bc2aa05f692628067e5c1c37c5).
- Existing ordering PR used only for compatibility: [#3854](https://github.com/x402-foundation/x402/pull/3854), head `a409a72e0c714eed3ba0d5429bab25c38f47bb4a`.
- Evidence date: October 22, 2026.

## Problem and scope

In TS and Go SVM batch settlement, a local charge/signing error causes `beforeSettle` to return an abort. Core does not dispatch settlement-failure hooks for that abort, so the channel capacity reservation remains held. With a synthetic 10,000-unit deposit, 1,000 already charged and a 4,000-unit ceiling, a failed signing attempt leaves only 5,000 units available and local cooperative-close verification rejects.

The implementation attempts request-specific cleanup before returning the original abort. It preserves consumed request IDs, sibling reservations and committed accounting. Context is retained when cleanup storage fails, allowing a later explicit cleanup attempt. It does not schedule retries or add restart recovery. Manual policy hooks that abort before SVM executes remain outside scope. The spec does not conclusively settle internal signing retry policy; this is a terminal-cleanup behavior choice for the SVM hook's own failed charge attempt.

## Results

| Check | Result |
| --- | --- |
| Same eight lifecycle cases, upstream production code | 3 passed / 5 failed per SDK |
| Same cases with the fix | 8 passed per SDK |
| Full TypeScript SVM unit suite | 1,029 passed across 54 files |
| TypeScript SVM coverage | 94.12% statements/lines; 90.21% branches; 96.02% functions |
| Core and SVM package builds, including declarations | Passed |
| Go server package with race detector | Passed on Go 1.24.13; 80.3% statement coverage |
| Fix plus only existing #3854 production changes | 9 passed per SDK |
| golangci-lint v2.7.2, Go 1.24.13 | 0 issues |
| goimports formatting, changed Go files | Passed |

Sanitized output is in [logs](logs). Final tool versions and check results are in [results.json](results.json). File hashes are in [SHA256SUMS](SHA256SUMS).

A supplemental expanded typecheck of the entire signer test file reports the same two baseline diagnostics: line 471 (TS2352) and line 726 (TS2322). Standard core and SVM package builds pass; this change adds no new diagnostics. Baseline/current output is included in the logs.

The eight cases cover healthy charge and cancellation controls; signer failure with and without a sibling reservation; over-ceiling rejection; cleanup channel-update and operation-release failures followed by explicit cleanup retry; and a charge write that persists but reports an error. Assertions check the original abort, zero facilitator/recovery calls, consumed-ID rejection through normal verification, sibling preservation, and exact committed state. TS takes an independent state snapshot with `structuredClone`; Go uses `cloneState`.

## Method and reproduction

Use an isolated checkout and installed dependencies. No installation script or network payment execution is part of these checks. Never overwrite an existing working tree to reproduce them.

1. Start from the pinned upstream revision and apply [patches/regression-tests.patch](patches/regression-tests.patch). Run the focused selectors below: five cases fail in each SDK.
2. In a separate checkout of the implementation branch, run the same selectors: all eight pass. The implementation branch already contains the regression tests.
3. To reproduce compatibility, apply [the existing #3854 production patch](patches/existing-3854-production.patch) and [the compatibility-only test augmentation](patches/compatibility-tests.patch) to the fixed checkout. The same selectors then run nine passing cases per SDK. Remove only those comparison patches afterward.

From `typescript/`, with Node and pnpm on PATH:

```sh
GOMAXPROCS=1 pnpm --filter @x402/core build
GOMAXPROCS=1 pnpm --filter @x402/svm build
GOMAXPROCS=2 pnpm --filter @x402/svm exec vitest run test/unit/batch.server-signer.test.ts -t 'failed charge cleanup' --coverage.enabled=false --maxWorkers=2 --minWorkers=1 --no-file-parallelism
```

For the full SVM suite with coverage:

```sh
GOMAXPROCS=2 pnpm --filter @x402/svm test --maxWorkers=2 --minWorkers=1 --no-file-parallelism
```

From `go/`, using the tool versions in `results.json`:

```sh
GOMAXPROCS=2 GOFLAGS=-p=2 go test -v -count=1 -run 'TestBatchServerVoucherSignerBoundaries/failed_charge_cleanup' ./mechanisms/svm/batch-settlement/server
GOMAXPROCS=2 GOFLAGS=-p=2 go test -race -cover -count=1 ./mechanisms/svm/batch-settlement/server
```

Run builds and test commands sequentially. Compilation/test parallelism was limited to two jobs. These are package-scoped checks, not a full-repository build or test claim.

## Compatibility detail

With #3854, operation completion can fail after the charge commits. The ninth case checks that the exact committed 1,400-unit charge, signed watermark, voucher and sibling reservation survive cleanup while the operation ID remains consumed.

A lost charge-write acknowledgement also differs between variants: current upstream completes the operation inside the update callback, while #3854 does not reach completion after the update reports an error. The compatibility-only test therefore expects a retained `reserved` operation for that case. Both variants preserve the committed channel state. No #3854 production change or compatibility-only test is included in the implementation PR.

## Limits and review

These tests exercise actual core and SVM lifecycle code with generated local signers, in-memory/fault-injected stores, a synthetic confirmed opening, and a mocked facilitator. No HTTP resource handler/adapters, real funds, RPC payment calls, transaction broadcasts, payout or onchain closure were executed. A passing close assertion means local verification only. Reservation expiry duration and restart recovery were not measured.

An independent Astra agent at high reasoning reviewed the architecture before implementation and then the production diff/assertions. It required preserving explicit aborts during cleanup failures, keeping original error classification, delaying context deletion until successful cleanup, and using an independent TS committed-state snapshot. These corrections were applied. The review did not independently execute tests and is not maintainer approval.

AI disclosure: investigation, implementation and evidence were developed with Codex, with design and implementation review by Astra.
