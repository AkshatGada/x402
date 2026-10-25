#!/usr/bin/env python3
"""Reproduce the local construction regression without downloads or chain RPC."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


BASE = "4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54"
SOURCE = "a39311277f3ada94d3999f155d660caab72b06af"
SCHEME = "go/mechanisms/svm/exact/client/scheme.go"
TEST = "go/mechanisms/svm/exact/client/token_program_test.go"
SCHEME_HASH = "625ee032e7d3472c4a668d6024aeab7132028ce63a34678898f0e7a87e3edcea"
TEST_HASH = "64a48e75b4c03d34c6fd7d51b3d566831ffdefab4fcd351a19e04c1637d616b1"
BASE_HASH = "889f98cf857a6323d75c955b462c7c4ad0c16e7934ba0e2d70482817f1107bc1"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Clean checkout of the signed source commit")
    parser.add_argument("--go", default="go", help="Existing Go 1.24+ executable")
    parser.add_argument("--output", type=Path, help="New directory for logs (default: temporary directory)")
    args = parser.parse_args()
    source = args.source.resolve()

    def git(*arguments):
        return subprocess.check_output(["git", "-C", str(source), *arguments])

    if git("rev-parse", "HEAD").decode().strip() != SOURCE:
        raise SystemExit("Check out the source commit recorded in README.md first.")
    if git("status", "--porcelain"):
        raise SystemExit("Use a clean source checkout; this script does not modify it.")
    for name, expected in [(SCHEME, SCHEME_HASH), (TEST, TEST_HASH)]:
        if hashlib.sha256((source / name).read_bytes()).hexdigest() != expected:
            raise SystemExit("Source hash mismatch: " + name)
    baseline_source = git("show", BASE + ":" + SCHEME)
    if hashlib.sha256(baseline_source).hexdigest() != BASE_HASH:
        raise SystemExit("Pinned upstream source hash mismatch.")

    if args.output:
        output = args.output.resolve()
        output.mkdir(parents=True, exist_ok=False)
    else:
        output = Path(tempfile.mkdtemp(prefix="x402-token2022-proof-"))
    baseline_file = output / "upstream-scheme.go"
    baseline_file.write_bytes(baseline_source)
    overlay = output / "baseline-overlay.json"
    overlay.write_text(json.dumps({"Replace": {str(source / SCHEME): str(baseline_file)}}, indent=2) + "\n")

    env = dict(os.environ, GOTOOLCHAIN="local", GOPROXY="off", GOSUMDB="off", GOMAXPROCS="2", GOFLAGS="-p=2")
    flags = ["-race", "-count=1", "-parallel=2", "-v", "-run",
             "^TestCreatePaymentPayloadUsesMintTokenProgram$", "./mechanisms/svm/exact/client"]
    results = []
    outputs = {}
    for label in ["fixed", "baseline"]:
        command = [args.go, "test"]
        if label == "baseline":
            command.append("-overlay=" + str(overlay))
        command.extend(flags)
        start = time.monotonic()
        completed = subprocess.run(command, cwd=source / "go", env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        outputs[label] = completed.stdout
        (output / (label + ".log")).write_text(completed.stdout)
        results.append({"label": label, "command": command, "exit_code": completed.returncode,
                        "elapsed_seconds": round(time.monotonic() - start, 3)})
    (output / "results.json").write_text(json.dumps({"source": SOURCE, "base": BASE, "runs": results}, indent=2) + "\n")

    if [r["exit_code"] for r in results] != [0, 1]:
        raise SystemExit("Unexpected result; inspect logs at " + str(output))
    for label, text in outputs.items():
        if "WARNING: DATA RACE" in text:
            raise SystemExit("Race diagnostic in " + label + "; inspect " + str(output))
        for mode in ["sequential", "parallel"]:
            for case in ["legacy_token", "legacy_after_token_2022"]:
                if "--- PASS: TestCreatePaymentPayloadUsesMintTokenProgram/" + mode + "/" + case not in text:
                    raise SystemExit("Legacy control did not pass; inspect " + str(output))
    baseline = outputs["baseline"]
    for message in ["transfer program must match the mint owner",
                    "source ATA must use the mint's token program",
                    "destination ATA must use the mint's token program"]:
        if baseline.count(message) != 2:
            raise SystemExit("Unexpected baseline assertion failures; inspect " + str(output))
    if baseline.count("Error Trace:") != 6:
        raise SystemExit("Additional baseline failure; inspect " + str(output))
    print("Verified: fixed passes; upstream fails only the three Token-2022 assertions in both modes.")
    print("Logs: " + str(output))


if __name__ == "__main__":
    main()
