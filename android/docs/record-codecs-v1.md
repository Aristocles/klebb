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

Forty-two record types are declared in the mapper registry: `StepsRecord`, `WeightRecord`,
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
`MenstruationFlowRecord`, `OvulationTestRecord`, `SexualActivityRecord`,
`NutritionRecord`, `SkinTemperatureRecord`, `SleepSessionRecord`,
`ExerciseSessionRecord` and `PlannedExerciseSessionRecord`.
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
| SkinTemperature | `metadata`, `startTime`, `startZoneOffset`, `endTime`, `endZoneOffset`, `deltas`, `baseline`, `measurementLocation` |
| SkinTemperature Delta | `time`, `delta` |
| Metadata | `recordingMethod`, `id`, `dataOrigin`, `lastModifiedTime`, `clientRecordId`, `clientRecordVersion`, `device` |
| DataOrigin | `packageName` |
| Device, when present | `type`, `manufacturer`, `model` |
| Mass | `{unit:"kg", value:"…", sdkUnitValues:{g:"…", kg:"…", mg:"…", ug:"…", oz:"…", lb:"…"}}` |
| Length | `{unit:"m", value:"…", sdkUnitValues:{m:"…", km:"…", mi:"…", in:"…", ft:"…"}}` |
| Percentage | `{unit:"percent", value:"…", sdkUnitValues:{percent:"…"}}` |
| Power | `{unit:"W", value:"…", sdkUnitValues:{W:"…", "kcal/day":"…"}}` |
| Temperature | `{unit:"degC", value:"…", sdkUnitValues:{degC:"…", degF:"…"}}` |
| TemperatureDelta | `{unit:"degC-difference", value:"...", sdkUnitValues:{"degC-difference":"...", "degF-difference":"..."}}` |
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

### Nutrition interval fields and verification

Nutrition preserves all 49 exposed record getters: the five common
interval/metadata fields, 40 nullable Mass nutrients, nullable `energy` and
`energyFromFat`, nullable `name` and numeric Int32 `mealType`. Nutrient keys
retain their fixed field order and explicit nulls. A present zero keeps its
complete unit object; null, zero and an empty name remain distinct. Each Mass
retains all six kg/g/mg/ug/oz/lb observations and each Energy all four
cal/kcal/J/kJ observations, using the existing Float64 decimal policy.
Metadata, nanosecond interval bounds, independently nullable offsets and
quoted/control/Unicode source strings use the unchanged common helpers.
Opaque meal values remain numbers rather than being relabelled.

`NutritionRecordCodecsTest` adds ten independently fixed checks: a complete
meal, every optional field null, all nutrients explicitly zero, empty name
and exposed meal value 9015, seven sparse nutrient records, direct SDK unit
observations, 59 getter signatures and the exact thirty-eight-type registry,
and all thirty-seven earlier golden UTF-8 JSON strings. The compiling
seven-class baseline executed 92 checks: seven output cases refused with
`unsupported-record` after direct SDK preconditions, seven registry checks
failed and the other 78 passed. N08's 248 primary plus 42 sparse getter
observations and N10's 37 earlier strings passed before mapping. After the
explicit adapter, the unchanged 92 checks passed with zero failures, errors
or skips; those direct observations and earlier strings remained exact.

Before mapping, a separate SDK-only observer checked the 59 public getter
signatures and constructed all eleven fixed records on cached SDK 1.1.0 and
1.2.0-alpha06. Each pin matched 538 fixed raw-bit and decimal readings:
248 primary, 42 sparse and 248 present-zero observations. Android stubs
reported `SDK_INT == 0`; the accepted opaque meal value 9015 exercises that
JVM constructor branch. These results establish JVM construction and getter
preservation, without proving native validation, permission, Health Connect
availability or capture. The selected production SDK remains 1.2.0-alpha06.

### Skin temperature intervals and verification

SkinTemperature preserves all eight exposed record getters and both getters
of each timestamped Delta. The interval and metadata use the unchanged common
helpers. Nullable absolute `baseline` retains both `degC` and `degF` observations;
null remains distinct from a present zero. Delta values use `degC-difference`
and `degF-difference` labels and retain both Float64 getter observations. No
absolute Fahrenheit offset or baseline-plus-delta reading is manufactured.

Deltas retain supplied order, repeated timestamps and an empty list. Each
encode snapshots then-exposed values; a later caller-list mutation cannot
change an earlier encoded string. Measurement location remains numeric Int32,
including an exposed opaque value such as 9018, without assigning a known label.

`SkinTemperatureRecordCodecsTest` adds twelve independently fixed checks for
those fields, direct constructor bounds, both pinned inventories and the
selected compiled 14 getter signatures, the exact thirty-nine-type registry
and all thirty-eight prior golden UTF-8 strings. Its selected compiling
baseline ran twelve checks: nine `unsupported-record` failures after SDK
preconditions, one registry mismatch and two passes for ABI and all prior
strings. A separate SDK-only observer matched 14 signatures, 28 unit-factory
getter readings and constructor controls on both cached SDK pins at `SDK_INT == 0`.
These JVM observations do not prove native provider validation or availability.

Native reading still requires provider support for `FEATURE_SKIN_TEMPERATURE`
(feature identifier 2), applicable permission/consent and native validation.
Compiled presence and opaque-value acceptance on the JVM do not establish those
conditions. CORE-06.R0 remains required before personal capture, and signed
native device/update and release checks remain separate parent gates.

### Sleep session fields and verification

SleepSession preserves all eight exposed record getters and all three getters
of each Stage. The unchanged interval and metadata helpers retain exact
nanosecond bounds, independently nullable offsets and complete metadata.
Title and notes retain null, empty and quoted/Unicode strings distinctly.
Stages retain exposed order, start/end instants and numeric Int32 stage values,
including an exposed opaque value. Gaps remain unclassified: no stage, sleep
duration, label or measurement is manufactured. Each encoding copies current
stage values; a later caller-list change cannot alter a previous encoded string.

`SleepSessionRecordCodecsTest` adds ten independently fixed groups: seven
complete/mutation outputs, eight actual constructor-refusal controls, both
pinned 11 typed getter signatures with the immutable forty-type registry,
and all thirty-nine earlier golden UTF-8 strings. Its compiling baseline
ran ten groups: seven `unsupported-record` failures after direct SDK fields,
one registry mismatch after typed ABI checks, and passing constructor-refusal
and all-prior-string controls. Later mutation assertions were not reached
on that baseline. Fixed expected strings remain independent of mapper output.

A separate SDK-only observer checked both cached pins at `SDK_INT == 0`:
seven positive records, eight `IllegalArgumentException` constructor refusals,
16 nested controls and 164 exact getter observations. Both pins retained the
caller stage list, including clear and reversed-replacement observations.
These JVM results do not prove native constructor validation, provider support,
permission/consent or capture. Those gates and CORE-06.R0 remain separate.

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

The explicit registry now declares 42 ordinary adapters, including ExerciseSessionRecord
and PlannedExerciseSessionRecord. The previous 41 golden strings remain unchanged.
This declaration describes mapper support, not 42 observed native types or provider
availability. Complete-page and checkpoint transactions, the encrypted Room queue,
chunking, process death, migrations, purges and signed native update checks remain
AND-03 gates; parent #755 stays open. This code reads no Health Connect history,
stages no batch and sends no data. Series encoding does not truncate lists
to satisfy a wire limit or implement record chunking.

Planned sessions preserve all eleven session fields, complete metadata, nanosecond
times, independently nullable offsets, explicit-time Boolean, opaque numeric values
and ordered blocks, steps and targets. All nine goals and eight targets retain the
existing unit observations and exact Duration seconds/nanoseconds. An unfamiliar
exposed integer remains intact; an unsupported future goal or target refuses the
whole record with unsupported-value and returns no partial JSON. Encoding copies
current values eagerly, so later caller-list changes do not alter returned output.

The controlled native positive profile is O1/O2/O3/N4/O5/O6: 492 independently fixed
getter paths, with all six complete wire strings checked. Original O4 contains
duplicate target types and is rejected by the tested native constructor. Its
original fixture and refusal are retained separately. Native-valid N4 uses Power,
Weight and RPE targets, with 148 getters, ten changed expected entries and a
separate 4,202-byte wire. This is not unchanged original O1-O6 native success.

The future-goal and future-target tests first establish the same healthy O1,
all 138 getters, the 3,962-byte wire and the three retained public caller lists.
Each then verifies its fixed 133-path mutated state before whole-record refusal.
Direct constructor refusal remains distinct from this caller-list boundary; no
raw 266-value negative dump was observed. The tenth controlled method verifies
the unchanged returned wire after clearing each caller-owned list on fresh O1
and N4 records. These observations do not establish a provider read, permission,
FEATURE_PLANNED_EXERCISE availability or capture readiness. Final Android, Node,
browser, CI and review/merge checks remain separate. CORE-06.R0 remains required
before personal-history capture; HAE remains deferred.
