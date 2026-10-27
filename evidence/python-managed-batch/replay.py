#!/usr/bin/env python3
"""Replay synthetic proof with existing dependencies and caches; no downloads."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

p = argparse.ArgumentParser()
p.add_argument("--checkout", type=Path, required=True)
p.add_argument("--python", type=Path, required=True, help="existing approved Python environment")
p.add_argument("--go", type=Path, required=True)
p.add_argument("--python-baseline", type=Path, help="existing pinned baseline/python for partial clones")
p.add_argument("--go-baseline", type=Path, help="existing pinned Go source for partial clones")
p.add_argument("--queue", type=Path, help="shared with-test-slot.py if other checks are running")
p.add_argument("--output", type=Path, required=True)
a = p.parse_args()
if bool(a.python_baseline) != bool(a.go_baseline):
    p.error("Provide both baseline snapshot directories, or neither")
here = Path(__file__).resolve().parent
a.checkout = a.checkout.resolve()
a.python = a.python.absolute()  # Preserve the virtualenv executable symlink.
a.go = a.go.resolve()
a.output = a.output.resolve()
a.output.mkdir(parents=True, exist_ok=False)
meta = json.loads((here / "IMPLEMENTATION.json").read_text())
env = dict(os.environ, GIT_NO_LAZY_FETCH="1", PYTHONDONTWRITEBYTECODE="1", GOPROXY="off", GOTOOLCHAIN="local", CGO_ENABLED="0", GOMAXPROCS="2", GOFLAGS="-p=2")
assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=a.checkout, text=True).strip() == meta["implementation_commit"]
for line in (here / "source-sha256.txt").read_text().splitlines():
    digest, relative = line.split("  ", 1)
    assert hashlib.sha256((a.checkout / relative).read_bytes()).hexdigest() == digest, relative
records = []

def run(label, args, cwd, expected=0, settings=None):
    command = [str(x) for x in args]
    if a.queue:
        command = [sys.executable, str(a.queue)] + command
    with (a.output / (label + ".log")).open("w") as log:
        result = subprocess.run(command, cwd=cwd, env=dict(env, **(settings or {})), stdout=log, stderr=subprocess.STDOUT)
    records.append({"label": label, "command": command, "cwd": str(cwd), "env": settings or {}, "exit": result.returncode, "expected_exit": expected})
    (a.output / "commands.json").write_text(json.dumps(records, indent=2) + "\n")
    assert result.returncode == expected, (label, result.returncode, expected)

with tempfile.TemporaryDirectory(prefix="x402-python-managed-replay-") as directory:
    work = Path(directory)
    baseline = work / "baseline"
    baseline.mkdir()
    manifest = json.loads((here / "baseline-manifest.json").read_text())
    assert manifest["revision"] == meta["upstream_revision"]
    stream = None
    if not a.python_baseline:
        raw = subprocess.check_output(["git", "cat-file", "--batch"], input="".join(x["git_blob"]+"\n" for x in manifest["files"]).encode(), cwd=a.checkout, env=env)
        stream = io.BytesIO(raw)
    for entry in manifest["files"]:
        relative = entry["path"]
        assert not relative.startswith("/") and ".." not in Path(relative).parts
        if a.python_baseline:
            source = a.go_baseline / relative[3:] if relative.startswith("go/") else a.python_baseline / relative[len("python/"):]
            data = source.read_bytes()
        else:
            header = stream.readline().decode().split()
            if len(header) != 3:
                raise SystemExit("Pinned Git objects unavailable; provide existing baseline snapshots. No download attempted.")
            oid, kind, size = header
            assert oid == entry["git_blob"] and kind == "blob"
            data = stream.read(int(size))
            assert stream.read(1) == b"\n"
        assert hashlib.sha256(data).hexdigest() == entry["sha256"], relative
        assert hashlib.sha1(b"blob "+str(len(data)).encode()+b"\0"+data).hexdigest() == entry["git_blob"], relative
        destination = baseline / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    uncorrected = work / "uncorrected"
    shutil.copytree(baseline / "python", uncorrected / "python")
    patch = here / "harness/uncorrected-implementation.patch"
    assert hashlib.sha256(patch.read_bytes()).hexdigest() == "8acdb8bfb46714ae70f0d78eb59fa0a710a14b074ac0c95b112e64ecee0d5fd2"
    subprocess.run(["git", "apply", "--include=python/*", str(patch)], cwd=uncorrected, env=env, check=True)
    fixture = baseline / "go/mechanisms/evm/batch-settlement/facilitator/managed_python_probe_test.go"
    shutil.copy2(here / "harness/managed_python_probe_test.go", fixture)
    # Import binding is asserted before pytest in the same process.
    wrapper = work / "pytest-origin.py"
    wrapper.write_text("""from pathlib import Path
import hashlib,json,os,sys
root=Path(os.environ['X402_AUDIT_SOURCE_ROOT']).resolve()
sys.path.insert(0,str(root/'python'))
sys.path.insert(0,os.environ['X402_REPLAY_HARNESS'])
import x402,x402.server
import x402.mechanisms.evm.batch_settlement.server.scheme as scheme
import pytest
modules=[x402,x402.server,scheme]
for module in modules:assert Path(module.__file__).resolve().is_relative_to(root),module.__file__
print(json.dumps({'source':str(root),'modules':{m.__name__:{'path':m.__file__,'sha256':hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest()} for m in modules}}))
if os.environ.get('X402_EXPECT_MISSING_CONFIG')=='1':
 try:scheme.BatchSettlementEvmSchemeServerConfig(voucher_store_mode='facilitator')
 except TypeError:print('managed-configuration-missing-on-pinned-upstream')
 else:raise AssertionError('Unexpected baseline managed configuration')
raise SystemExit(pytest.main(['-p','no:cacheprovider','--import-mode=importlib','-q',*sys.argv[1:]]))
""")
    h = here / "harness"
    test_cases = [
        ("upstream-missing-feature", baseline, [h / "baseline-tests"], 1, "17 failed, 28 passed", "1"),
        ("correction-before", uncorrected, [h / "test_managed_recovery.py"], 1, "30 failed, 8 passed", "0"),
        ("correction-after", a.checkout, [h / "test_managed_recovery.py"], 0, "38 passed", "0"),
        ("independent-before", uncorrected, [h / "test_audit_lifecycle.py", h / "test_audit_extended.py"], 1, "64 failed, 18 passed", "0"),
        ("independent-after", a.checkout, [h / "test_audit_lifecycle.py", h / "test_audit_extended.py"], 0, "82 passed", "0"),
    ]
    for label, source, tests, expected, summary, missing in test_cases:
        run(label, [a.python, wrapper, *tests], work, expected, {"X402_AUDIT_SOURCE_ROOT": str(source), "X402_REPLAY_HARNESS": str(h), "X402_EXPECT_MISSING_CONFIG": missing, "PYTHONPATH": str(source / "python")})
        assert summary in (a.output / (label + ".log")).read_text(), label
    scenarios = [
        ("go-signer-before", uncorrected, "go-signer-controlled.py", "signer-outage-reproduced", "0"),
        ("go-signer-after", a.checkout, "go-signer-controlled.py", "signer-outage-fixed", "1"),
        ("go-zero-salt", a.checkout, "go-zero-salt-probe.py", "zero-salt-passed", "1"),
        ("go-full-flow", a.checkout, "go-http-probe.py", "managed-custody-passed", "1"),
    ]
    for label, source, script, marker, fixed in scenarios:
        run(label, [a.go, "test", "-mod=readonly", "-p", "2", "-count=1", "-v", "-run", "^TestPythonManagedCustodyProbe$", "./mechanisms/evm/batch-settlement/facilitator"], baseline / "go", settings={"X402_PROBE_PYTHON": str(a.python), "X402_PROBE_SCRIPT": str(h / script), "X402_PROBE_RESULT": marker, "X402_AUDIT_SOURCE_ROOT": str(source), "X402_EXPECT_SIGNER_FIX": fixed, "PYTHONPATH": str(source / "python")})
        assert marker in (a.output / (label + ".log")).read_text(), label
print("Five source-bound test comparisons and four actual-Go loopback scenarios verified.")
