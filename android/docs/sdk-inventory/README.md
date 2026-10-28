# Compiled Health Connect coverage

These inventories inspect the actual pinned AndroidX artifacts, rather than
assuming that the public record catalogue describes the dependency in the APK.
They describe exposed fields and APIs; they do not establish phone availability,
permission grants or implemented serializers.

Stable `connect-client:1.1.0` contains 41 concrete ordinary record classes.
Pinned `connect-client:1.2.0-alpha06` contains 42. Both include body water mass
and cycling pedalling cadence. Alpha adds `ActivityIntensityRecord`,
`ExerciseSegment.weight`, `ExerciseSegment.setIndex`,
`ExerciseSegment.rateOfPerceivedExertion` and
`ExerciseSessionRecord.rateOfPerceivedExertion`. No ordinary record or
source-visible getter was removed in this comparison.

Both pins expose `PlannedExerciseSessionRecord.hasExplicitTime()` and
`ChangesResponse.hasMore()` as boolean Kotlin property getters with explicit
Java names. The structured inventory includes `get`, `is` and `has` accessors:
454 in stable and 464 in alpha. Omitting `has` loses the planned session's
explicit-time field and the changes response's pagination field.

The alpha dependency preserves the possibility of capturing activity intensity
and richer exercise fields when the provider exposes them. Stable-only capture
could not preserve those fields. Its AAR requires compile SDK 37 and minimum
AGP 9.1.0; stable requires compile SDK 36 and minimum AGP 8.9.1. The application
uses a separately pinned build toolchain compatible with SDK 37.

Each `*-inventory.json` records artifact and compiled-class SHA-256, concrete
record names and public source-field getters under their actual public
declaring class. Stable has 178 public selected classes and alpha has 180.
The raw selected class lists contain 187 and 189 classes respectively,
including nine non-public nested unit classes retained for inspection.
Their public instance methods are not public fields on the enclosing unit.
For example, `Mass$Type.getGramsPerUnit()` is not a getter on public `Mass`.
Each `*-public-api.txt` preserves
public constructors, getters and constants for record models, nested samples,
metadata, units, routes and medical resources, plus request, response, change,
aggregate, permission, feature and route-consent APIs. These raw signatures
also retain public members of the selected non-public classes; declaring
class visibility determines inclusion in the structured source-field list.
Java signatures do not
express Kotlin nullability; serializer work must preserve optional fields using
the Kotlin API and source annotations. Unit getters expose the SDK's available
representations, not an inaccessible producer input unit.
The `artifactDigest` and `compiledClassesDigest` values use the standard
`sha256:<64 hexadecimal characters>` form to identify the algorithm alongside
the checksum. Input verification still compares the exact pinned SHA-256.

## Repeat the inventory

Download both AARs from their `sourceUrl` in the inventory JSON. With JDK 17
and PowerShell available, run from the repository root:

```powershell
./android/tools/inventory-sdk.ps1 `
  -StableAar /path/to/connect-client-1.1.0.aar `
  -AlphaAar /path/to/connect-client-1.2.0-alpha06.aar
```

The script accepts `-JavaHome` (defaults to `JAVA_HOME`, then PATH) and
`-OutputRoot` (defaults to `android/build/sdk-inventory`). It verifies both
pinned complete AAR checksums before creating outputs, extracts only
`classes.jar`, and runs `jar tf` and `javap -public -constants`. The JSON and
text outputs omit machine paths and observation times. The `cache/` directory
is temporary build material and is excluded from this checked-in inventory.
Class lists use ordinal ordering and retain public nested models, including
route locations, series samples and sleep stages. Synthetic-name filtering is
case-sensitive so uppercase nested model names cannot be mistaken for
lowercase compiler helper names.

Run the independent coverage assertions against regenerated outputs:

```powershell
./android/tools/check-inventory.ps1 -InventoryRoot ./android/build/sdk-inventory
./android/tools/test-inventory-ownership.ps1
./android/tools/check-inventory-ownership.ps1 -InventoryRoot ./android/build/sdk-inventory
```

The assertions use fixed SDK contract expectations for ordinary record counts,
body water, cycling cadence, VO2 max, all six route-location fields,
the route data wrapper, heart-rate samples, sleep stages and alpha-only
activity intensity and exercise fields. They check each nested field's exact
name and exposed Java type, plus both shared boolean `has` properties. They
are registered in Android CI and fail on an inventory that omits uppercase
nested models or those nonstandard property getters. Getter matching is
case-sensitive so `hashCode()` is not mistaken for a `has` property; exact
accessor counts also guard against including unrelated methods.

The separate ownership check reads complete public declaration blocks from
the raw compiled signatures and compares every structured accessor's owner,
method and return type. It also verifies the actual public class count.
Fixed positive and negative fixtures cover a non-public class between two
public classes, a getter attributed to the wrong public owner, missing or
duplicate fields, static methods and a selected-class count used as the
public count. Negative cases exercise each pinned version independently.
Both these fixtures and the ownership check run in Android CI.

The text inventories have exact comparisons in CI. JSON inventories have
semantic comparisons because PowerShell versions can format equivalent JSON
differently; field names, values, array ordering and complete content must agree.

## Routes and medical feasibility

The compiled route API distinguishes `Data`, `NoData` and `ConsentRequired`,
and exposes `ExerciseRouteRequestContract` and `READ_EXERCISE_ROUTES`.
Route locations retain time, latitude, longitude, horizontal/vertical accuracy
and altitude. The consent contract takes a native session ID and returns a
nullable route; a null result does not distinguish refusal from no route.
Third-party routes require foreground user action; background ordinary sync
cannot establish route completeness. The route adapter and actual consent/read
checks remain separate delivery work.

Medical models expose original FHIR text, versions, resources and data sources,
with paged read APIs, twelve separate read permissions and the experimental
`FEATURE_PERSONAL_HEALTH_RECORD` flag. Available medical APIs need their own
complete readable-scope reconciliation; the SDK does not provide a
fitness-style medical changes stream.
Medical identities retain data-source ID, FHIR resource type and FHIR resource
ID. Exact `FhirResource.data`, source provenance and FHIR version must survive
capture. Compiled presence does not establish permission or provider support.

The separate native investigations follow the official
[route consent guidance](https://developer.android.com/health-and-fitness/health-connect/features/exercise-routes),
[medical read APIs](https://developer.android.com/health-and-fitness/health-connect/medical-records/read-data)
and [feature availability checks](https://developer.android.com/health-and-fitness/health-connect/features/availability).

Background, extended history, skin temperature, mindfulness, planned exercise,
activity intensity, extended device types, exercise improvements and medical
each have feature checks. Compiled presence is not runtime availability.
Observed unavailable-state handling requires the actual provider response.
No signed installation, package registration, permission, sensitive consent,
background operation or native record read is passed by this inventory.
