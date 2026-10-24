#!/usr/bin/env python3
"""Run the same synthetic regression on the pinned baseline and reviewed fix."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", required=True, type=Path,
                        help="prepared fix checkout with existing Node/Go dependencies")
    parser.add_argument("--out", required=True, type=Path,
                        help="new output directory for raw logs and exit statuses")
    args = parser.parse_args()
    repo = args.checkout.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    output = args.out.resolve()
    manifest = json.loads((Path(__file__).resolve().parent / "source-snapshot.json").read_text())
    for relative, expected in manifest["files"].items():
        actual = hashlib.sha256((repo / relative).read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit("Reviewed source mismatch: " + relative)
    for tool in ("node", "go"):
        if not shutil.which(tool):
            raise SystemExit("Missing " + tool + "; nothing is installed by this runner")
    svm = repo / "typescript/packages/mechanisms/svm"
    vitest = svm / "node_modules/vitest/vitest.mjs"
    if not vitest.is_file():
        raise SystemExit("Existing SVM dependencies are required; no installation is attempted")
    env = os.environ.copy()
    env.update(GOTOOLCHAIN="local", GOPROXY="off", GOSUMDB="off",
               GOMAXPROCS="2", GOFLAGS="-p=2", GIT_NO_LAZY_FETCH="1")
    statuses = {}
    go_manager = "go/mechanisms/svm/batch-settlement/server/channel_manager.go"
    ts_manager = "typescript/packages/mechanisms/svm/src/batch-settlement/server/channelManager.ts"
    with tempfile.TemporaryDirectory(prefix="x402-pending-batch-") as temporary:
        temp = Path(temporary)
        saved = {}
        for relative in (go_manager, ts_manager):
            target = temp / Path(relative).name
            target.write_bytes(subprocess.check_output(
                ["git", "show", manifest["base"] + ":" + relative], cwd=repo, env=env))
            saved[relative] = target
        replace = {str(repo / go_manager): str(saved[go_manager])}
        for filename in ("distribution_job_store.go", "distribution_job_store_test.go"):
            replace[str(repo / "go/mechanisms/svm/batch-settlement/server" / filename)] = ""
        overlay = temp / "baseline-overlay.json"
        overlay.write_text(json.dumps({"Replace": replace}))
        config_source = (svm / "vitest.config.ts").read_text()
        if config_source.count("test: {") != 1 or config_source.count("plugins: [") != 1:
            raise SystemExit("Unexpected Vitest config; review the runner before adapting it")
        for revision, expected_exit in (("baseline", 1), ("fix", 0)):
            go_cmd = ["go", "test", "-count=1", "-v"]
            if revision == "baseline":
                go_cmd += ["-overlay=" + str(overlay)]
            go_cmd += ["./mechanisms/svm/batch-settlement/facilitator", "-run",
                       "^TestBatchSettlementOutcomeRecovery$/pending_distribution_batch_identity"]
            config = config_source.replace(
                "test: {", "cacheDir: " + json.dumps(str(temp / "vite-cache")) + ",\n  test: {", 1)
            if revision == "baseline":
                config = 'import { readFileSync } from "node:fs";\n' + config
                plugin = ('{name: "pinned-baseline-manager", enforce: "pre", load(id) {'
                          'if (id.endsWith("/src/batch-settlement/server/channelManager.ts")) '
                          'return readFileSync(' + json.dumps(str(saved[ts_manager])) + ', "utf8");}}, ')
                config = config.replace("plugins: [", "plugins: [" + plugin, 1)
            # A unique sibling config resolves the checkout's existing Node dependencies.
            # No tracked source is overwritten. The generated file is removed in finally.
            descriptor, config_name = tempfile.mkstemp(
                prefix=".x402-pending-evidence-", suffix=".config.ts", dir=svm)
            os.close(descriptor)
            config_path = Path(config_name)
            try:
                config_path.write_text(config)
                ts_cmd = ["node", str(vitest), "run", "--config", str(config_path),
                          "--maxWorkers=2", "--no-file-parallelism",
                          "test/unit/batch.recovery.test.ts", "test/unit/batch.channelManager.test.ts",
                          "-t", "research:|recovers the original pending payout"]
                for language, command, cwd in (("go", go_cmd, repo / "go"), ("ts", ts_cmd, svm)):
                    name = language + "-" + revision
                    log_path = output / (name + ".log")
                    with log_path.open("w") as log:
                        result = subprocess.run(command, cwd=cwd, env=env,
                                                stdout=log, stderr=subprocess.STDOUT)
                    content = log_path.read_text()
                    assertion_seen = ("Not equal:" in content if language == "go"
                                      else "AssertionError" in content)
                    matched = result.returncode == expected_exit and (revision != "baseline" or assertion_seen)
                    statuses[name] = {"exit": result.returncode, "expected_exit": expected_exit,
                                      "expectation_met": matched}
            finally:
                config_path.unlink()
    (output / "run-statuses.json").write_text(json.dumps(statuses, indent=2) + "\n")
    print(json.dumps(statuses, indent=2))
    if not all(item["expectation_met"] for item in statuses.values()):
        raise SystemExit("Unexpected result; inspect the logs (setup failures are not reproductions)")


if __name__ == "__main__":
    main()
