# Go upto actual-charge simulation evidence

Baseline: [`dbe1080ac7f6`](https://github.com/x402-foundation/x402/commit/dbe1080ac7f65e2e05cc8430a834c255a6800828).
Implementation: [`d202e72dda37`](https://github.com/AkshatGada/x402/commit/d202e72dda378788adc3aef17dbfeda08c28e286).

With `SimulateInSettle=true`, the original Go facilitator simulated the signed ceiling rather than the actual charge. The ordinary synthetic example authorizes 1,000,000 units, has 400,000 at settlement, and charges 300,000. Baseline simulation rejects that covered charge. The fix retains signed-ceiling verification and uses actual amounts for simulation, sponsoring prerequisites and diagnostics.

## Results

- Same settlement-amount matrix and existing partial-settlement control on baseline production: **23 failing leaf cases, 14 passing controls**.
- Corrected full facilitator package: **145 passing leaf cases**, zero failed/skipped, across 72 top-level tests.
- Focused build, vet, goimports and repository-pinned golangci-lint 2.7.2 pass, with zero lint issues.
- Independent follow-up review reran the full package and accepted the exact source hashes in `results/source-hashes.json`.

Coverage includes plain settlement, EIP-2612, ERC20 sponsoring with batch simulation and prerequisite-only checks, actual-charge diagnostics, zero charges, invalid amounts and unchanged verification against the ceiling. All chain reads/writes and receipts are synthetic; SDK authorization hashing and deterministic fixture approval signing use real local implementations. No live RPC, transactions, production credentials or real funds are used.

## Replay the ordinary amount matrix

Requires Go 1.24+ and the repository's pinned dependencies already cached. From a checkout containing the reviewed implementation and the baseline Git object:

```sh
python3 evidence/go-upto-actual-charge/harness/reproduce.py PATH_TO_CHECKOUT --baseline
# Expected exit 1: 23 failures, 14 passing controls.
python3 evidence/go-upto-actual-charge/harness/reproduce.py PATH_TO_CHECKOUT
# Expected exit 0: all 37 selected leaf cases pass.
```

Use `--go PATH_TO_GO` if the toolchain is not on PATH. The script uses canonical paths and a temporary Go overlay: it injects the identical committed fixture and, for baseline mode, substitutes the exact recorded upstream `permit2.go`. It leaves the checkout untouched and disables dependency/toolchain downloads. Compilation is capped at two jobs. It runs only the ordinary settlement-amount matrix and the existing partial-settlement control.

Full reviewed package command, from `go/`:

```sh
CGO_ENABLED=0 GOMAXPROCS=2 GOPROXY=off GOTOOLCHAIN=local go test -mod=readonly -p=2 -count=1 ./mechanisms/evm/upto/facilitator
```

Recorded logs and commands under `results/` have local paths redacted. The portable runner was executed in both modes: baseline exits 1 with 23 failures/14 controls; fixed exits 0 with all 37 selected cases passing. These outputs supplement the original canonical-overlay proof. Tests used Go 1.24.13 with CGO disabled because of a local macOS linker incompatibility. No race, full-SDK, deployed-contract or live-chain validation is claimed.

This branch contains ordinary regression evidence only. Private review material and private fixtures are excluded. Implementation and correction used Codex; independent final review used GPT-6.1 Sol with extra-high reasoning. No previous-agent co-author trailer was copied.
