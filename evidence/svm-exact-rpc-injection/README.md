# V2 exact SVM RPC injection: local evidence for #1832

Issue: https://github.com/x402-foundation/x402/issues/1832

- Upstream baseline: `4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54`
- Implementation: `236e87b80ac9e68606bb417419a1b500e23d97a6`
- Date: 2026-10-26

The exact client previously constructed its own RPC from a URL. These tests demonstrate the missing injection capability and preservation of existing behavior. They do **not** claim a regression of a previously supported `rpc` option, live provider failover, or improved payment success rates.

## Results

| Check | Result |
| --- | --- |
| Identical focused tests on baseline | 7 feature cases fail; 10 compatibility cases pass |
| Focused tests on implementation | 17 pass |
| Full SVM unit suite on final source | 55 files; 1,044 tests pass |
| Package ESM/CJS build and declarations | Pass |
| Generated ESM/CJS public API consumer checks | Pass |
| Changed TypeScript/test lint and formatting | Pass |
| Whole-package `tsc --noEmit` | Same five diagnostics on baseline and implementation |
| New test included explicitly in compiler check | Only two transitive pre-existing diagnostics; none in new test |

Tests use a real Kit RPC client backed by deterministic in-memory JSON-RPC responses. Actual mint decoding, instruction construction and signing run. Tests verify payer signatures, transfer amount/decimals, fee payer and blockhash. They cover three supported networks, RPC precedence over URL, URL/default compatibility, supplied blockhash, cached mint reuse, transport errors and retry, unsupported inputs, and a supported alias.

No live RPC, funds, provider credentials or transaction submissions were used. Coverage instrumentation was disabled; live integration tests were not run. Test workers were capped at two with file parallelism disabled. Builds used `GOMAXPROCS=2`. Dependencies were reused from an existing local cache; no installations were required. Kit 6.1.0 was tested; the minimum peer version 5.1 was not separately tested.

The five existing compiler diagnostics are two errors in `src/exact/facilitator/signatureVerification.ts`, two duplicate imports in `test/unit/index.test.ts`, and a signer mismatch in that existing test. Baseline and final outputs are identical. Unrelated source was left unchanged.

## Reproduce

Use two disposable worktrees, one at the baseline and one at the implementation commit above, with the repository dependencies available. No installation or live network command is included here.

Copy `clientRpcInjection.test.ts` from this directory into the baseline's `typescript/packages/mechanisms/svm/test/unit/`. The implementation already contains the identical test. From the SVM package in each worktree, run:

```sh
node node_modules/vitest/vitest.mjs run test/unit/clientRpcInjection.test.ts --coverage.enabled=false --maxWorkers=2 --minWorkers=1 --no-file-parallelism
```

The baseline is expected to exit 1 with seven failures. Vitest transpiles the intentionally unsupported baseline config; this is runtime feature-gap evidence, not a baseline typecheck claiming that config was valid.

For the implementation's full SVM suite:

```sh
node node_modules/vitest/vitest.mjs run --coverage.enabled=false --maxWorkers=2 --minWorkers=1 --no-file-parallelism
GOMAXPROCS=2 node node_modules/tsup/dist/cli-default.js
node ../../../scripts/mirror-cjs-dts.mjs
```

To repeat the public declaration checks, copy `rpc-public-validation.mts` and `.cts` into the built SVM package. Run the following for each extension:

```sh
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2020 --module NodeNext --moduleResolution NodeNext rpc-public-validation.mts
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2020 --module NodeNext --moduleResolution NodeNext rpc-public-validation.cts
```

Both consumer checks use the actual package exports, accepting custom transport clients and branded devnet clients through the root and exact/client entrypoints. For the new-test compiler check, copy `tsconfig.rpc-validation.json` into the SVM package and run `tsc --noEmit -p tsconfig.rpc-validation.json`. The two existing transitive errors described above remain. `tsc --noEmit` without that config reports the five existing package diagnostics on both revisions. Remove only the temporary fixtures you copied when finished.

## Evidence integrity and review

Each check has a full `.log` plus `.json` command, working directory, elapsed time and exit status. Machine-specific path prefixes were replaced with `<local>` or `<user-home>`; trailing blank lines were trimmed. Test outcomes and diagnostics are otherwise unchanged. SHA256SUMS covers the published files, and `manifest.json` records the identical baseline/implementation test hash.

The design and final audit reports are historical snapshots. Astra high reviewed the design before implementation and independently inspected the final diff. Its two design adjustments were implemented, and its final optional blockhash assertion was added. It reported no blocking findings. Audit reports distinguish reviewer inspection from parent-run checks.

Implementation: Codex. Design and independent final review: Astra high. Existing attribution on PR #3892 was not changed. All evidence here is local synthetic testing; no devnet screenshots or production results are implied.
