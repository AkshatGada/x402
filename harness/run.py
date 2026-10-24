#!/usr/bin/env python3
"""Run the recorded synthetic regression suite; never install dependencies."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

BASE = "4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54"
FIX = "4c444151ba0defa92c66d8fcab378d4484c2ea08"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("mode", choices=["baseline", "fixed", "race"])
parser.add_argument("checkout", type=Path)
parser.add_argument("--go", default="go")
args = parser.parse_args()
root = args.checkout.absolute()
actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
if actual != FIX:
    raise SystemExit("Expected the recorded implementation commit: " + FIX)
if subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip():
    raise SystemExit("Use a clean implementation checkout; this script does not alter it")
env = os.environ.copy()
env.update(GOTOOLCHAIN="local", GOPROXY="off", GOSUMDB="off", GOMAXPROCS="2", GOFLAGS="-p=2")
with tempfile.TemporaryDirectory(prefix="x402-close-accounting-") as directory:
    command = [args.go, "test", "-count=1"]
    if args.mode == "race":
        command += ["-race", "-cover", "./mechanisms/svm/batch-settlement/..."]
    else:
        command += ["-v"]
        if args.mode == "baseline":
            replacements = {}
            for name in ["seal.go", "scheme.go", "responses.go", "types.go"]:
                relative = Path("go/mechanisms/svm/batch-settlement/facilitator") / name
                saved = Path(directory) / name
                saved.write_bytes(subprocess.check_output(["git", "show", BASE + ":" + relative.as_posix()], cwd=root))
                # Cover both logical and physical paths on macOS (/tmp aliases).
                for checkout in [root, root.resolve()]:
                    replacements[str(checkout / relative)] = str(saved)
            overlay = Path(directory) / "overlay.json"
            overlay.write_text(json.dumps({"Replace": replacements}))
            command += ["-overlay=" + str(overlay)]
        command += ["./mechanisms/svm/batch-settlement/facilitator", "-run", "^TestBatchSettlementSeal$"]
    print("Running", args.mode, "against", actual, flush=True)
    result = subprocess.run(command, cwd=root / "go", env=env)
    sys.exit(result.returncode)
