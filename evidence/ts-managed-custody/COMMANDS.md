# Check commands

All commands use existing dependencies, two workers, and the shared lock wrapper
where other chats are testing. `replay.py --help` lists portable replay inputs.
The source/runtime SHA256 manifests bind the proof to this implementation.

From `typescript/packages/core`:

```sh
pnpm run build
pnpm exec vitest run --coverage --maxWorkers 2
pnpm exec eslint src/server/x402ResourceServer.ts src/types/mechanisms.ts test/unit/server/x402ResourceServer.test.ts
pnpm exec prettier --check src/server/x402ResourceServer.ts src/types/mechanisms.ts test/unit/server/x402ResourceServer.test.ts
```

From `typescript/packages/mechanisms/evm`:

```sh
pnpm run build
pnpm exec vitest run --coverage --maxWorkers 2
pnpm exec eslint src/batch-settlement/server/{managed,scheme,settle,verify,channelManager}.ts src/batch-settlement/client/channel.ts src/batch-settlement/{types,errors,utils}.ts test/unit/batch-settlement/managed.test.ts
pnpm exec prettier --check src/batch-settlement/server/{managed,scheme,settle,verify,channelManager}.ts src/batch-settlement/client/channel.ts src/batch-settlement/{types,errors,utils}.ts src/batch-settlement/README.md test/unit/batch-settlement/managed.test.ts ../../../.changeset/evm-managed-custody-client-server.md
pnpm exec tsc --noEmit
```

The last command is the documented **known baseline failure** (two missing Crypto
types), not a passing check. A separate temporary tsconfig extending the package
config with `compilerOptions.lib=["ES2020","DOM"]`, including `src` plus the new
managed test, passes. The normal package builds also pass. No tsconfig workaround
or dependency-file change is in the implementation commit.

The Go bridge uses only `go test -mod=readonly -p 2 -count=1` and the existing
managed controls. `replay.py` records fresh raw output for the six Go scenarios
and both identical-test comparisons. Expected failure logs are intentional
baseline reproductions and are explicitly checked, not CI failures to ignore.
