#!/usr/bin/env python3
"""Replay with existing cached dependencies; no installations or network downloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import io
import tempfile

BASE = "dbe1080ac7f65e2e05cc8430a834c255a6800828"
p = argparse.ArgumentParser()
p.add_argument("--checkout", type=Path, required=True)
p.add_argument("--baseline-snapshot", type=Path, help="optional existing pinned snapshot for partial clones; every file is hash-verified")
p.add_argument("--node", type=Path, required=True)
p.add_argument("--go", type=Path, required=True)
p.add_argument("--esbuild", type=Path, required=True, help="existing esbuild lib/main.js")
p.add_argument("--output", type=Path, required=True)
p.add_argument("--queue", type=Path, help="optional shared with-test-slot.py")
a = p.parse_args()
here = Path(__file__).resolve().parent
a.checkout = a.checkout.resolve()
a.output = a.output.resolve()
a.output.mkdir(parents=True, exist_ok=False)
env = dict(os.environ, GOMAXPROCS="2", GOFLAGS="-p=2", CGO_ENABLED="0", GOPROXY="off", GOTOOLCHAIN="local", GIT_NO_LAZY_FETCH="1")
env["PATH"] = str(a.node.parent) + os.pathsep + env.get("PATH", "")

def run(args, cwd, log, expected=0, additions=None, queued=True):
    cmd = [str(x) for x in args]
    if queued and a.queue:
        cmd = [os.sys.executable, str(a.queue)] + cmd
    with (a.output / log).open("w") as f:
        result = subprocess.run(cmd, cwd=cwd, env=dict(env, **(additions or {})), stdout=f, stderr=subprocess.STDOUT)
    if result.returncode != expected:
        raise SystemExit(f"{log}: expected exit {expected}, got {result.returncode}")

for line in (here / "source-sha256.txt").read_text().splitlines():
    digest, relative = line.split("  ", 1)
    if hashlib.sha256((a.checkout / relative).read_bytes()).hexdigest() != digest:
        raise SystemExit(f"Implementation source mismatch: {relative}")

with tempfile.TemporaryDirectory(prefix="x402-managed-replay-") as directory:
    work = Path(directory)
    baseline = work / "baseline"
    baseline.mkdir()
    manifest = json.loads((here / "baseline-manifest.json").read_text())
    assert manifest["revision"] == BASE
    if a.baseline_snapshot:
        stream = None
    else:
        blobs = subprocess.check_output(["git", "cat-file", "--batch"], input="".join(entry["blob"]+"\n" for entry in manifest["files"]).encode(), cwd=a.checkout, env=env)
        stream = io.BytesIO(blobs)
    for entry in manifest["files"]:
        if a.baseline_snapshot:
            data = (a.baseline_snapshot / entry["path"]).read_bytes()
        else:
            header = stream.readline().decode().split()
            if len(header) != 3:
                raise SystemExit("Pinned objects unavailable; provide --baseline-snapshot. No downloads attempted.")
            oid, kind, size = header
            assert oid == entry["blob"] and kind == "blob"
            data = stream.read(int(size))
            assert stream.read(1) == b"\n"
        assert hashlib.sha256(data).hexdigest() == entry["sha256"], entry["path"]
        assert hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() == entry["blob"]
        destination = baseline / entry["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    uncorrected = work / "uncorrected"
    shutil.copytree(baseline / "typescript", uncorrected / "typescript")
    run(["git", "apply", str(here / "harness/uncorrected-implementation.patch")], uncorrected, "apply-uncorrected.log", queued=False)
    evm_rel = Path("typescript/packages/mechanisms/evm")
    deps = a.checkout / evm_rel / "node_modules"
    (work / "node_modules").symlink_to(deps, target_is_directory=True)
    for source in [baseline, uncorrected]:
        for package in [evm_rel, Path("typescript/packages/core")]:
            (source / package / "node_modules").symlink_to(a.checkout / package / "node_modules", target_is_directory=True)
    fixture = baseline / "go/mechanisms/evm/batch-settlement/facilitator/managed_typescript_probe_test.go"
    shutil.copy2(here / "harness/managed_typescript_probe_test.go", fixture)
    scenarios = [
        ("baseline", baseline, "baseline", "missing-capability-reproduced", 0),
        ("fixed", a.checkout, "fixed", "implemented-control-passed", 0),
        ("early-abort-before", uncorrected, "early-abort", "ordinary-lifecycle-passed", 1),
        ("early-abort-after", a.checkout, "early-abort", "ordinary-lifecycle-passed", 0),
        ("signer-failure-before", uncorrected, "signer-failure", "ordinary-signer-failure-passed", 1),
        ("signer-failure-after", a.checkout, "signer-failure", "ordinary-signer-failure-passed", 0),
    ]
    for label, source, template, marker, expected in scenarios:
        entry = work / (label + ".mts")
        entry.write_text((here / "harness" / (template + ".mts")).read_text().replace("__SOURCE_ROOT__", str(source)))
        script = work / (label + ".mjs")
        bundle = work / (label + "-bundle.mjs")
        bundle.write_text("import {build} from " + json.dumps(a.esbuild.resolve().as_uri()) + ";\nawait build(" + json.dumps({"entryPoints":[str(entry)],"outfile":str(script),"bundle":True,"platform":"node","format":"esm","target":"es2022","external":["viem","viem/*","zod","zod/*"],"alias":{f"@x402/core/{part}":str(source / "typescript/packages/core/src" / part / "index.ts") for part in ["server","http","types","client"]}}) + ");\n")
        run([a.node, bundle], work, label + "-bundle.log")
        result_path = a.output / (label + ".json")
        run([a.go,"test","-mod=readonly","-p","2","-count=1","-v","-run","^TestTypeScriptManagedCustodyProbe$","./mechanisms/evm/batch-settlement/facilitator"], baseline / "go", label + ".log", expected=expected, additions={"X402_PROBE_NODE":str(a.node),"X402_PROBE_SCRIPT":str(script),"X402_PROBE_RESULT":marker,"X402_EVIDENCE_OUTPUT":str(result_path)})
        result = json.loads(result_path.read_text())
        if "held" in result:
            assert result["held"] == bool(expected), result
            assert result["calls"] == {"verify":1,"settle":0 if expected else 1}, result
    # Same final regression source, differing only in the production modules loaded.
    shutil.copy2(here / "harness/managed.test.ts", uncorrected / evm_rel / "test/unit/batch-settlement/managed.test.ts")
    for label, source, expected in [("regressions-before", uncorrected, 1),("regressions-after", a.checkout, 0)]:
        config = work / (label + ".config.mts")
        core = source / "typescript/packages/core/src"
        config.write_text("export default " + json.dumps({"cacheDir":str(work / (label+"-cache")),"resolve":{"alias":{f"@x402/core/{part}":str(core / part / "index.ts") for part in ["server","http","types","client"]}},"test":{"maxWorkers":2,"minWorkers":1}}) + ";\n")
        result_path = a.output / (label + ".json")
        run([a.node,deps / "vitest/vitest.mjs","run","test/unit/batch-settlement/managed.test.ts","--config",config,"--maxWorkers","2","--reporter=json","--outputFile",result_path], source / evm_rel, label + ".log", expected=expected)
        result=json.loads(result_path.read_text())
        assert result["numTotalTests"] == 28, result
        assert result["numFailedTests"] == (11 if expected else 0), result
print("Six loopback scenarios and identical baseline/fix regressions passed their assertions.")
