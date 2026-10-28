# Android Health Connect feasibility

This module is the AND-01 platform proof. It reads selected, invented steps
and weight written by Google's Health Connect Toolbox in an explicit UTC
interval of at most two hours. It filters requests to the Toolbox producer.
It has no network or Health Connect write permission. It does not pair with
Cloud, save readings, import personal history or schedule background work.

The reusable companion remains gated on a release-signed native install,
controlled read and same-key update on the actual phone. A build, unit test or
compiled feature flag cannot pass that gate. Other categories, queues,
serializers, routes and medical ingestion belong to the following tickets.

## Pinned build

| Component | Version |
|---|---|
| Java | JDK 17 |
| Android Gradle Plugin | 9.4.1, built-in Kotlin |
| Gradle wrapper | 9.6.0, official distribution SHA-256 pinned |
| Compile/target SDK | 37.0 / 37 |
| Minimum SDK | 28; actual provider availability checked at runtime |
| Build tools | 36.0.0 |
| Health Connect | 1.2.0-alpha06 |
| Activity | 1.11.0 |
| Coroutines Android | 1.10.2 |
| Unit tests | JUnit 4.13.2 |

The actual alpha AAR requires compile SDK 37 and at least AGP 9.1.0. AGP 9.4.1
supports API 37. Stable Health Connect 1.1.0 omits Activity Intensity and newer
exercise fields. The alpha is pinned for inventory completeness; its presence
does not establish native availability or implemented capture. Compare the
[compiled inventory](docs/sdk-inventory/README.md) before changing the SDK.

Set `JAVA_HOME` and `ANDROID_HOME` to external tooling directories. Install
`platforms;android-37.0`, `build-tools;36.0.0` and platform tools, accepting the
Android SDK licences. Command-line tools 23's direct CLI uses
`platforms/android-37.0@2.0.0` instead of the older sdkmanager package spelling.
Keep local SDK paths in ignored `local.properties` if needed.

From `android/`:

```powershell
./gradlew.bat --no-daemon clean :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

On Linux/macOS use `./gradlew`. The Android workflow runs those same checks.
The core repository also requires `npm test` and `npm run test:e2e`.
Dependency locks cover the resolved app configurations.

## External release signing

Use one protected release key for both proof versions and subsequent updates.
Keep its recoverable backup outside the checkout. Losing the key prevents
same-package updates; never replace it with a debug key. These four environment
variables are required by `validateSigningRelease`:

| Variable | Meaning |
|---|---|
| `KLEBB_SIGNING_STORE` | Absolute external keystore path |
| `KLEBB_SIGNING_STORE_PASSWORD` | Keystore password |
| `KLEBB_SIGNING_ALIAS` | Existing release alias |
| `KLEBB_SIGNING_KEY_PASSWORD` | Private-key password |

Load passwords from your local secret store into this process. Do not put them
in source, Gradle properties, command arguments, CI logs or an APK download.
Release signing fails closed when the variables or keystore are missing.
Debug builds are solely development artifacts.

```powershell
./gradlew.bat --no-daemon clean :app:testDebugUnitTest :app:lintDebug :app:assembleRelease '-PproofVersionCode=1' '-PproofVersionName=0.1.0-proof'
```

Copy `app/build/outputs/apk/release/app-release.apk` to a separate artifact
directory. Build the update with the same four variables and
`'-PproofVersionCode=2' '-PproofVersionName=0.1.1-proof'`, then copy that APK.
Verify both using the pinned build tools:

```powershell
& "$env:ANDROID_HOME/build-tools/36.0.0/apksigner.bat" verify --verbose --print-certs "<proof.apk>"
& "$env:ANDROID_HOME/build-tools/36.0.0/aapt2.exe" dump badging "<proof.apk>"
Get-FileHash -Algorithm SHA256 -LiteralPath "<proof.apk>"
```

The package must be `app.klebb.companion`, the version codes must increase,
and the SHA-256 signing certificate fingerprint must agree. The SHA-256 APK
checksums identify the exact native-test artifacts. Verify a second clean
build before recording repeatability; do not infer phone installation.

## Controlled phone check

Use the release-signed proof and update APKs, not the debug build. Keep this
ticket open until native results are recorded. These steps need the actual
supported phone; an emulator does not establish Samsung/runtime support.

A1. Install Google's [Health Connect Toolbox](https://goo.gle/health-connect-toolbox)
from its official download. Grant its selected write permissions in Health
Connect. The inspected Toolbox 2.3.5 producer is
`androidx.health.connect.client.devtool`. Create one invented steps record
with count 1234 and one weight record with value 75.25 kg in a known recent
ten-minute interval. Record the exact UTC times and expected values independently.
Do not use personal readings for this experiment.

A2. Install the signed version-code 1 APK with Android's installation
confirmation, or enable USB debugging and run `adb install "<proof.apk>"`.
If Android or Samsung blocks the install, record the exact observed screen
and package response before changing settings. Record phone/OS/One UI,
Health Connect provider, Toolbox and watch versions.

A3. Open Klebb feasibility. Select Steps and Weight, request permissions and
grant only Steps. Set the UTC interval to surround the controlled records
(at most two hours, ending in the past). Read: expect the 1234-step record
from the Toolbox, no weight call and no personal producer readings.
Grant Weight separately and repeat: expect the 75.25 kg record. Zero records,
denial and access failure stay pending; they are not successful native reads.

A4. Copy runtime evidence, which excludes the health values. Separately
record the controlled expected/actual values. Check the displayed background,
history, intensity, exercise and medical feature states. The optional
permission buttons request only their own grant when available. They do not
prove background scheduling or access to older history. Revoke Steps and
repeat to establish that revoked categories are not read. Leave the app during
a read, then return; results should clear and collection remain foreground.

A5. Record the update marker, install the version-code 2 APK using Android
confirmation or `adb install -r "<update.apk>"`, then reopen. Expect the same
package and marker, higher app version, retained category permissions and a
successful controlled read. Do not uninstall between versions. Record any
Health Connect package-registration or distribution restriction actually
encountered.

A6. Report the exact APK checksums and certificate, phone/provider versions,
expected/actual observations, available/unavailable features and any failed
experiment. Remove invented records through the Toolbox when finished.
Routes and medical consent/read remain separate AND-06 gates. Personal-history
capture still requires the merged CORE-06.R0 recovery proof.

## Rollout boundary

This directory is excluded from the webapp container context. A core main
merge still runs the existing image publish and demo deployment triggers.
This proof does not promote a Cloud image or publish the marketing website.
The final release, real 48-hour/two-night soak and website are later milestones.
