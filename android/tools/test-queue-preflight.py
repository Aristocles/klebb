# SPDX-FileCopyrightText: 2026 Klebb contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""Check queue SDK preflight without installing packages or downloading archives."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest


INSTALL_STEP = "Install pinned official packages into the isolated SDK"
NEXT_STEP = "Require Linux KVM and create one fresh credential-free AOSP target"
PACKAGES = (
    "platform-tools@37.0.1",
    "platforms/android-37.0@2.0.0",
    "build-tools/36.0.0@36.0.0",
)
ARCHIVE_NAME = "emulator-linux_x64-16428233.zip"
ARCHIVE_URL = "https://dl.google.com/android/repository/" + ARCHIVE_NAME
BOUNDARY = b"PREFLIGHT_STUB_CURL_BOUNDARY\n"
PAYLOAD = b"preflight curl stub\n"

STUB_SOURCE = r'''import json, os, pathlib, sys
mode, *argv = sys.argv[1:]
root = pathlib.Path(os.environ["PREFLIGHT_ROOT"])

def owned(value):
    path = pathlib.Path(value)
    if not path.is_absolute() or path == root or not path.resolve().is_relative_to(root):
        raise RuntimeError("Stub output escaped its fixture")
    return path

trace = owned(os.environ["PREFLIGHT_TRACE"])
marker = owned(os.environ["PREFLIGHT_MARKER"])
if mode not in ("installer", "curl"):
    raise RuntimeError("Unexpected stub mode")
with trace.open("ab") as stream:
    stream.write((json.dumps({"tool": mode + "-stub", "argv": argv}) + "\n").encode())
if mode == "installer":
    with marker.open("ab") as stream:
        stream.write((argv[-1] + "\n").encode("ascii"))
    raise SystemExit(0)
output = owned(argv[argv.index("--output") + 1])
output.write_bytes(b"preflight curl stub\n")
sys.stdout.write("PREFLIGHT_STUB_CURL_BOUNDARY\n")
raise SystemExit(79)
'''


def installer_body(workflow):
    raw = workflow.read_bytes()
    start = ("      - name: " + INSTALL_STEP + "\n        run: |\n").encode()
    end = ("      - name: " + NEXT_STEP + "\n").encode()
    if raw.count(start) != 1 or raw.count(end) != 1:
        raise ValueError("Expected exactly one named installer step")
    block = raw.split(start, 1)[1].split(end, 1)[0]
    lines = block.splitlines()
    if not lines or not all(line.startswith(b"          ") for line in lines):
        raise ValueError("Installer step indentation changed")
    body = b"\n".join(line[10:] for line in lines) + b"\n"
    return body


def snapshot(root):
    """Observe entry types, link targets, modes and bytes without following links."""
    rows = {}
    total = 0

    def walk(directory):
        nonlocal total
        for path in sorted(directory.iterdir()):
            info = path.lstat()
            key = path.relative_to(root).as_posix()
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISLNK(info.st_mode):
                rows[key] = ("link", mode, os.readlink(path))
            elif stat.S_ISDIR(info.st_mode):
                rows[key] = ("directory", mode)
                walk(path)
            elif stat.S_ISREG(info.st_mode):
                if info.st_size > 32768:
                    raise ValueError("Fixture file exceeded its bound")
                data = path.read_bytes()
                after = path.lstat()
                if ((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
                        != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
                    raise ValueError("Fixture changed while observed")
                total += len(data)
                rows[key] = ("file", mode, len(data), hashlib.sha256(data).hexdigest())
            else:
                raise ValueError("Unexpected fixture entry type")
            if len(rows) > 64 or total > 131072:
                raise ValueError("Fixture exceeded its bound")

    walk(root)
    return rows


def retain_bytes(path, data):
    with path.open("xb") as stream:
        stream.write(data)


def retain_json(path, value):
    retain_bytes(path, (json.dumps(value, ensure_ascii=True, indent=2) + "\n").encode())


def owned_group_absent(group):
    deadline = time.monotonic() + 5
    while True:
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(0.05, remaining))


def run_installer(body, root, env, evidence):
    process = subprocess.Popen(
        ["/bin/bash", "-e"], cwd=root, env=env, start_new_session=True,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    group, session = os.getpgid(process.pid), os.getsid(process.pid)
    retain_json(evidence / "started.json", {
        "pid": process.pid, "processGroupId": group, "sessionId": session,
        "newOwnedSession": group == process.pid and session == process.pid,
        "startTicks": Path(f"/proc/{process.pid}/stat").read_text().rsplit(")", 1)[1].split()[19],
        "command": ["/bin/bash", "-e"],
    })
    if group != process.pid or session != process.pid:
        raise RuntimeError("Owned session binding refused")
    timed_out = False
    streams_complete = False
    stdout = stderr = b""
    try:
        stdout, stderr = process.communicate(body, timeout=30)
        streams_complete = True
    except subprocess.TimeoutExpired as error:
        timed_out = True
        stdout, stderr = error.output or b"", error.stderr or b""
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            stdout, stderr = process.communicate(timeout=5)
            streams_complete = True
        except subprocess.TimeoutExpired as error:
            stdout = error.output if error.output is not None else stdout
            stderr = error.stderr if error.stderr is not None else stderr
    # Preserve actual native status and raw streams before interpreting case evidence.
    retain_bytes(evidence / "stdout", stdout)
    retain_bytes(evidence / "stderr", stderr)
    retain_json(evidence / "native.json", {
        "pid": process.pid, "exitCode": process.returncode, "timedOut": timed_out,
        "streamsComplete": streams_complete, "executionTimeoutSeconds": 30,
        "reapTimeoutSeconds": 5,
    })
    group_absent = process.returncode is not None and owned_group_absent(process.pid)
    retain_json(evidence / "closure.json", {
        "processGroupId": process.pid, "leaderReaped": process.returncode is not None,
        "groupObservedAbsent": group_absent, "observationTimeoutSeconds": 5,
        "observedMonotonicNs": time.monotonic_ns(),
    })
    return process.returncode, stdout, stderr, timed_out, group_absent and streams_complete


class QueuePreflight(unittest.TestCase):
    body = b""
    receipts = None

    def run(self, result=None):
        self.test_result = result if result is not None else self.defaultTestResult()
        return super().run(self.test_result)

    def check_case(self, case):
        evidence = self.receipts / case
        evidence.mkdir(mode=0o700)
        temporary = tempfile.TemporaryDirectory(prefix="queue-preflight-")
        # All disposal goes through the explicit confinement check below.
        temporary._finalizer.detach()
        root = Path(temporary.name).resolve(strict=True)
        parent = root.parent.resolve(strict=True)
        identity = root.stat()
        child_closed = True
        passed = False
        try:
            if evidence.resolve(strict=True).is_relative_to(root):
                raise RuntimeError("Receipts must be outside the observed fixture")
            runner = root / "runner-temp"
            runner.mkdir()
            sdk = runner / "queue-android-sdk"
            physical_sdk = root / "outside-sdk" if case in (
                "wrong-sdk", "linked-sdk-root",
            ) else sdk
            physical_sdk.mkdir()
            if case == "wrong-sdk":
                sdk = physical_sdk
            elif case == "linked-sdk-root":
                sdk.symlink_to(physical_sdk, target_is_directory=True)
            archive = runner / ARCHIVE_NAME
            if case == "dangling-emulator":
                (sdk / "emulator").symlink_to(root / "absent-emulator-owned")
            elif case == "dangling-archive":
                archive.symlink_to(root / "absent-archive-owned")

            stub_bin = root / "stub-bin"
            stub_bin.mkdir()
            stub = stub_bin / "stub.py"
            stub.write_text(STUB_SOURCE, encoding="utf-8")
            trace = root / "calls.jsonl"
            marker = physical_sdk / "installer-writes.txt"
            trace.write_bytes(b"")
            marker.write_bytes(b"")
            cli = physical_sdk / "cmdline-tools/16111833/bin/android"
            cli.parent.mkdir(parents=True)
            for target, mode in ((cli, "installer"), (stub_bin / "curl", "curl")):
                target.write_text(
                    '#!/bin/sh\nexec "$PREFLIGHT_PYTHON" -I -S -B '
                    '"$PREFLIGHT_STUB" ' + mode + ' "$@"\n',
                    encoding="ascii",
                )
                target.chmod(0o700)
            realpath = stub_bin / "realpath"
            realpath.write_text('#!/bin/sh\nexec /usr/bin/realpath "$@"\n', encoding="ascii")
            realpath.chmod(0o700)
            env = {
                "PATH": str(stub_bin), "LANG": "C", "LC_ALL": "C",
                "RUNNER_TEMP": str(runner), "ANDROID_HOME": str(sdk),
                "PREFLIGHT_ROOT": str(root), "PREFLIGHT_STUB": str(stub),
                "PREFLIGHT_PYTHON": sys.executable,
                "PREFLIGHT_TRACE": str(trace), "PREFLIGHT_MARKER": str(marker),
            }
            retain_json(evidence / "fixture.json", {
                "fixtureRoot": str(root), "callTrace": str(trace), "installerMarker": str(marker),
            })
            before = snapshot(root)
            retain_json(evidence / "before.json", before)
            child_closed = False
            code, stdout, stderr, timed_out, child_closed = run_installer(
                self.body, root, env, evidence,
            )
            call_raw = trace.read_bytes()
            writes = marker.read_bytes()
            retain_bytes(evidence / "calls.raw.jsonl", call_raw)
            retain_bytes(evidence / "installer-writes.raw", writes)
            if not child_closed:
                self.test_result.stop()
                self.fail("Owned process closure unresolved; remaining cases aborted")
            after = snapshot(root)
            retain_json(evidence / "after.json", after)
            calls = [json.loads(line) for line in call_raw.splitlines()]
            delta = sorted(key for key in before.keys() | after.keys()
                           if before.get(key) != after.get(key))
            retain_json(evidence / "observed.json", {
                "exitCode": code, "timedOut": timed_out, "orderedCalls": calls,
                "fixtureContentOrEntryDelta": delta,
            })
            self.assertFalse(timed_out, "Installer exceeded 30 seconds")
            if case != "clean-isolated":
                installer_calls = sum(call["tool"] == "installer-stub" for call in calls)
                curl_calls = sum(call["tool"] == "curl-stub" for call in calls)
                self.assertTrue(
                    code == 1 and stdout == b"" and stderr == b""
                    and calls == [] and writes == b"" and delta == [],
                    f"Unsafe preflight: exit={code}, installer calls={installer_calls}, "
                    f"curl calls={curl_calls}, changed entries={len(delta)}",
                )
                passed = True
                return

            expected_calls = [
                {"tool": "installer-stub", "argv": [
                    "--sdk=" + str(sdk), "sdk", "--ignore-outdated-xmls", "install", package,
                ]} for package in PACKAGES
            ] + [{"tool": "curl-stub", "argv": [
                "--fail", "--location", "--silent", "--show-error",
                "--max-time", "600", "--max-filesize", "349654171",
                "--output", str(archive), ARCHIVE_URL,
            ]}]
            self.assertTrue(code == 79 and stdout == BOUNDARY and stderr == b"",
                            "Clean preflight did not reach the deliberate curl boundary")
            self.assertTrue(calls == expected_calls, "Package order or curl flags changed")
            self.assertTrue(writes == "".join(p + "\n" for p in PACKAGES).encode("ascii"),
                            "Installer side effects changed")
            self.assertTrue(archive.read_bytes() == PAYLOAD, "Stub archive payload changed")
            expected_delta = sorted(path.relative_to(root).as_posix()
                                    for path in (trace, marker, archive))
            self.assertTrue(delta == expected_delta, "Unexpected clean fixture mutation")
            passed = True
        finally:
            if not child_closed:
                self.test_result.stop()
            retain_json(evidence / "result.json", {
                "contractPassed": passed, "ownedClosureProved": child_closed,
                "fixtureDisposition": "cleanup-eligible" if passed and child_closed else "retained",
            })
            if passed and child_closed:
                current = root.lstat()
                if (not stat.S_ISDIR(current.st_mode)
                        or Path(temporary.name).resolve(strict=True) != root
                        or root.resolve(strict=True) != root
                        or root == parent or not root.is_relative_to(parent)
                        or (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino)):
                    raise RuntimeError("Refusing cleanup outside the original owned fixture")
                temporary.cleanup()
                retain_json(evidence / "cleanup.json", {"confinedFixtureRemoved": True})

    def test_wrong_sdk(self):
        self.check_case("wrong-sdk")

    def test_linked_sdk_root(self):
        self.check_case("linked-sdk-root")

    def test_dangling_emulator(self):
        self.check_case("dangling-emulator")

    def test_dangling_archive(self):
        self.check_case("dangling-archive")

    def test_clean_isolated(self):
        self.check_case("clean-isolated")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workflow", type=Path,
        default=Path(__file__).resolve().parents[2] / ".github/workflows/android-queue-native.yml",
    )
    parser.add_argument("--receipts", type=Path, help="Fresh directory for retained case evidence")
    args = parser.parse_args()
    QueuePreflight.body = installer_body(args.workflow)
    if args.receipts is None:
        QueuePreflight.receipts = Path(tempfile.mkdtemp(prefix="queue-preflight-receipts-")).resolve()
    else:
        args.receipts.mkdir(mode=0o700)
        QueuePreflight.receipts = args.receipts.resolve(strict=True)
    suite = unittest.TestSuite(QueuePreflight(name) for name in (
        "test_wrong_sdk", "test_linked_sdk_root", "test_dangling_emulator",
        "test_dangling_archive", "test_clean_isolated",
    ))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
