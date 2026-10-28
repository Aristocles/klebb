# Ordinary record codecs, version 1

`app.klebb.companion.records.RecordCodecs.encode(record)` observes a newly
read SDK record through explicit public getters. It returns immutable
`EncodedRecord` strings: `recordType`, `nativeRecordId`, `recordJson`,
`serializerId: health-connect-record`, `serializerVersion: 1` and
`dataFamily: ordinary`. `toString()` is redacted. A future batch assembler
must embed `recordJson` verbatim as the upsert's `record` object. The shared
protocol's payload digest then hashes the complete original UTF-8
`payloadJson`, not this record alone. Existing record or payload JSON is
never passed back through this encoder for reserialization.

Ten record types are implemented: `StepsRecord`, `WeightRecord`,
`BodyFatRecord`, `BodyWaterMassRecord`, `BoneMassRecord`, `LeanBodyMassRecord`,
`HeightRecord`, `HeartRateVariabilityRmssdRecord`, `RespiratoryRateRecord`
and `RestingHeartRateRecord`. The immutable `supportedRecordTypes` registry
has exactly those entries and has no
card subscription input. Other classes throw `RecordCodecException` with
the fixed code `unsupported-record`, before inspecting their metadata.
An unsupported value throws `unsupported-value`. Neither result means
the SDK or platform is unavailable. No reflection fallback, partially
encoded record or checkpoint success is returned.

## Field and primitive contract

| SDK observation | Version-1 JSON |
|---|---|
| Steps | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `count` |
| Weight | `metadata`, `time`, `zoneOffset`, `weight` |
| BodyFat | `metadata`, `time`, `zoneOffset`, `percentage` |
| BodyWaterMass, BoneMass, LeanBodyMass | `metadata`, `time`, `zoneOffset`, `mass` |
| Height | `metadata`, `time`, `zoneOffset`, `height` |
| HeartRateVariabilityRmssd | `metadata`, `time`, `zoneOffset`, `heartRateVariabilityMillis` |
| RespiratoryRate | `metadata`, `time`, `zoneOffset`, `rate` |
| RestingHeartRate | `metadata`, `time`, `zoneOffset`, `beatsPerMinute` |
| Metadata | `recordingMethod`, `id`, `dataOrigin`, `lastModifiedTime`, `clientRecordId`, `clientRecordVersion`, `device` |
| DataOrigin | `packageName` |
| Device, when present | `type`, `manufacturer`, `model` |
| Mass | `{unit:"kg", value:"…", sdkUnitValues:{g:"…", kg:"…", mg:"…", ug:"…", oz:"…", lb:"…"}}` |
| Length | `{unit:"m", value:"…", sdkUnitValues:{m:"…", km:"…", mi:"…", in:"…", ft:"…"}}` |
| Percentage | `{unit:"percent", value:"…", sdkUnitValues:{percent:"…"}}` |

Source `Long` values use signed base-10 strings without numeric JSON
coercion. `count`, `clientRecordVersion` and `beatsPerMinute` retain that precision.
Native enum fields remain numeric Int32, including unfamiliar values;
they are never relabelled as a known enum or zero.

`LosslessValues.float64` and `float32` start with their native shortest
round-tripping decimal strings. Float32 is formatted before any Double
promotion. Nonzero values with decimal exponent from -6 through 20 use
plain decimal without redundant trailing zeros; other magnitudes retain
the native exponent spelling. Both signed zeros retain `0.0` or `-0.0`.
NaN and infinities refuse. All finite outputs fit the existing shared
256-character decimal bound. The SDK field type, rather than decimal
text alone, distinguishes Float32 from Float64; all Mass getters are
Float64, as are Length, Percentage, `heartRateVariabilityMillis` and `rate`.

All six Mass getter observations are retained separately. In particular,
the SDK's conversion constants can produce rounding differences such as
one pound's microgram observation `453592370.00000006`; storing kilograms
alone could lose another public getter's precision. `unit` is the
serializer's canonical kilograms, not a claim about the source factory.
The SDK does not expose that private factory choice.

Length likewise retains every public unit observation, including the
inches/feet factory residuals. For example, `Length.inches(69.0)` observes
`1.7526` metres and `5.749999999999999` feet. Percentage retains its public
value in percent; no integer rounding or division by 100 is applied.
The three unit encodings preserve observations rather than guessing a
private original factory. Other measurement field names follow the SDK,
so HRV remains milliseconds and resting heart rate remains beats per minute.

Instants use the exact UTC `Instant.toString()` observation, preserving
nanoseconds. Offsets use `ZoneOffset.id`, including seconds where present;
an absent offset stays null instead of being replaced with the phone's
current zone. Null device, null manufacturer/model, null client ID and
empty client ID remain distinct. JSON quoting preserves scalar Unicode
and controls without replacing characters; lone surrogates refuse.

The signed primitive helper accepts the full Long range. The existing
wire contract separately requires native `clientRecordVersion` to be
non-negative, native IDs to have 1–256 Unicode code points, and UTC
instants to use a four-digit year. Values outside those envelope limits
visibly refuse rather than producing a supported envelope that cannot
be accepted. A newly created SDK record's empty pre-insertion ID is not
a captured native identity.

## Verification and remaining gates

`RecordCodecsTest` runs in the normal `:app:testDebugUnitTest` CI task.
The first ten independently fixed cases cover complete Steps/Weight
observations, metadata, null/empty distinctions, nanoseconds, offsets,
Float32/64 precision, negative zero, unknown enums and refusal. Additional
cases cover finite extrema, unit-factory rounding, source quoting and
envelope limits. Test-only Java constructs real SDK Metadata through its
compiled public constructor; production uses public getters only.

Getter coverage compares fixed expected signatures with the pinned SDK
inventory and actual compiled public getters. The pre-implementation run
executed all ten cases against a compiling refusal boundary: nine failed
and the future-class refusal passed.
The original primitive, metadata and Steps/Weight field expectations stay
fixed; the registry-only expected set deliberately expands from two to ten
when adding the next family.

`ScalarRecordCodecsTest` adds twelve independent SDK cases for the eight
new classes, null/unfamiliar metadata, unit-factory residuals, exact getter
coverage and immutable registry. Its baseline runs against the existing
dispatcher: ten new record cases refuse and two registry assertions fail,
while the other seventeen prior checks and the exact original Steps/Weight
JSON byte comparison pass. No mapper generates these expected values.

These slices establish pure serialization for ten ordinary types. The
remaining ordinary catalogue, complete-page/checkpoint transactions,
encrypted Room queue, chunking, process death, migrations, purges and
signed native update checks remain AND-03 gates. This code reads no
Health Connect history, stages no batch and sends no data.
