# SPDX-License-Identifier: AGPL-3.0-only
"""One clean API35 AOSP emulator attempt; explicit serial, original native output retained."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

phase = sys.argv[1]
assert phase in ("baseline-f21", "final-seven")
repo = Path.cwd().resolve()
sdk = Path(os.environ["ANDROID_HOME"]).resolve()
adb = sdk / "platform-tools/adb"
emulator = sdk / "emulator/emulator"
serial = "emulator-5580"
evidence = repo / "android/build/queue-native-evidence"
evidence.mkdir(parents=True, exist_ok=False)
methods = [
    "F21_exactBytesSurviveRoomCloseAndReopen",
    "F22_ciphertextAndTagControlsRefuseWithoutChangingAnyRow",
    "F23_rowAndStreamRelocationRefuseWithoutChangingAnyRow",
    "F24_missingRealAliasNeverCreatesReplacementOrChangesRows",
    "F25_activatedEncryptionFailurePreservesEncryptedCursorAndAllRows",
    "F26_nativeKeyPolicyRandomIVsAndExistingKeyRetention",
    "F27_populatedNativeArtifactsAndDiagnosticsContainNoPlaintextFields",
]
selected = methods[:1] if phase == "baseline-f21" else methods
unit_methods = {"SW01_original_exact_encrypt_output", "SW02_original_exact_decrypt_output",
                "SW03_all_original_five_authentication_mutations_refuse"}
class_name = "app.klebb.companion.queue.QueueStorageInstrumentedTest"
paths = [repo / "android/app/build.gradle.kts", repo / "android/app/gradle.lockfile",
         repo / ".github/workflows/android-queue-native.yml", repo / "android/tools/run-queue-native.py"]
paths += sorted((repo / "android/app/src/main/java/app/klebb/companion/queue").glob("*"))
paths += sorted((repo / "android/app/src/test/java/app/klebb/companion/queue").glob("*"))
paths += sorted((repo / "android/app/src/androidTest/java/app/klebb/companion/queue").glob("*"))
paths += [repo / "android/app/src/androidTest/assets/queue-storage-inputs-v1.json"]
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
snapshot = lambda: {str(p.relative_to(repo)): sha(p) for p in paths}
before = snapshot()
if phase == "baseline-f21":
    assert os.environ["GITHUB_EVENT_NAME"] == "push"
    assert os.environ["GITHUB_REF"] == "refs/heads/feat/811-health-queue-storage"
    assert before["android/app/src/main/java/app/klebb/companion/queue/EncryptedBlobStore.kt"] == "a57496a4518d90442b2b47d9d40d43d27c85a1813dc3042d09dcc7cb6ee22563"
(evidence / "source-before.json").write_text(json.dumps(before, indent=2) + "\n")

# Save each real child's native exit before interpreting its output or archiving it.
def run(name, argv, timeout=60, cwd=repo, allow_failure=False):
    with (evidence / (name + ".stdout")).open("xb") as out, (evidence / (name + ".stderr")).open("xb") as err:
        started = time.time()
        process = subprocess.Popen(argv, cwd=cwd, stdout=out, stderr=err)
        (evidence / (name + ".running.json")).write_text(json.dumps({"argv": argv, "pid": process.pid, "started": started}))
        expired = False
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            expired = True
            process.kill()
            code = process.wait()
        native = {"pid": process.pid, "exit": code, "timedOut": expired, "seconds": time.time() - started}
        (evidence / (name + ".native.json")).write_text(json.dumps(native) + "\n")
    if not allow_failure and (code != 0 or expired):
        raise RuntimeError("Native tooling failure: " + name)
    return native, (evidence / (name + ".stdout")).read_text(errors="replace")

def targeted(name, *args, timeout=60, allow_failure=False):
    return run(name, [str(adb), "-s", serial, *args], timeout=timeout, allow_failure=allow_failure)

boot = None
boot_log = None
try:
    _, checkout = run("checkout", ["git", "show", "--no-patch", "--format=%H%n%T%n%P", "HEAD"])
    (evidence / "tested-source.json").write_text(json.dumps({"phase": phase, "checkout": checkout.splitlines(),
        "adbSha256": sha(adb), "emulatorSha256": sha(emulator), "scope": "API35 AOSP emulator, not phone/hardware/release proof"}, indent=2) + "\n")
    tools = sdk / "cmdline-tools/16111833"
    assert "Pkg.Revision=23.0" in (tools / "source.properties").read_text()
    cli = tools / "bin/android"
    (evidence / "command-line-tools.json").write_text(json.dumps({"archiveId": "16111833", "package": "23.0",
        "cliSha256": sha(cli), "sourcePropertiesSha256": sha(tools / "source.properties")}) + "\n")
    run("cli-version", [str(cli), "--version"])
    _, emulator_version = run("emulator-version", [str(emulator), "-version"])
    assert emulator_version.splitlines()[0] == "Android emulator version 37.2.12.0 (build_id 16428233) (CL:N/A)"
    assert sha(emulator) == "27e9a8cbd545529ba2c1aca973e5bc060f50b36a68d2c03296b0162291a16b83"
    _, adb_version = run("adb-version", [str(adb), "version"])
    assert "37.0.1" in adb_version
    run("java-version", ["java", "-version"])
    run("acceleration", [str(emulator), "-accel-check"])
    run("build", ["./gradlew", "--no-daemon", ":app:testDebugUnitTest", "--tests",
        "app.klebb.companion.queue.QueueGcmEnvelopeTest", ":app:assembleDebug", ":app:assembleDebugAndroidTest"],
        timeout=1200, cwd=repo / "android")
    unit_xml = repo / "android/app/build/test-results/testDebugUnitTest/TEST-app.klebb.companion.queue.QueueGcmEnvelopeTest.xml"
    unit = ET.parse(unit_xml).getroot()
    assert len(unit.findall("testcase")) == 3
    assert {case.attrib["name"] for case in unit.findall("testcase")} == unit_methods
    assert not unit.findall(".//failure") and not unit.findall(".//error") and not unit.findall(".//skipped")
    assert snapshot() == before
    # The separately created AVD is fresh, has no snapshots/accounts, and only this serial is used for installation.
    boot_log = (evidence / "emulator.log").open("xb")
    boot = subprocess.Popen([str(emulator), "-avd", "KlebbQueueAosp35", "-port", "5580", "-no-window",
        "-no-audio", "-no-boot-anim", "-no-snapshot", "-wipe-data", "-accel", "on", "-gpu", "swiftshader"],
        stdout=boot_log, stderr=subprocess.STDOUT)
    (evidence / "emulator.running.json").write_text(json.dumps({"pid": boot.pid, "serial": serial}) + "\n")
    targeted("wait-device", "wait-for-device", timeout=240)
    deadline = time.monotonic() + 240
    readiness = []
    while True:
        assert boot.poll() is None
        query = subprocess.run([str(adb), "-s", serial, "shell", "getprop", "sys.boot_completed"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        readiness.append({"exit": query.returncode, "value": query.stdout.decode(errors="replace").strip()})
        if query.returncode == 0 and readiness[-1]["value"] == "1":
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Emulator boot readiness unavailable")
        time.sleep(1)
    (evidence / "boot-readiness.json").write_text(json.dumps(readiness) + "\n")
    _, devices = run("device-list", [str(adb), "devices"])
    assert [line.split() for line in devices.splitlines()[1:] if line.strip()] == [[serial, "device"]]
    for name, prop, expected in [("native-api", "ro.build.version.sdk", "35"),
                                  ("native-abi", "ro.product.cpu.abi", "x86_64"), ("native-emulator", "ro.kernel.qemu", "1")]:
        _, value = targeted(name, "shell", "getprop", prop)
        assert value.strip() == expected
    for package in ["app.klebb.companion", "app.klebb.companion.test"]:
        # AOSP pm path returns 1 for absence. Do not confuse that with adb transport failure.
        # The same remote shell must show a working package-manager anchor and empty target output.
        remote = ("pm path android; anchor=$?; printf '\n__QUEUE_PM_ANCHOR_EXIT__%s\n' \"$anchor\"; "
                  f"pm path {package}; result=$?; printf '\n__QUEUE_PM_TARGET_EXIT__%s\n' \"$result\"")
        name = "absent-" + package
        _, installed = targeted(name, "shell", remote)
        assert (evidence / (name + ".stderr")).read_bytes().strip() == b"", "Transport or package-manager diagnostic"
        absent = re.fullmatch(r"(?:package:[^\r\n]+\r?\n)+\r?\n__QUEUE_PM_ANCHOR_EXIT__0\r?\n"
                              r"\r?\n__QUEUE_PM_TARGET_EXIT__([01])\r?\n", installed)
        assert absent, "Package presence, missing anchor/marker or unexpected remote failure"
    app = repo / "android/app/build/outputs/apk/debug/app-debug.apk"
    test_app = repo / "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
    (evidence / "apk-hashes.json").write_text(json.dumps({"app": sha(app), "test": sha(test_app)}) + "\n")
    targeted("install-app", "install", str(app), timeout=180)
    targeted("install-tests", "install", str(test_app), timeout=180)
    selector = class_name + "#" + methods[0] if phase == "baseline-f21" else class_name
    native, raw = targeted("instrumentation", "shell", "am", "instrument", "-w", "-r", "-e", "class", selector,
        "app.klebb.companion.test/androidx.test.runner.AndroidJUnitRunner", timeout=600, allow_failure=True)
    # Android's adb client exit can be zero even when JUnit failed; retain raw status bundles and parse actual results.
    bundle = {}
    results = []
    for line in raw.splitlines():
        field = re.match(r"INSTRUMENTATION_STATUS: (\w+)=(.*)", line)
        status = re.match(r"INSTRUMENTATION_STATUS_CODE: (-?\d+)", line)
        if field:
            bundle[field[1]] = field[2]
        if status:
            code = int(status[1])
            if "test" in bundle and code != 1:
                results.append({"class": bundle.get("class"), "method": bundle["test"], "status": code,
                                "numtests": bundle.get("numtests"), "stack": bundle.get("stack")})
            bundle = {}
    (evidence / "actual-native-results.json").write_text(json.dumps({"phase": phase, "native": native,
        "expectedMethods": selected, "actual": results, "originalRawPreserved": True}, indent=2) + "\n")
    pull_native, _ = targeted("native-artifacts", "pull", "/sdcard/Android/data/app.klebb.companion/files/queue-foundation-evidence",
        str(evidence / "native-files"), timeout=120, allow_failure=True)
    assert not native["timedOut"] and native["exit"] == 0
    assert len(results) == len(selected) and {r["method"] for r in results} == set(selected)
    assert all(r["class"] == class_name and r["status"] == 0 and r["numtests"] == str(len(selected)) for r in results)
    assert "INSTRUMENTATION_CODE: -1" in raw
    assert re.search(r"OK \(" + str(len(selected)) + r" tests?\)", raw)
    if phase == "final-seven":
        assert pull_native["exit"] == 0 and not pull_native["timedOut"]
        assert list((evidence / "native-files").rglob("inspection.json")), "No actual populated native artifacts archived"
finally:
    after = snapshot()
    (evidence / "source-after.json").write_text(json.dumps(after, indent=2) + "\n")
    if boot is not None:
        subprocess.run([str(adb), "-s", serial, "emu", "kill"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        try:
            boot.wait(timeout=15)
        except subprocess.TimeoutExpired:
            boot.kill()
            boot.wait()
        (evidence / "emulator.native.json").write_text(json.dumps({"pid": boot.pid, "exit": boot.returncode}) + "\n")
    if boot_log is not None:
        boot_log.close()
    assert after == before, "Reviewed source or locked dependencies changed"
