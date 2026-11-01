tl;dr: Exercise sessions preserve their complete SDK data. Route payloads require explicit authority bound to the actual native record; provider permission and capture readiness remain separate gates.

# Exercise session serialization

`RecordCodecs` includes `ExerciseSessionRecord` and `PlannedExerciseSessionRecord` in its immutable 42-type registry. The previous 41 encodings and their golden JSON stay unchanged. A planned-session ID on an Exercise record remains an opaque value. Registry membership does not establish provider availability or route authority; see the [planned-session constructor and codec limits](../../android/docs/record-codecs-v1.md).

The codec preserves complete metadata, nanosecond intervals and offsets, nullable title and notes, ordered segments and laps, numeric exercise and segment values, optional public unit observations, and the shortest exact Float32 exertion representation. It copies nested lists eagerly, so later mutation of caller-owned segment, lap or route lists does not change earlier encodings. It preserves order and repeated values without sorting, deduplication or filling gaps.

| SDK route result | Encoding and authority |
| --- | --- |
| `NoData` | The distinct `NoData` variant, with no route payload. |
| `ConsentRequired` | The distinct `ConsentRequired` variant, with no route payload. |
| `Data` | The `Data` variant and complete ordered locations, only with matching explicit authority. An empty location list remains `Data` with an empty list. |

`encode(record)` uses `ExerciseRoutePayloadAuthority.DENY`. A null authority also denies route payload access. For a `Data` result, the explicit overload requires `ForRecord` to match both `record.metadata.id` and `record.metadata.dataOrigin.packageName`. A denied or mismatched authority, or an unknown route-result subclass, throws bounded `ExerciseRouteRefused` for the whole record before reading route locations. It emits no partial record or route payload in the refusal.

`ForRecord` binds the serialization request to SDK metadata; it does not obtain or prove native route consent. The future Android capture flow must complete the required foreground Health Connect consent before supplying that authority. User selection, a route-presence hint and registry membership supply no native permission or availability evidence.

Authorized locations preserve time, latitude, longitude, horizontal accuracy, vertical accuracy and altitude, including nullable measurements and every public Length observation. Actual phone constructors, provider reads, third-party route consent, denial/revocation, encrypted queue lifecycle and the release checks remain completion gates under #827, #755 and AND-06. See the Health Connect programme tracker for their current status.
