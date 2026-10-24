#!/usr/bin/env python3
"""Run synthetic close-accounting checks without installing dependencies."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

BASE = "4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54"
FIRST = "4c444151ba0defa92c66d8fcab378d4484c2ea08"
FIX = "ec95e3d91ba384908445a889319d3129d1fdfba8"
PACKAGE = Path("go/mechanisms/svm/batch-settlement/facilitator")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("mode", choices=["baseline", "fixed", "race", "payout-baseline", "payout-fixed"])
parser.add_argument("checkout", type=Path)
parser.add_argument("--go", default="go")
args = parser.parse_args()
root = args.checkout.absolute()
actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
if actual != FIX:
    raise SystemExit("Expected implementation commit " + FIX)
if subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip():
    raise SystemExit("Use a clean implementation checkout; this script does not alter it")
env = os.environ.copy()
env.update(GOTOOLCHAIN="local", GOPROXY="off", GOSUMDB="off", GOMAXPROCS="2", GOFLAGS="-p=2")
with tempfile.TemporaryDirectory(prefix="x402-close-accounting-") as directory:
    replacements = {}

    def replace(relative, saved):
        for checkout in [root, root.resolve()]:
            replacements[str(checkout / relative)] = str(saved)

    def from_commit(name, commit):
        relative = PACKAGE / name
        saved = Path(directory) / name
        saved.write_bytes(subprocess.check_output(["git", "show", commit + ":" + relative.as_posix()], cwd=root))
        replace(relative, saved)

    if args.mode in ["baseline", "payout-baseline"]:
        commit = BASE if args.mode == "baseline" else FIRST
        for name in ["seal.go", "scheme.go", "responses.go", "types.go", "scheme_flow.go"]:
            from_commit(name, commit)
        for name in ["seal_test.go", "seal_accounting_test.go"]:
            from_commit(name, FIRST)
    if args.mode.startswith("payout-"):
        probe = Path(__file__).resolve().parent / "sweep_refund_regression_test.go"
        replace(PACKAGE / "attribution_regression_probe_test.go", probe)
    command = [args.go, "test", "-count=1"]
    if replacements:
        overlay = Path(directory) / "overlay.json"
        overlay.write_text(json.dumps({"Replace": replacements}))
        command += ["-overlay=" + str(overlay)]
    if args.mode == "race":
        command += ["-race", "-cover", "./mechanisms/svm/batch-settlement/..."]
    else:
        test = "TestSweepRefundPayoutAttribution" if args.mode.startswith("payout-") else "TestBatchSettlementSeal"
        command += ["-v", "./mechanisms/svm/batch-settlement/facilitator", "-run", "^" + test + "$"]
    print("Running", args.mode, "with implementation", actual, flush=True)
    result = subprocess.run(command, cwd=root / "go", env=env)
    sys.exit(result.returncode)
