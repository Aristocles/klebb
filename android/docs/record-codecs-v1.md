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

Thirty-seven record types are implemented: `StepsRecord`, `WeightRecord`,
`BodyFatRecord`, `BodyWaterMassRecord`, `BoneMassRecord`, `LeanBodyMassRecord`,
`HeightRecord`, `HeartRateVariabilityRmssdRecord`, `RespiratoryRateRecord`,
`RestingHeartRateRecord`, `BasalMetabolicRateRecord`, `BasalBodyTemperatureRecord`,
`BodyTemperatureRecord`, `BloodGlucoseRecord`, `BloodPressureRecord`,
`OxygenSaturationRecord`, `Vo2MaxRecord`, `HeartRateRecord`, `SpeedRecord`,
`PowerRecord`, `StepsCadenceRecord`, `CyclingPedalingCadenceRecord`,
`ActiveCaloriesBurnedRecord`, `TotalCaloriesBurnedRecord`, `DistanceRecord`,
`ElevationGainedRecord`, `FloorsClimbedRecord`, `HydrationRecord`,
`WheelchairPushesRecord`, `MenstruationPeriodRecord`, `MindfulnessSessionRecord`,
`ActivityIntensityRecord`, `CervicalMucusRecord`, `IntermenstrualBleedingRecord`,
`MenstruationFlowRecord`, `OvulationTestRecord` and `SexualActivityRecord`.
The immutable `supportedRecordTypes` registry
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
| BasalMetabolicRate | `metadata`, `time`, `zoneOffset`, `basalMetabolicRate` |
| BasalBodyTemperature, BodyTemperature | `metadata`, `time`, `zoneOffset`, `temperature`, `measurementLocation` |
| BloodGlucose | `metadata`, `time`, `zoneOffset`, `level`, `specimenSource`, `mealType`, `relationToMeal` |
| BloodPressure | `metadata`, `time`, `zoneOffset`, `systolic`, `diastolic`, `bodyPosition`, `measurementLocation` |
| OxygenSaturation | `metadata`, `time`, `zoneOffset`, `percentage` |
| Vo2Max | `metadata`, `time`, `zoneOffset`, `vo2MillilitersPerMinuteKilogram`, `measurementMethod` |
| HeartRate, Speed, Power, StepsCadence, CyclingPedalingCadence | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `samples` |
| HeartRate sample | `time`, `beatsPerMinute` |
| Speed sample | `time`, `speed` |
| Power sample | `time`, `power` |
| StepsCadence sample | `time`, `rate` |
| CyclingPedalingCadence sample | `time`, `revolutionsPerMinute` |
| ActiveCaloriesBurned, TotalCaloriesBurned | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `energy` |
| Distance | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `distance` |
| ElevationGained | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `elevation` |
| FloorsClimbed | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `floors` |
| Hydration | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `volume` |
| WheelchairPushes | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `count` |
| MenstruationPeriod | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset` |
| MindfulnessSession | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `mindfulnessSessionType`, `title`, `notes` |
| ActivityIntensity | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `activityIntensityType` |
| CervicalMucus | `metadata`, `time`, `zoneOffset`, `appearance`, `sensation` |
| IntermenstrualBleeding | `metadata`, `time`, `zoneOffset` |
| MenstruationFlow, OvulationTest, SexualActivity | `metadata`, `time`, `zoneOffset`, respectively `flow`, `result`, `protectionUsed` |
| Metadata | `recordingMethod`, `id`, `dataOrigin`, `lastModifiedTime`, `clientRecordId`, `clientRecordVersion`, `device` |
| DataOrigin | `packageName` |
| Device, when present | `type`, `manufacturer`, `model` |
| Mass | `{unit:"kg", value:"…", sdkUnitValues:{g:"…", kg:"…", mg:"…", ug:"…", oz:"…", lb:"…"}}` |
| Length | `{unit:"m", value:"…", sdkUnitValues:{m:"…", km:"…", mi:"…", in:"…", ft:"…"}}` |
| Percentage | `{unit:"percent", value:"…", sdkUnitValues:{percent:"…"}}` |
| Power | `{unit:"W", value:"…", sdkUnitValues:{W:"…", "kcal/day":"…"}}` |
| Temperature | `{unit:"degC", value:"…", sdkUnitValues:{degC:"…", degF:"…"}}` |
| BloodGlucose unit | `{unit:"mmol/L", value:"…", sdkUnitValues:{"mmol/L":"…", "mg/dL":"…"}}` |
| Pressure | `{unit:"mmHg", value:"…", sdkUnitValues:{mmHg:"…"}}` |
| Velocity | `{unit:"m/s", value:"…", sdkUnitValues:{"m/s":"…", "km/h":"…", "mi/h":"…"}}` |
| Energy | `{unit:"kcal", value:"…", sdkUnitValues:{cal:"…", kcal:"…", J:"…", kJ:"…"}}` |
| Volume | `{unit:"L", value:"…", sdkUnitValues:{L:"…", mL:"…", "fl. oz (US)":"…"}}` |

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
Float64, as are the other exposed measurement-unit getters, `heartRateVariabilityMillis`,
`rate`, `revolutionsPerMinute`, `floors` and `vo2MillilitersPerMinuteKilogram`.

Series retain every sample in its exposed list order, including equal
timestamps, identical repeated entries and an empty list. No sorting,
deduplication, averaging or gap filling occurs. The returned JSON String
holds no live reference to the caller's list. Sample time uses the same
nanosecond instant contract; start and end offsets remain independent.
Heart-rate sample values remain Long strings and both cadence fields
retain their distinct SDK names and Float64 observations.

Speed preserves every Velocity getter. For example, the pinned SDK observes
`1.25` m/s, `4.5` km/h and `2.7961681281335005` mi/h from a 4.5 km/h input.
Its mph factor is `0.447040357632`; an idealised rounded physical factor
would change a public observation. Power samples reuse both rate
observations rather than being converted into session energy.

Flat interval records retain the same ordered metadata/time/offset prefix.
MenstruationPeriod has no extra measurement field; its interval is still
complete data. Mindfulness preserves null and empty title/notes separately,
including Unicode and controls. Mindfulness and ActivityIntensity enum
observations remain numeric Int32; zero is a value, not a missing state.
Floors remain Float64 strings and wheelchair pushes remain Long strings.

Reproductive instant records retain the ordered metadata/time/nullable-offset
prefix. CervicalMucus preserves `appearance` then `sensation`; MenstruationFlow,
OvulationTest and SexualActivity preserve `flow`, `result` and `protectionUsed`
respectively as numeric Int32 observations, including unfamiliar values.
IntermenstrualBleeding has no additional measurement field: its metadata and
instant are complete data, without an invented zero, unit or quantity.

Energy retains calories, kilocalories, joules and kilojoules. For example,
123.125 kcal exposes `515155.0000811884` J and `515.1550000811884` kJ.
Volume retains litres, millilitres and US fluid ounces; 0.625 L exposes
`21.133763876006686` US fluid ounces. The exact pinned public getters are
preserved without substituting a physical conversion constant or claiming
the original private unit factory. Canonical kcal and L labels describe
the serializer's primary value, not an original input unit.

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
The unit encodings preserve observations rather than guessing a
private original factory. Other measurement field names follow the SDK,
so HRV remains milliseconds and resting heart rate remains beats per minute.

Power, Temperature and BloodGlucose retain both public observations even
when the alternative source factory leaves a conversion residual.
For example, 2000.25 kcal/day observes `96.86395828147499` watts,
98.6 Fahrenheit observes `36.99999999999999` Celsius, and 101.5 mg/dL
observes `5.638888888888888` mmol/L. These are the pinned SDK's public
values, without substitution of an ideal physical conversion factor.
Each pressure retains its exposed mmHg value. Specific measurement-location,
specimen, meal, body-position and method enums remain numeric Int32,
including unfamiliar values.

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

`UnitInstantRecordCodecsTest` adds twelve fixed checks for the next seven
classes, three alternative-unit/null/enum cases, supplemental specific
enums, 37 record getters and eight unit getters, the immutable seventeen-type
registry, and all ten earlier golden JSON byte strings. Its compiling
baseline runs 42 affected tests: ten new record cases visibly refuse,
three registry assertions fail, and the other 29 checks pass. Only the
registry-only expected sets deliberately expand from ten to seventeen
before mapping; all earlier output and refusal expectations stay fixed.
The expected values are reused independent literals, not encoder output.

`SampleSeriesRecordCodecsTest` adds twelve fixed checks for the five
series classes: ten complete records, 30 record getters, ten nested sample
getters, five unit getters, the exact twenty-two-type registry and all
seventeen earlier golden JSON byte strings. Both pinned inventories and
actual compiled generic `getSamples` return types are checked; erased List
identity alone cannot verify the nested Sample class. Its compiling
baseline executes 54 affected tests: ten new record cases visibly refuse,
four registry assertions fail, and the other 40 checks pass. The original
seventeen output strings pass before mapping. Only registry expected sets
expand from seventeen to twenty-two; all fixture values stay fixed through
green, including caller-list mutation after encoding.

`FlatIntervalRecordCodecsTest` adds sixteen fixed checks for ten classes:
ten primary outputs, null/empty/opaque enums, constructor-limited Long
counts, one-nanosecond intervals, direct SDK unit literals, 61 record
getters, twelve unit getters, the exact thirty-two-type registry and all
twenty-two earlier golden byte strings. The compiling baseline executes
70 affected checks: thirteen output cases visibly refuse, five registry
assertions fail and the other 52 pass. The direct SDK check bypasses the
mapper and decimal helper and passes before mapping, as do all twenty-two
earlier strings. Fixed literals and the earlier expectations remain unchanged.
Both inventories agree on the nine stable classes and units; stable 1.1.0
has no ActivityIntensity, whose six getters are present on alpha.

`ReproductiveInstantRecordCodecsTest` adds twelve independently fixed checks:
five primary records, five supplemental null/empty/opaque-enum cases,
twenty public record getters on both pins, the exact thirty-seven-type
registry and all thirty-two earlier golden JSON byte strings. The compiling
baseline executes 82 checks: ten typed `unsupported-record` refusals, six
registry failures and 66 passing checks. Each new case completes its real
SDK constructor and direct getters before the codec refusal; all earlier
strings pass. The fixed output literals remain unchanged through mapping.
After the five adapters were added, the unchanged six-class run passed 82/82
checks with zero failures, errors or skips. All thirty-two earlier strings
passed unchanged. These observations establish JVM construction and encoding,
without proving
native provider validation, availability or permission behaviour.

The selected production SDK remains 1.2.0-alpha06 without an upgrade.
ActivityIntensity is alpha-only; successful JVM construction and encoding
does not prove native `FEATURE_ACTIVITY_INTENSITY`, permission or provider
availability. Mindfulness and ActivityIntensity tests expose unknown enum
9014 and 9001 in the SDK's older-platform constructor branch. Native branches
may refuse other inputs. Wheelchair constructors on that branch accept
counts from zero through 1,000,000 and reject negative/maximum-Long inputs;
such constructor refusal is separate from the signed Long primitive
helper's full precision or a codec's unsupported-record result.

BloodPressure and Vo2Max SDK constructors include Android version guards.
JVM tests exercise their older-platform branch and do not prove native
Android 17 provider availability. Such availability and signed device
checks remain separate evidence.

These slices establish pure serialization for thirty-seven ordinary types. The
remaining ordinary catalogue, complete-page/checkpoint transactions,
encrypted Room queue, chunking, process death, migrations, purges and
signed native update checks remain AND-03 gates. This code reads no
Health Connect history, stages no batch and sends no data. Series encoding
does not truncate lists to satisfy a wire limit or implement record chunking.
