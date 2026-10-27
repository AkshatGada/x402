"""Replay the ordinary amount-simulation matrix without modifying a checkout."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("checkout", type=Path)
parser.add_argument("--baseline", action="store_true")
parser.add_argument("--go", default="go")
args = parser.parse_args()
source = args.checkout.resolve()
fixture = Path(__file__).with_name("settle_simulation_test.go").resolve()
relative = Path("go/mechanisms/evm/upto/facilitator")
base = "dbe1080ac7f65e2e05cc8430a834c255a6800828"
env = dict(
    os.environ,
    GOMAXPROCS="2",
    GOTOOLCHAIN="local",
    GOPROXY="off",
    GOSUMDB="off",
    GOWORK="off",
)
env.setdefault("CGO_ENABLED", "0")
env["GOFLAGS"] = (env.get("GOFLAGS", "") + " -p=2 -mod=readonly").strip()
with tempfile.TemporaryDirectory() as temporary:
    scratch = Path(temporary).resolve()
    replacements = {str(source / relative / fixture.name): str(fixture)}
    if args.baseline:
        original = subprocess.run(
            ["git", "show", base + ":" + str(relative / "permit2.go")],
            cwd=source,
            env=dict(env, GIT_NO_LAZY_FETCH="1"),
            check=True,
            capture_output=True,
        ).stdout
        original_file = scratch / "permit2.go"
        original_file.write_bytes(original)
        replacements[str(source / relative / "permit2.go")] = str(original_file)
    overlay = scratch / "overlay.json"
    overlay.write_text(json.dumps({"Replace": replacements}))
    print(
        json.dumps(
            {
                "mode": "baseline" if args.baseline else "fixed",
                "base": base,
                "fixture_sha256": hashlib.sha256(fixture.read_bytes()).hexdigest(),
            }
        ),
        flush=True,
    )
    result = subprocess.run(
        [
            args.go,
            "test",
            "-overlay",
            str(overlay),
            "-mod=readonly",
            "-p=2",
            "-count=1",
            "-v",
            "-run",
            "^(TestUptoSettleSimulationUsesActualCharge|TestSettleUptoPermit2_PartialAmount)$",
            "./mechanisms/evm/upto/facilitator",
        ],
        cwd=source / "go",
        env=env,
    )
raise SystemExit(result.returncode)
