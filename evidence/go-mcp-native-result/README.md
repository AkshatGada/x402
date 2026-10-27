# Go MCP native-result preservation evidence

Baseline: [`1148309d5bdf`](https://github.com/x402-foundation/x402/commit/1148309d5bdf4db476c488048d34dc6706a1c6da).
Implementation: [`52178fe36b26`](https://github.com/AkshatGada/x402/commit/52178fe36b265ccf99b94f28f107c25bc0655565).

The primary Go `X402MCPClient` projected tool results into text-only items. Image/audio/resource output and structured/native metadata were inaccessible to its caller, including after a simulated paid call returned a success receipt. The fix exposes the original SDK result through `RawResult`, following the existing `CallPaidTool` API. Existing `Content` remains text-only.

All payments and receipts here are synthetic. The harness uses the actual x402 source and official MCP Go SDK v1.3.0, with an in-process fake `MCPCaller` and payment scheme. There are no tool-server connections, RPC calls, signatures or real funds. Image/audio bytes are inert synthetic fixtures, not media rendering tests.

## Baseline versus fix

| Scenario | Baseline | Fix |
| --- | --- | --- |
| Text-only compatibility control | Pass | Pass |
| Unpaid mixed native content | Fail: 5 native items become 1 text item | Pass: all native data accessible |
| Paid mixed native content | Fail: 5 become 1 despite success receipt | Pass |
| Paid image-only | Fail: 1 becomes 0 despite success receipt | Pass: image accessible through `RawResult.Content` |
| Ordinary nonpayment tool error | Fail: native content/data unavailable | Pass: error flag and native data retained |
| Existing `CallPaidTool` control | Pass | Pass |

The identical desired-behavior driver exits **1 on baseline** (four failures/two controls pass) and **0 on the fix** (six pass). Reflection exists only in the scratch driver's optional-field lookup so the same file compiles against both APIs. The new production regression tests access the field directly.

## Replay

Requires Go 1.24+ and the locked modules already in the module cache. The runner disables downloads and limits compilation to two jobs. It copies the harness into a temporary directory, points its module replacement at the supplied checkout and removes that temporary directory on exit; it does not edit either checkout.

From the repository root with both revisions available locally:

```sh
git worktree add --detach ../mcp-baseline 1148309d5bdf4db476c488048d34dc6706a1c6da
git worktree add --detach ../mcp-fixed 52178fe36b265ccf99b94f28f107c25bc0655565
./evidence/go-mcp-native-result/harness/run.sh ../mcp-baseline
# Expected exit 1: four preservation failures; two controls pass.
./evidence/go-mcp-native-result/harness/run.sh ../mcp-fixed
# Expected exit 0: all six scenarios pass.
```

`harness/go.mod` uses a local SDK replacement. No new dependency was added to x402. The approved isolated setup fetched only MCP SDK 1.3.0, jsonschema-go 0.4.2 and uritemplate/v3 3.0.2; the runner will fail offline if they are absent.

## Package checks and independent review

The implementation's six regression cases cover free mixed output, automatic paid mixed output, paid image-only, explicit payment, ordinary tool error and recovery returning the terminal result. They check native pointer identity and data, compatibility projection, payment/error/receipt fields and request counts.

Recorded checks in `results/`:

- Baseline full MCP package race/coverage: pass, 77.4% statements.
- Fixed full MCP package race/coverage: pass, 78.2% statements.
- Scoped MCP build, vet and repository-pinned golangci-lint v2.7.2: pass, zero lint issues.
- Changed Go files pass goimports; the implementation diff passes whitespace checks.
- Independent replay of baseline/fix driver: expected failure then success.
- Independent focused and supplemental typed-structured/native-content/JSON/ownership tests: pass.

These are MCP-package checks, not a full Go repository suite. Original commands, outputs and exit codes are retained with local paths replaced by placeholders. `index.json` identifies credited checks. The portable runner uses separate checkouts instead of a Go overlay. Its actual baseline/fixed replays, build, vet and pinned-lint results are also recorded here as `portable-*` and `evidence-*`.

The final audit found that noncanonical macOS `/tmp` overlay keys were ignored in two initial local-package commands. Those results are excluded. Corrected `/private/tmp` keys were used for the credited baseline package and supplemental checks; the baseline list check confirms the new regression test was excluded, and the supplemental output names its test explicitly. The public baseline/fix probes were effective and were independently replayed. See `audit/final-review.txt` for the resolved finding.

## API limits

`RawResult` is the original mutable SDK pointer, not a copy or immutable snapshot. Default wrapper JSON now contains `RawResult` and native data, including metadata; exact JSON expectations and unkeyed Go struct literals can change. Hook result projections remain separate. This evidence does not claim live settlement, full-repository validation or a change to cryptographic/payment semantics.

## Provenance

Codex implemented the fix. Separate GPT-6.1 Sol agents with extra-high reasoning audited the design and final code/evidence. The reports retain that attribution; no prior-agent co-author trailers were copied. Both branch commits are SSH-signed by Akshat Gada. This bundle was prepared locally before any push or PR.
