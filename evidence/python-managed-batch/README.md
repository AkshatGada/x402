# Python facilitator-managed EVM batch settlement evidence

Pinned upstream: `dbe1080ac7f65e2e05cc8430a834c255a6800828`.
Implementation identity and source checksum: `IMPLEMENTATION.json` and
`source-sha256.txt`. This is Python buyer/resource-server parity with the merged
[spec #3725](https://github.com/x402-foundation/x402/pull/3725) and
[Go implementation #3726](https://github.com/x402-foundation/x402/pull/3726).

## Reproductions

All payment evidence is synthetic: the actual Python SDK calls the actual pinned
Go managed scheme over loopback HTTP with upstream mocked chain/signing fixtures,
a seeded channel and fixed synthetic caller identity. No real funds, production
credentials, live RPC, deployed service or onchain transactions were used.

There are **two different baselines**:

1. Pinned upstream lacks Python managed configuration and salt/wire support.
   Configuration raises TypeError; identical salt/type tests give 17 failures/28 passes.
2. The initial unpublished feature had lifecycle defects caught during review.
   It is reconstructed by `harness/uncorrected-implementation.patch`, not presented
   as existing upstream behavior. Same 38 product regressions give 30 failures/8 passes
   before correction and 38 passes after; the same 82 independent cases give 64 failures/18 passes
   before and 82 passes after.

| Scenario | Initial feature | Corrected feature |
| --- | --- | --- |
| Local refund signer unavailable after admission | Go verify=1, settle=0, held=true; next request channel_busy | verify=1, zero-charge cancel settle=1, held=false; next request valid |
| Explicit before-settle abort | Admission retained until TTL | Zero-charge cancel; original application error preserved |
| Returned settlement_pending | Reservation/refund context discarded | Same ID and snapshot retained for explicit reconciliation |
| Incomplete authoritative verification/receipt | Missing state fabricated from defaults | Verification aborts or receipt fails closed while preserving known committed details |
| Optional replica I/O unavailable | — | Valid successful receipt and real buyer watermark preserved |

Unknown post-dispatch errors are never auto-canceled. Failed cleanup keeps its
identity and original error. Direct voucher/deposit settle without local verify
still uses Go's full-reverification path. Exact refund nonces above 2^200 and default
zero salt are covered. The zero-salt Go probe compares direct ComputeChannelId and
actual verification; the original /setup canonicalConfig helper re-packs salt and
is only a salt=1 control, not a general original-entropy oracle.

## Final checks

- 146 focused tests and 82 independent audit cases pass.
- Broad eligible suite: 2,220 pass/9 fail/2 skip; pinned baseline 2,099 pass/the same 9 fail/2 skip.
  No new failure IDs. SVM/TVM directories were excluded for missing optional extras;
  remaining MCP/Bazaar/optional-extra failures are baseline conditions, not ignored new failures.
- Actual Go full-flow checks pass both refund consent configurations, commit/replay,
  corrective proof and buyer recovery, cross-server cancellation, early hook abort
  and partial refund. Signer-outage and zero-salt controls pass separately.
- Ruff format/lint pass; 2 Node and 2 Python catalog tests and 4 changed TS syntax checks pass.
- sdist/wheel build passes; 11 changed production files match the wheel byte-for-byte.
- managed.py stdlib trace: 237/253 lines, 93.68%; not branch/project coverage.
- Independent final review found no remaining blocker in scope; see `audit/final-report.txt`.

Structured non-200 HTTP mappings still depend on #3802/#3938/#3825; they were not
duplicated. The Go bridge returns scheme response models as HTTP 200. This does not
prove an auth gateway, funded deposit/top-up, full monorepo/SDK, full TypeScript E2E
build/types, Python-version matrix or live worker/onchain behavior.

## Replay without installing

Use `replay.py --help`. It requires an existing Python environment containing the
approved EVM/HTTP/test dependencies and a Go toolchain with populated module cache.
It forces GOPROXY=off, GOTOOLCHAIN=local and at most 2 Go workers; tests are serial.
Use `--queue` when coordinating other jobs. It never installs, downloads or edits
source checkouts. Snapshot export and the validation-only Go fixture use temporary
staging; expected failures must match specific test counts, not just nonzero exits.

```sh
python3 replay.py --checkout "$IMPLEMENTATION_CHECKOUT" \
  --python "$PYTHON_ENV/bin/python" --go "$GO" \
  --queue "$TEST_SLOT" --output "$NEW_OUTPUT_DIRECTORY"
```

Existing partial clones can supply `--python-baseline` (the baseline/python folder)
and `--go-baseline` (the pinned Go source). All 451 Python and 675 Go files are verified
against Git blob IDs and SHA256 in `baseline-manifest.json`. Without those options,
existing Git objects are used; missing objects cause a clear stop without fetching.
All 27 changed implementation files and the exact implementation commit are checked.
Baseline/fix comparisons assert loaded module roots in the same Python process.

The portable Go fixture derives PYTHONPATH from the selected source root in place
of the original machine-specific default; all replay scenarios were rerun after
that environment-only change. No production Go or Python source was changed.

Recorded logs have machine-specific paths replaced and trailing whitespace/blank
lines removed. Assertions, counts and errors are unchanged. Fresh replay creates
raw logs and command records. The reconstruction patch remains byte-for-byte;
`.gitattributes` exempts its necessary context markers from whitespace warnings.
`PROVENANCE.md` records actual tools/reviewers. `SHA256SUMS` covers this evidence.
