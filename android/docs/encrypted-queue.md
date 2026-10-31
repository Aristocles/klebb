# Encrypted blob storage foundation

This disconnected foundation belongs to #811 / AND-03. It does not read Health
Connect, advance a provider checkpoint, upload a batch or enable capture. The
storage API seals exact bytes before a Room insert transaction and uses ABORT
rather than overwriting an existing row. Reads authenticate the stored binding
and return copied plaintext only after successful decryption.

The initial Room schema has one immutable `queue_blobs` table. Its clear fields
are opaque local row/stream IDs, generic payload/cursor/state kind, envelope
version, nonce, encrypted bytes and envelope size. Health record content,
provider IDs, category, times, digests and sensitive operational state belong
inside the encrypted bytes. Callers must create opaque local routing IDs.
The DAO uses insertion with ABORT; no pending row is implicitly replaced.

A missing row returns `Ok(null)` without a key lookup. Unknown versions and
malformed kind/nonce/tag/size fields block without modifying stored ciphertext.
Authentication failures share `corrupt-queue` / `authentication-failed`; key
unavailability uses `key-unavailable` / `key-unavailable`. Encryption refusal
occurs before any transaction, while a native insert or duplicate refusal uses
`queue-unavailable` / `storage-failed`. Blocked results contain no payload or
exception diagnostics. This storage API does not advance a cursor/checkpoint.

The version-1 authenticated data is compact UTF-8 JSON:

```text
["klebb-health-queue-v1",1,blobKind,rowId,localStreamId]
```

Android Keystore creates a non-exportable AES-256 key with randomized GCM
encryption. Production encryption accepts the provider's fresh 12-byte IV and
uses a 16-byte authentication tag. The software all-zero key/IV is only the
independent test vector. Ciphertext/tag mutation and row/stream relocation
cannot reveal which input changed; both must refuse with the same payload-free
authentication result while preserving stored ciphertext.

Key creation is an explicit empty-database operation. Reads only look up the
existing alias. An absent key with retained rows must block; creating another
key is not recovery. Reinstall, signed update, backup transfer, interrupted
migration, hardware Keystore and process death need their own later evidence.

Room runtime/compiler 2.8.4 uses Java annotation processing. No KSP or KAPT
plugin/task is configured. Room's compiler transitively includes the KSP symbol
API on annotation-processor classpaths; this does not enable a KSP pipeline.
JUnit 4.13.2 stays configured, with Android runner 1.7.0 and extension 1.3.0.

The dedicated CI workflow builds the three software checks and requires all
seven native checks on branch pushes, PRs and main, targeting only a fresh API35
AOSP x86_64 emulator at `emulator-5580`. The runner retains the restricted
fail-closed baseline mode and its original failing evidence. The test target
package is the ordinary debug package and must never be installed over the
user's release app to obtain these checks.

The isolated installer uses the official Linux emulator 37.2.12.0 archive,
build 16428233, with SHA-256
`b08fc43d8608d2955f607f1b287beb525041e730086bdca3af152accac3af9c1`.
It verifies the checksum before extraction and requires the original version,
build and binary identity. A setup mismatch stops before any queue check.

Native checks retain original process exits, instrumentation status bundles,
APK hashes and populated encrypted DB/WAL artifacts. A build or tooling failure
does not establish the behavioral baseline. Emulator results do not prove
Samsung hardware security, native provider availability or release readiness.
The full parent queue/checkpoint/chunk/migration/purge contract and CORE-06.R0
remain required before personal-history capture.
