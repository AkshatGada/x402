# Go exact-SVM Token-2022 construction evidence

The Go v2 exact client accepts Token-2022 mint metadata but, on the pinned upstream revision, derives both associated token accounts and builds `TransferChecked` using the legacy token program. The fix carries the mint's actual program into all three places.

- Upstream: `4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54`.
- Signed source commit: [`a39311277f3ada94d3999f155d660caab72b06af`](https://github.com/AkshatGada/x402/commit/a39311277f3ada94d3999f155d660caab72b06af).
- [Source diff](https://github.com/AkshatGada/x402/compare/4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54...a39311277f3ada94d3999f155d660caab72b06af).
- [Normative exact-SVM specification](https://github.com/x402-foundation/x402/blob/4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54/specs/schemes/exact/scheme_exact_svm.md#L137) and [existing TypeScript behavior](https://github.com/x402-foundation/x402/blob/4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54/typescript/packages/mechanisms/svm/src/exact/client/scheme.ts#L74).

## Results

The same final test ran against both versions with race detection. The baseline used a Go overlay containing only upstream's `scheme.go`; the checkout was not rewritten.

| Check | Upstream | Fix |
| --- | --- | --- |
| Token-2022 transfer program | FAIL | PASS |
| Token-2022 source ATA | FAIL | PASS |
| Token-2022 destination ATA | FAIL | PASS |
| Legacy controls before/after Token-2022 | PASS | PASS |
| Account flags, transfer fields, payer signature | PASS | PASS |

Both sequential and parallel cases produce these results: six leaf cases total. Upstream exits 1 with exactly six assertion failures (the same three failures in each Token-2022 mode); fixed code exits 0. Neither run reports a race. [Baseline log](logs/baseline.log), [fixed log](logs/fixed.log), [test](regression_test.go), and [commands, exit codes and hashes](results.json).

After audit hardening, all six relevant Go packages passed `go test -race -cover -count=1 -parallel=2 ./mechanisms/svm/exact/... ./mechanisms/svm`. Scoped build, repo-pinned lint and formatting passed. Logs are in [logs/](logs/). These are scoped checks, not full-repository validation.

## Reproduce locally

Prerequisites: an existing clean checkout of the source commit above, Python 3, Go 1.24+ with race support, and cached Go dependencies. This script does not install or download anything. Preserve any current changes by using a separate checkout.

```sh
python3 reproduce.py /path/to/source-checkout --go go
```

Use `--go` to select an existing toolchain and optionally set `GOMODCACHE`/`GOCACHE` to existing caches. The script verifies the source commit and file hashes, extracts pinned upstream code with `git show`, creates a temporary overlay, runs fixed and baseline tests sequentially, and verifies their expected outcomes. Logs go into a new temporary directory; `--output` selects a new directory explicitly. Build/test concurrency is limited to two jobs.

The actual client constructs and signs each transaction. Only mint metadata is mocked via a loopback server, which rejects unexpected RPC methods. The fixture is an initialized, extension-free mint with positive synthetic supply; the blockhash is supplied locally. No live chain RPC, simulation, broadcast or funds are used. This evidence does not establish extension-specific token support or live settlement.

## Review and provenance

Implementation and scoped checks used Codex. Astra high independently reviewed the final source, dependency behavior, tests and evidence, and reran both regression variants. It found no blocking defect; its suggested writable/signer account assertions were added and independently verified. [Full audit](audit.txt). The archived audit describes the original local evidence layout; final commands and hashes are consolidated in `results.json`, and final logs are linked above.

Local checkout paths in logs/audit/metadata are replaced with `$SOURCE` and `$EVIDENCE`; the absolute toolchain executable is represented as `go`. Assertion content and outcomes are unchanged. `SHA256SUMS` covers this evidence bundle. All displayed account keys are generated synthetic public addresses. Earlier sandbox listener-denial attempts are not included as bug evidence.
