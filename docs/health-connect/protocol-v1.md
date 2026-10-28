# Health connector content protocol v1

This contract defines bounded, lossless content frames and reproducible wire
fixtures. It does not expose an HTTP endpoint, create credentials, acknowledge
durable storage, prove native capture, or publish a projection. Those behaviours
require the authority and storage slices before a connector can use them.

The structural contract is [protocol-v1.schema.json](../../schemas/health-connect/protocol-v1.schema.json).
The Node entry point is [protocol.js](../../lib/health-connect/protocol.js).
Other languages must consume the same original wire text, byte vectors and
expected outcomes in [protocol-v1.json](../../tests/fixtures/health-connect/protocol-v1.json)
and [adversarial-v1.json](../../tests/fixtures/health-connect/adversarial-v1.json).
These contain invented records and nonfunctional example grants.

## Frames and validation API

Every frame has `version: 1` and one explicit `kind`. Unknown versions, kinds,
envelope fields and change operations are refused rather than silently removed.

| Kind | Meaning | Validation does not establish |
| --- | --- | --- |
| `capabilities` | Supported wire version, categories, serializer identities and limits | An implemented endpoint or permission on the phone |
| `pairing-grant` | Destination, tenant/instance, expiry, grant, approved categories and limits | Browser authority, random generation, expiry enforcement or single use |
| `pairing-exchange` | Grant plus approved namespace/installation echoes and selected categories | Namespace ownership or a connector credential |
| `batch` | Exact immutable payload text and its digest | Persistence, acknowledgement or publication |
| `coverage` | An ordinary-record bounded query and its completeness claim | Native truth or permission to delete absent records |
| `aggregate` | A saved native aggregate observation with policy, revision and provenance | Freshness without a trusted raw frontier |
| `object-part` | A bounded staged part with native/batch binding and exact byte digest | A complete object or acknowledged batch |
| `object-finalise` | A declared ordered manifest for one large batch payload | Existing staged bytes or a completed transaction |
| `error` | Fixed code and retryability | Permission to echo sensitive request contents |

`decodeMessage(input, context)` takes the original uncompressed UTF-8 `Buffer`
or a Unicode scalar string, validates the frame and returns a recursively frozen
transport object. It throws `ProtocolError` with a fixed `code`, the same fixed
`message` and `path: "$"`. Errors contain no copied property names, payloads,
grants, credentials or native cursor values.

`context` can supply narrower `limits`, a trusted `binding`, authorised
`categories`, negotiated `serializers` and trusted per-type `rawFrontiers`.
Omitting authority context only validates content structure. Supplying context
does not authenticate it. An HTTP handler must derive it from server-owned
connector state, never from the received frame.

`payloadDigest(payloadJson)` returns `sha256:<lowercase hexadecimal>` over the
exact UTF-8 encoding of that scalar string. `nativeKey(identity)` validates and
encodes only the four identity components as a JSON array string.

## Exact bytes and immutable batches

The complete digest policy is exact-text hashing, not sorted or normalised JSON:

```text
payloadDigest = "sha256:" + lowercase_hex(SHA256(UTF8(payloadJson)))
```

There is no prefix, trailing newline, Unicode normalisation, key sorting,
number conversion, date conversion or whitespace removal. The bytes are the
decoded `payloadJson` string encoded as UTF-8, not the outer JSON string literal
with its transport escapes. A producer serialises the payload once, computes
the digest once, and durably retains that original text and envelope for retries.
Object key order, array order, spacing, null versus absence, and decimal spelling
are significant. A parser/stringifier round trip must never replace that text.

The outer batch has only `version`, `kind`, `payloadJson` and `payloadDigest`.
The payload includes the entire immutable binding, record type, stream sequence,
batch ID and changes. Thus the digest covers all immutable batch metadata.
HTTP credentials and native pagination/change cursors are excluded from content
frames. Different outer whitespace or JSON escape spelling may transport the
same decoded payload text; this does not change its payload digest.

The byte limit applies to the entire original received outer frame, including
its whitespace, UTF-8 characters and escaped payload string. It does not apply
to JavaScript string length or a reserialised substitute. For example, the
literal payload `{"note":"Ω"}` is 13 UTF-8 bytes.

An existing batch ID/sequence with a different immutable digest is a conflict.
An identical retry must return the previously durable receipt without replaying
effects. Sequence gaps must not advance a frontier. These are storage rules for
CORE-02; this pure validator neither manufactures receipts nor reads a receipt
ledger.

## Identity, precision and serializers

Native identity is exactly
`[tenantId, sourceStoreId, recordType, nativeRecordId]`.
Installation ID, digest, generation and restore epoch are transport state, not
record identity. Equal quantities or content do not establish native identity,
namespace continuity, or deduplication across producers.

The trusted binding also includes instance ID, installation ID, sharing
generation and restore epoch. All present top-level binding fields and full
batch/object bindings must match trusted context. Change identities must match
their batch's tenant, source store and record type. A delete can identify a
previously unseen native record without its producer or original payload; it
remains a source tombstone rather than explicit user deletion.

A source-store namespace must be server-issued or server-bound during authorised
pairing. The exchange's `sourceStoreId` echoes that approved namespace; a client
claim does not grant ownership or permit installation replacement to relabel
saved history. The authority slice must deliver that approved value with its
pairing result and enforce continuity.

Non-negative signed Int64 values use decimal strings with no leading zero and
maximum `9223372036854775807`. Sequences, generations and SDK
`metadata.clientRecordVersion` are examples. There is no invented universal
native record version.

Quantities use finite decimal strings, including fractional/exponent spellings.
Known ordinary quantity wrappers use `{ "value": "75.250", "unit": "kilograms" }`.
SDK floating values must be represented with a decimal spelling that round
trips the original native floating value; their full serializer rules belong
to AND-03. Opaque numeric SDK enums use signed Int32 numbers, including unknown
values. Ordinary Int64 scalar fields must be strings, not JSON numbers.

UTC instants preserve their original nanosecond spelling. This version accepts
four-digit calendar years, valid dates, seconds `00` through `59`, and zero to
nine fractional digits. Offset seconds are separate signed integer fields.
Known ordinary `time`, `startTime`, `endTime` and `lastModifiedTime` leaves are
checked as instants; intervals must be positive at nanosecond precision.
No timestamp is truncated through a millisecond `Date`.

Each upsert declares `serializerId`, `serializerVersion` and `dataFamily`.
It must match a negotiated serializer tuple. The default tuple is
`health-connect-record`, version `1`, family `ordinary`. This supplies scalar,
metadata and bounded opaque-record conventions, not a complete 42-type native
serializer. AND-03 still owns every compiled SDK field and constructor check.
Ordinary records mirror native ID in `record.metadata.id`. Routes and medical
resources retain their own shapes and do not gain invented ordinary metadata.
Their native serializers and feature/permission gates remain AND-06.

`projection: "raw-only"` permits an unknown projection recipe only when the
wire envelope, serializer, identity, operation and authorised category remain
understood. It does not bypass scope or structural validation, or imply chat
and dashboard access. Unknown bounded record members are retained.

## Parser and negotiated limits

Invalid UTF-8, byte-order marks, duplicate object members, escaped duplicate
members and unpaired surrogates are refused. There is no replacement-character
repair or last-member-wins parsing. Only JSON whitespace is allowed. JSON number
tokens with decimal points or exponents are refused before numeric conversion;
integer tokens must be safe integers, and opaque record numbers must fit Int32.
Precise noninteger and Int64 values therefore travel as strings.

The parser checks depth and node budgets before materialising deeper values.
It shares these budgets across the outer frame and parsed inner payload/query.
It decodes individual bounded JSON string tokens; it does not first call
unbounded `JSON.parse` on the complete frame.

| Limit | Hard ceiling | Meaning |
| --- | --- | --- |
| `maxBytes` | 1,048,576 | Original uncompressed outer-frame UTF-8 bytes |
| `maxChanges` | 500 | Upserts/deletes in a batch |
| `maxDepth` | 16 | Value depth; outer root is 1, parsed inner root starts at 2 |
| `maxNodes` | 20,000 | Every parsed value and object member name, including inner text parsing |
| `maxSamples` | 10,000 | Sum of all nested record and query array items, including stages, laps, segments, routes and planned blocks |
| `maxParts` | 128 | Declared parts in a staged object |
| `maxObjectBytes` | 67,108,864 | Declared reconstructed object bytes |

Limits are inclusive and negotiated downward. No unadvertised short string/key
cap truncates opaque text; total bytes, depth and nodes remain bounded. Schema
string lengths count Unicode code points. The large-object ceiling describes
the protocol declaration, not a deployed server's storage or memory capacity.

## Coverage and saved aggregate observations

Both frames preserve the original `queryJson` and its exact-text `filterDigest`.
The query includes record type, window, data origins, history start and native
feature facts, retaining any further bounded predicate fields. Its record type
and exact window must match the outer frame. A future handler must validate the
actual native predicate and provenance against its authorised source and scope;
a matching digest alone does not establish those facts.

`query.historyStart` is the declared earliest readable native SDK history
boundary, a valid instant or explicit null for unlimited history. It is separate
from the user's import-date policy, preserved as the optional valid instant
`query.importStart`. A complete claim cannot begin before a declared readable
history boundary, even if `historyIncludesScope` is true. Partial coverage can
retain that limitation; an unlimited boundary must not be represented by an
invented ancient date.

An ordinary `coverage` complete claim requires finished pages, stable permission,
valid change token, history including the requested scope, a drained changes
barrier, equal permission fingerprints and a trusted durable raw frontier at
least the declared frontier. Partial coverage can preserve failed conjuncts.
These checks reject contradictory claims but do not prove an on-device scan.
Completeness belongs to that bounded source/type/window/filter query. It never
grants whole-source absence deletion. Medical reconciliation requires its own
negotiated coverage semantics in AND-06; ordinary token/barrier booleans are
not evidence for medical completeness.

An aggregate preserves its metric, exact query, revision, policy version,
native provider provenance, origin packages and required raw frontier. An
observation is explicitly `value`, `empty` or `missing`. Only `value` has a
non-null decimal quantity. Observed `"0"` differs from complete `empty` with
null quantity. A `current` observation cannot be missing and requires the trusted
raw frontier. A `lagging` or `blocked` observation must not claim current
publication or advance acknowledgement. Reconciliation remains CORE-03,
projection remains CORE-04, and native aggregate capture remains AND-05.

## Large objects

The staged object is the exact original UTF-8 **whole batch payload JSON** for
a single-upsert batch containing one large complete record.
`objectDigest` becomes that batch's `payloadDigest`; there are no undefined
external record references. Every declaration repeats the full binding, record
type, batch ID, sequence and native identity.

Parts are canonical padded base64, have individual exact-byte digests and
bounded indices/counts. Finalisation declares a dense, ordered manifest of
`{ index, bytes, digest }`; count and summed bytes must match the declaration.
The validator proves these declarations and the received part digest only.
The small `abc` part fixtures exercise that declaration boundary; they are not
valid reconstructed batch payloads or evidence of physical finalisation.

Before a future finalisation can acknowledge a batch, CORE-02 must prove all
staged parts physically exist, agree with that manifest and binding, reconstruct
the exact bytes in order, verify the whole digest and total, and validate the
reconstructed payload and its single upsert. Its payload binding, batch ID,
sequence, type and identity must match the declaration. Storage capacity,
streaming/bounded reconstruction and atomic durable commit are separate gates.
The ordinary 1 MiB `decodeMessage` API does not claim to validate a reconstructed
64 MiB payload. Missing parts cannot become a durable receipt or raw frontier.

## Acceptance boundary and reproducible evidence

Run `node --test tests/health-connect-protocol.test.js`; the suite is also
registered through the normal `tests/*.test.js` npm test pattern. Positive
wire strings and fixed byte/digest vectors were specified independently of the
validator. Independent invalid wire cases keep fixed expected codes. The
initial structural-only baseline accepted unsafe cases; those behavioural red
results preceded enforcement. Regression cases also cover Unicode identifiers,
large opaque text, exact query preservation and native family shapes.

| Prepared cases | Current evidence or remaining owner |
| --- | --- |
| C01–C05 | Complete capabilities, version/scope/raw-only/binding fixtures and validation |
| C06–C08 | Immutable frame/digest and fixed conflict/gap error vocabulary; durable replay and sequence ledger remain CORE-02 |
| C09–C11 | Count/UTF-8 boundaries, understood envelope/serializer and raw-only fixtures |
| C12–C13 | Coverage conjuncts and trusted-frontier aggregate validation; native truth, reconciliation and publication remain CORE-03/CORE-04/AND-05 |
| C14 | Generation/epoch mismatch validation; stop/re-enable authority remains CORE-01 authority slice |
| C15 | Part digest and dense finalisation manifest; physical staging remains CORE-02 |
| C16 | Unseen native deletion identity retained; tombstone durability remains CORE-02 |
| I01–I04 | Four-component keys and namespace separation; server-owned continuity remains authority slice |
| P01–P12 | Complete grant/exchange content examples only; session/origin/single-use/credential/revocation/export authority remains #772/#773 and related parent slices |

Child #771 supplies these content contracts and language-neutral validation
inputs. The authority slice still must add endpoint layout, pairing credential
result, connector list and per-type stream-status result schemas with shared
vectors. Parent CORE-01 A1/A3/A4, Android consumption, device capture, release
and soak acceptance are not completed by this content validator.
