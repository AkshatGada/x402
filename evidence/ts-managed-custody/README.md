# TypeScript facilitator-managed EVM batch settlement

Pinned upstream: `dbe1080ac7f65e2e05cc8430a834c255a6800828`.
This is client/resource-server parity with the merged [managed-custody spec](https://github.com/x402-foundation/x402/pull/3725) and [Go facilitator](https://github.com/x402-foundation/x402/pull/3726).

All evidence is synthetic: actual TypeScript SDK code calls the actual pinned Go
managed scheme over loopback HTTP, using upstream mocked chain readers/signers.
No real funds, chain RPC, credentials, transactions or live services are involved.
Amounts below are arbitrary fixture units. This does not implement a TypeScript
managed facilitator, durable custody store or redemption worker.

## Observed behavior

| Scenario | Before | Corrected |
| --- | --- | --- |
| Refund-authorizer channel identity | Pinned upstream client rejected by Go: `refund_authorizer_mismatch`; explicitly packed control succeeds | TS salt equals Go canonical salt; verification and charge succeed |
| Warm resource-server replica | Pinned upstream reports success and local charged=2000; Go receives zero verify/settle calls and remains charged=1000 | Go receives one verify and settle, charged=2000, chargeCount=1 |
| Fresh independent resource servers | — | Facilitator charged=3000, chargeCount=2 across requests |
| Application afterVerify abort | Pre-audit feature: verify=1, settle=0, admission held | verify=1, zero-charge cancel settle=1, admission released |
| Refund signer unavailable | Pre-audit feature: verify=1, settle=0, admission held | Original signing failure preserved; one zero-charge cancel, admission released |
| Optional replica write unavailable (unit) | Pre-audit feature rewrites committed success to failure | Success retained and real client response hook advances charged watermark 1000→2000 |

The pinned-upstream defect/control proof and the pre-audit-feature correction proof
are different baselines. `harness/uncorrected-implementation.patch` reconstructs
that intermediate feature; it is evidence only and is excluded from the implementation PR.
The same final 28 managed test cases produce 11 failures/17 passes on that
intermediate feature and 28 passes on the corrected implementation.

## Checks

- EVM: 58 files / 1,648 tests pass. Core: 27 files / 794 tests pass.
- Core and EVM normal package builds: ESM/CJS/declarations pass.
- Changed-file ESLint and Prettier pass. Changeset covers core and EVM.
- Source plus managed tests typecheck with ES2020/DOM libraries.
- Two pinned Go managed controls pass.
- Six portable loopback scenarios and identical correction regression comparisons pass their expected assertions.
- Independent final review and coverage results are recorded in `audit/`.

Standalone EVM `tsc --noEmit` with the package's ES2020-only config has the same
two pre-existing missing `Crypto` errors on pinned baseline and corrected source
(`src/utils.ts:38–39`). The normal package build succeeds. The complete monorepo,
other SDK builds, browser runtime matrix and live-chain integration suites were
not run. Cleanup intentionally covers explicit hook abort and local settlement
enrichment failure; invalid settlement-override arguments remain outside that
cleanup path. An uncertain/failed facilitator call retains request identity for
reconciliation and is never automatically canceled by the new cleanup guard.

## Replay

`replay.py` takes an existing implementation checkout and already-installed Node,
Go, esbuild and locked package dependencies. It does not install or download.
Provide populated Go caches; it forces `GOPROXY=off` and `GOTOOLCHAIN=local`.
It exports the pinned baseline from existing Git blobs; partial clones can instead
supply `--baseline-snapshot`, whose 960 files are checked against Git blob and
SHA256 hashes in `baseline-manifest.json`. Every changed implementation source
file is checked against `source-sha256.txt`. All staging is temporary; source
checkouts are never edited. Each process is limited to two workers; use `--queue`
with the shared lock wrapper when coordinating other test jobs.

```sh
python3 replay.py --checkout "$IMPLEMENTATION_CHECKOUT" \
  --node "$NODE" --go "$GO" --esbuild "$ESBUILD_MODULE" \
  --output "$NEW_OUTPUT_DIRECTORY" --queue "$TEST_SLOT"
```

The fixture requires loopback socket permission. Expected-failure scenarios must
produce the specific held-reservation JSON and call counts, not just a nonzero
exit status. The regression comparison also checks exact test/failure counts.
No private wallet material is included. The upstream fixture's disposable test
signer and generated in-memory client keys have no external funds or credentials.

Logs are copied with local checkout/runtime path prefixes replaced and trailing
whitespace and final blank lines removed; assertions, errors, counts and results are unchanged. The
portable replay creates fresh raw logs and JSON. See `PROVENANCE.md` for the tools
and independent reviewer used, and `SHA256SUMS` for the complete evidence manifest.
