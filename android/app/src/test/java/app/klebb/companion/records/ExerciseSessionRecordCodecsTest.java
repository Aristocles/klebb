// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records;

import androidx.health.connect.client.records.ExerciseLap;
import androidx.health.connect.client.records.ExerciseRoute;
import androidx.health.connect.client.records.ExerciseRouteResult;
import androidx.health.connect.client.records.ExerciseSegment;
import androidx.health.connect.client.records.ExerciseSessionRecord;
import androidx.health.connect.client.records.metadata.Metadata;
import androidx.health.connect.client.units.Length;
import androidx.health.connect.client.units.Mass;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.AbstractList;
import java.util.Collections;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public final class ExerciseSessionRecordCodecsTest {
    private static Instant time(String value) { return Instant.parse(value); }

    // Actual SDK inputs are separate from the independently fixed output resource.
    private static ExerciseSessionRecord fullNoData() {
        return new ExerciseSessionRecord(
            time("2001-10-28T00:30:00.123456789Z"), ZoneOffset.of("+02:00"),
            time("2001-10-28T02:30:00.987654321Z"), ZoneOffset.of("+01:00"),
            NativeMetadataFixture.full(), 0, "Synthetic \"session\" \u0394",
            "Line one\nLine two \ud83d\ude42", Arrays.asList(
                new ExerciseSegment(time("2001-10-28T00:35:00.000000001Z"),
                    time("2001-10-28T00:40:00.123456789Z"), 1, 9,
                    Mass.grams(6250.0), 0, 6.5f),
                new ExerciseSegment(time("2001-10-28T00:40:00.123456789Z"),
                    time("2001-10-28T00:45:00.987654321Z"), 44, 0, null, null, null),
                new ExerciseSegment(time("2001-10-28T00:45:00.987654321Z"),
                    time("2001-10-28T00:50:00.000000001Z"), 1, 10,
                    Mass.grams(12500.0), 0, 7.25f)), Arrays.asList(
                new ExerciseLap(time("2001-10-28T00:30:00.123456789Z"),
                    time("2001-10-28T01:30:00.123456789Z"), Length.meters(500.125)),
                new ExerciseLap(time("2001-10-28T01:30:00.123456789Z"),
                    time("2001-10-28T02:30:00.987654321Z"), null)),
            new ExerciseRouteResult.NoData(), "synthetic-planned-id", 6.5f);
    }

    private static void observe(ExerciseSessionRecord record) {
        observeFull(record, Float.valueOf(6.5f));
    }

    private static void observeFull(ExerciseSessionRecord record, Float expectedSessionExertion) {
        assertEquals("actual selected JVM fallback", 0, android.os.Build.VERSION.SDK_INT);
        assertEquals("2001-10-28T00:30:00.123456789Z", record.getStartTime().toString());
        assertEquals("+02:00", record.getStartZoneOffset().toString());
        assertEquals("2001-10-28T02:30:00.987654321Z", record.getEndTime().toString());
        assertEquals("+01:00", record.getEndZoneOffset().toString());
        assertEquals(0, record.getExerciseType());
        assertEquals("Synthetic \"session\" \u0394", record.getTitle());
        assertEquals("Line one\nLine two \ud83d\ude42", record.getNotes());
        assertEquals("synthetic-planned-id", record.getPlannedExerciseSessionId());
        assertEquals(expectedSessionExertion, record.getRateOfPerceivedExertion());
        assertEquals(ExerciseRouteResult.NoData.class, record.getExerciseRouteResult().getClass());
        Metadata metadata = record.getMetadata();
        assertEquals(2, metadata.getRecordingMethod());
        assertEquals("synthetic-provider-id", metadata.getId());
        assertEquals("org.example.synthetic.producer", metadata.getDataOrigin().getPackageName());
        assertEquals("2001-10-29T03:04:05.987654321Z", metadata.getLastModifiedTime().toString());
        assertEquals("synthetic-client-id/\u03b1\n\"quoted\"", metadata.getClientRecordId());
        assertEquals(9007199254740993L, metadata.getClientRecordVersion());
        assertNotNull(metadata.getDevice());
        assertEquals(1, metadata.getDevice().getType());
        assertEquals("Synthetic maker", metadata.getDevice().getManufacturer());
        assertEquals("Synthetic model \u0394", metadata.getDevice().getModel());
        String[] starts = {"2001-10-28T00:35:00.000000001Z",
            "2001-10-28T00:40:00.123456789Z", "2001-10-28T00:45:00.987654321Z"};
        String[] ends = {"2001-10-28T00:40:00.123456789Z",
            "2001-10-28T00:45:00.987654321Z", "2001-10-28T00:50:00.000000001Z"};
        int[] types = {1, 44, 1}, repetitions = {9, 0, 10};
        Double[] grams = {6250.0, null, 12500.0};
        Integer[] indexes = {0, null, 0};
        Float[] exertions = {6.5f, null, 7.25f};
        assertEquals(3, record.getSegments().size());
        for (int i = 0; i < 3; i++) {
            ExerciseSegment segment = record.getSegments().get(i);
            assertEquals(starts[i], segment.getStartTime().toString());
            assertEquals(ends[i], segment.getEndTime().toString());
            assertEquals(types[i], segment.getSegmentType());
            assertEquals(repetitions[i], segment.getRepetitions());
            assertEquals(grams[i], segment.getWeight() == null ? null :
                Double.valueOf(segment.getWeight().getGrams()));
            assertEquals(indexes[i], segment.getSetIndex());
            assertEquals(exertions[i], segment.getRateOfPerceivedExertion());
        }
        assertEquals(2, record.getLaps().size());
        assertEquals("2001-10-28T00:30:00.123456789Z", record.getLaps().get(0).getStartTime().toString());
        assertEquals("2001-10-28T01:30:00.123456789Z", record.getLaps().get(0).getEndTime().toString());
        assertEquals(500.125, record.getLaps().get(0).getLength().getMeters(), 0.0);
        assertEquals("2001-10-28T01:30:00.123456789Z", record.getLaps().get(1).getStartTime().toString());
        assertEquals("2001-10-28T02:30:00.987654321Z", record.getLaps().get(1).getEndTime().toString());
        assertNull(record.getLaps().get(1).getLength());
    }

    @Test public void x01CompleteNoDataKeepsAllOrdinaryAndNestedFields() throws Exception {
        byte[] expected;
        try (InputStream input = getClass().getClassLoader().getResourceAsStream(
                "exercise-full-nodata-record-codecs-v1.json")) {
            assertNotNull("independently fixed complete EX-FULL resource", input);
            expected = input.readAllBytes();
        }
        ExerciseSessionRecord record = fullNoData();
        observe(record); // Constructor and getter failures are setup, not mapper RED.
        System.out.println("EX-FULL SDK constructor and getter preconditions passed");
        EncodedRecord result = RecordCodecs.INSTANCE.encode(record);
        assertArrayEquals("independent whole UTF8 JSON", expected,
            result.getRecordJson().getBytes(StandardCharsets.UTF_8));
        assertEquals("synthetic-provider-id", result.getNativeRecordId());
        assertEquals("ExerciseSessionRecord", result.getRecordType());
        assertEquals("health-connect-record", result.getSerializerId());
        assertEquals(1, result.getSerializerVersion());
        assertEquals("ordinary", result.getDataFamily());
        assertEquals("EncodedRecord(redacted)", result.toString());
    }

    private static byte[] expectedResource(String name) throws Exception {
        try (InputStream input = ExerciseSessionRecordCodecsTest.class.getClassLoader()
                .getResourceAsStream(name)) {
            assertNotNull("independently fixed whole UTF8 resource", input);
            return input.readAllBytes();
        }
    }

    private static void assertSnapshot(byte[] expected, EncodedRecord result, String nativeId) {
        assertArrayEquals("independent whole UTF8 JSON", expected,
            result.getRecordJson().getBytes(StandardCharsets.UTF_8));
        assertEquals(nativeId, result.getNativeRecordId());
        assertEquals("ExerciseSessionRecord", result.getRecordType());
        assertEquals("health-connect-record", result.getSerializerId());
        assertEquals(1, result.getSerializerVersion());
        assertEquals("ordinary", result.getDataFamily());
        assertEquals("EncodedRecord(redacted)", result.toString());
    }

    private static EncodedRecord encodeExpected(ExerciseSessionRecord record,
            byte[] expected, String nativeId) {
        EncodedRecord result = RecordCodecs.INSTANCE.encode(record);
        assertSnapshot(expected, result, nativeId);
        return result;
    }

    private static ExerciseSessionRecord withFullLists(ExerciseSessionRecord original,
            List<ExerciseSegment> segments, List<ExerciseLap> laps, Float exertion) {
        // Only fixed SDK input objects are reused; expected output always comes from prior bytes.
        return new ExerciseSessionRecord(original.getStartTime(), original.getStartZoneOffset(),
            original.getEndTime(), original.getEndZoneOffset(), original.getMetadata(),
            original.getExerciseType(), original.getTitle(), original.getNotes(), segments, laps,
            original.getExerciseRouteResult(), original.getPlannedExerciseSessionId(), exertion);
    }

    private static ExerciseSessionRecord nullableConsentRequired() {
        return new ExerciseSessionRecord(
            time("2001-10-28T00:30:00.123456789Z"), ZoneOffset.of("+02:00"),
            time("2001-10-28T02:30:00.987654321Z"), ZoneOffset.of("+01:00"),
            NativeMetadataFixture.nullableDeviceFields(), 0, null, "",
            Collections.emptyList(), Collections.emptyList(),
            new ExerciseRouteResult.ConsentRequired(), null, null);
    }

    private static void observeNullable(ExerciseSessionRecord record) {
        assertEquals("actual selected JVM fallback", 0, android.os.Build.VERSION.SDK_INT);
        assertEquals("2001-10-28T00:30:00.123456789Z", record.getStartTime().toString());
        assertEquals("+02:00", record.getStartZoneOffset().toString());
        assertEquals("2001-10-28T02:30:00.987654321Z", record.getEndTime().toString());
        assertEquals("+01:00", record.getEndZoneOffset().toString());
        assertEquals(0, record.getExerciseType());
        assertNull(record.getTitle());
        assertEquals("", record.getNotes());
        assertTrue(record.getSegments().isEmpty());
        assertTrue(record.getLaps().isEmpty());
        assertEquals(ExerciseRouteResult.ConsentRequired.class,
            record.getExerciseRouteResult().getClass());
        assertNull(record.getPlannedExerciseSessionId());
        assertNull(record.getRateOfPerceivedExertion());
        Metadata metadata = record.getMetadata();
        assertEquals(3, metadata.getRecordingMethod());
        assertEquals("synthetic-provider-id-device-null-fields", metadata.getId());
        assertEquals("org.example.synthetic.producer", metadata.getDataOrigin().getPackageName());
        assertEquals("2001-10-29T03:04:05.000000001Z", metadata.getLastModifiedTime().toString());
        assertEquals("", metadata.getClientRecordId());
        assertEquals(Long.MAX_VALUE, metadata.getClientRecordVersion());
        assertNotNull(metadata.getDevice());
        assertEquals(0, metadata.getDevice().getType());
        assertNull(metadata.getDevice().getManufacturer());
        assertNull(metadata.getDevice().getModel());
    }

    @Test public void x02ConsentRequiredKeepsNullAndEmptyFieldsDistinct() throws Exception {
        byte[] expected = expectedResource("exercise-null-consent-required-record-codecs-v1.json");
        ExerciseSessionRecord record = nullableConsentRequired();
        observeNullable(record);
        System.out.println("EX-NULL SDK constructor and getter preconditions passed");
        encodeExpected(record, expected, "synthetic-provider-id-device-null-fields");
    }

    @Test public void x03NextAfterOneFloat32KeepsExactShortestLiteral() throws Exception {
        byte[] expected = expectedResource("exercise-float32-nextafter-record-codecs-v1.json");
        ExerciseSessionRecord original = fullNoData();
        observe(original);
        float next = Float.intBitsToFloat(0x3f800001);
        ExerciseSessionRecord record = withFullLists(original,
            original.getSegments(), original.getLaps(), next);
        observeFull(record, Float.valueOf(next));
        assertEquals(0x3f800001, Float.floatToRawIntBits(record.getRateOfPerceivedExertion()));
        System.out.println("EX-FLOAT SDK constructor and getter preconditions passed");
        encodeExpected(record, expected, "synthetic-provider-id");
    }

    @Test public void x04ReturnedSnapshotsSurviveCallerSegmentAndLapClearThenReverse()
            throws Exception {
        byte[] expectedBefore = expectedResource("exercise-full-nodata-record-codecs-v1.json");
        byte[] expectedClear = expectedResource("exercise-segment-lap-clear-record-codecs-v1.json");
        byte[] expectedReverse = expectedResource("exercise-segment-lap-reverse-record-codecs-v1.json");
        ExerciseSessionRecord original = fullNoData();
        ArrayList<ExerciseSegment> originalSegments = new ArrayList<>(original.getSegments());
        ArrayList<ExerciseLap> originalLaps = new ArrayList<>(original.getLaps());
        ArrayList<ExerciseSegment> segmentCaller = new ArrayList<>(originalSegments);
        ArrayList<ExerciseLap> lapCaller = new ArrayList<>(originalLaps);
        ExerciseSessionRecord record = withFullLists(original, segmentCaller, lapCaller, 6.5f);
        observe(record);
        assertSame(segmentCaller, record.getSegments());
        assertSame(lapCaller, record.getLaps());
        System.out.println("EX-MUT-SL SDK constructor and getter preconditions passed");
        EncodedRecord first = encodeExpected(record, expectedBefore, "synthetic-provider-id");
        String firstJson = first.getRecordJson();

        segmentCaller.clear();
        lapCaller.clear();
        assertSame(segmentCaller, record.getSegments());
        assertSame(lapCaller, record.getLaps());
        assertTrue(record.getSegments().isEmpty());
        assertTrue(record.getLaps().isEmpty());
        EncodedRecord cleared = encodeExpected(record, expectedClear, "synthetic-provider-id");
        String clearedJson = cleared.getRecordJson();
        assertSnapshot(expectedBefore, first, "synthetic-provider-id");
        assertEquals(firstJson, first.getRecordJson());

        Collections.reverse(originalSegments);
        Collections.reverse(originalLaps);
        segmentCaller.addAll(originalSegments);
        lapCaller.addAll(originalLaps);
        assertSame(segmentCaller, record.getSegments());
        assertSame(lapCaller, record.getLaps());
        assertEquals(3, record.getSegments().size());
        assertEquals(2, record.getLaps().size());
        for (int i = 0; i < 3; i++) assertSame(originalSegments.get(i), record.getSegments().get(i));
        for (int i = 0; i < 2; i++) assertSame(originalLaps.get(i), record.getLaps().get(i));
        assertEquals("2001-10-28T00:45:00.987654321Z",
            record.getSegments().get(0).getStartTime().toString());
        assertEquals("2001-10-28T00:40:00.123456789Z",
            record.getSegments().get(1).getStartTime().toString());
        assertEquals("2001-10-28T00:35:00.000000001Z",
            record.getSegments().get(2).getStartTime().toString());
        assertEquals("2001-10-28T01:30:00.123456789Z",
            record.getLaps().get(0).getStartTime().toString());
        assertEquals("2001-10-28T00:30:00.123456789Z",
            record.getLaps().get(1).getStartTime().toString());
        encodeExpected(record, expectedReverse, "synthetic-provider-id");
        assertSnapshot(expectedBefore, first, "synthetic-provider-id");
        assertSnapshot(expectedClear, cleared, "synthetic-provider-id");
        assertEquals(firstJson, first.getRecordJson());
        assertEquals(clearedJson, cleared.getRecordJson());
    }

    private static ExerciseSessionRecord withRoute(ExerciseSessionRecord original,
            ExerciseRouteResult result) {
        return new ExerciseSessionRecord(original.getStartTime(), original.getStartZoneOffset(),
            original.getEndTime(), original.getEndZoneOffset(), original.getMetadata(),
            original.getExerciseType(), original.getTitle(), original.getNotes(),
            original.getSegments(), original.getLaps(), result,
            original.getPlannedExerciseSessionId(), original.getRateOfPerceivedExertion());
    }

    private static ArrayList<ExerciseRoute.Location> fixedRoutePoints() {
        // Original frozen SDK factory units and binary64 inputs, not mapper output.
        return new ArrayList<>(Arrays.asList(
            new ExerciseRoute.Location(time("2001-10-28T00:35:00.000000001Z"),
                -0.10000000000000002, 0.10000000000000002,
                Length.meters(1.75), null, Length.inches(69.0)),
            new ExerciseRoute.Location(time("2001-10-28T00:45:00.987654321Z"),
                0.10000000000000002, -0.10000000000000002,
                null, Length.inches(69.0), null)));
    }

    private static ExerciseRoutePayloadAuthority.ForRecord matchingAuthority() {
        return new ExerciseRoutePayloadAuthority.ForRecord(
            "synthetic-provider-id", "org.example.synthetic.producer");
    }

    private static ExerciseSessionRecord dataRecord(List<ExerciseRoute.Location> caller) {
        ExerciseSessionRecord original = fullNoData();
        observe(original);
        ExerciseRoute route = new ExerciseRoute(caller);
        ExerciseRouteResult.Data result = new ExerciseRouteResult.Data(route);
        ExerciseSessionRecord record = withRoute(original, result);
        assertSame(result, record.getExerciseRouteResult());
        assertSame(route, result.getExerciseRoute());
        assertSame(caller, route.getRoute());
        assertEquals(2, route.getRoute().size());
        assertEquals("2001-10-28T00:30:00.123456789Z", record.getStartTime().toString());
        assertEquals("+02:00", record.getStartZoneOffset().toString());
        assertEquals("2001-10-28T02:30:00.987654321Z", record.getEndTime().toString());
        assertEquals("+01:00", record.getEndZoneOffset().toString());
        assertSame(original.getMetadata(), record.getMetadata());
        assertSame(original.getSegments(), record.getSegments());
        assertSame(original.getLaps(), record.getLaps());
        assertEquals(0, record.getExerciseType());
        assertEquals("Synthetic \"session\" \u0394", record.getTitle());
        assertEquals("Line one\nLine two \ud83d\ude42", record.getNotes());
        assertEquals("synthetic-planned-id", record.getPlannedExerciseSessionId());
        assertEquals(Float.valueOf(6.5f), record.getRateOfPerceivedExertion());
        ExerciseRoute.Location first = caller.get(0), second = caller.get(1);
        assertEquals("2001-10-28T00:35:00.000000001Z", first.getTime().toString());
        assertEquals("2001-10-28T00:45:00.987654321Z", second.getTime().toString());
        assertEquals(-0.10000000000000002, first.getLatitude(), 0.0);
        assertEquals(0.10000000000000002, first.getLongitude(), 0.0);
        assertEquals(0.10000000000000002, second.getLatitude(), 0.0);
        assertEquals(-0.10000000000000002, second.getLongitude(), 0.0);
        assertEquals(1.75, first.getHorizontalAccuracy().getMeters(), 0.0);
        assertNull(first.getVerticalAccuracy());
        assertEquals(1.7526, first.getAltitude().getMeters(), 0.0);
        assertEquals(69.0, first.getAltitude().getInches(), 0.0);
        assertNull(second.getHorizontalAccuracy());
        assertEquals(1.7526, second.getVerticalAccuracy().getMeters(), 0.0);
        assertEquals(69.0, second.getVerticalAccuracy().getInches(), 0.0);
        assertNull(second.getAltitude());
        return record;
    }

    private static EncodedRecord encodeAuthorizedExpected(ExerciseSessionRecord record,
            byte[] expected) {
        EncodedRecord result = RecordCodecs.INSTANCE.encode(record, matchingAuthority());
        assertSnapshot(expected, result, "synthetic-provider-id");
        return result;
    }

    private interface EncodingCall { EncodedRecord run(); }

    private static void assertRefused(ExerciseRouteRefusalReason reason, EncodingCall call) {
        try {
            call.run();
            fail("Whole-record Exercise route refusal required");
        } catch (ExerciseRouteRefused refused) {
            assertEquals(reason, refused.getReason());
            assertEquals(reason.name(), refused.getMessage());
            assertEquals(reason.name(), refused.getLocalizedMessage());
            assertEquals("ExerciseRouteRefused(" + reason.name() + ")", refused.toString());
            assertNull(refused.getCause());
            assertEquals(0, refused.getSuppressed().length);
        }
    }

    // This accepted SDK boundary canary measures list operations, not final getter counts.
    private static final class ArmableRouteList extends AbstractList<ExerciseRoute.Location> {
        final ArrayList<ExerciseRoute.Location> values = fixedRoutePoints();
        final IllegalStateException sentinel = new IllegalStateException("route-list-trap");
        boolean armed;
        int touches;
        private void touched() { if (armed) { touches++; throw sentinel; } }
        @Override public int size() { touched(); return values.size(); }
        @Override public ExerciseRoute.Location get(int index) { touched(); return values.get(index); }
    }

    private static final class UnknownRouteResult extends ExerciseRouteResult {
        UnknownRouteResult() { super(); }
    }

    @Test public void x05MatchedAuthorityKeepsCompleteDataRecord() throws Exception {
        byte[] expected = expectedResource("exercise-data-authorized-record-codecs-v1.json");
        ExerciseSessionRecord record = dataRecord(fixedRoutePoints());
        assertEquals("ExerciseRoutePayloadAuthority(redacted)", matchingAuthority().toString());
        System.out.println("EX-DATA SDK constructor and getter preconditions passed");
        encodeAuthorizedExpected(record, expected);
    }

    @Test public void x06AuthorizedRouteClearReverseKeepsEarlierSnapshots() throws Exception {
        byte[] before = expectedResource("exercise-data-authorized-record-codecs-v1.json");
        byte[] clear = expectedResource("exercise-route-clear-record-codecs-v1.json");
        byte[] reverse = expectedResource("exercise-route-reverse-record-codecs-v1.json");
        ArrayList<ExerciseRoute.Location> caller = fixedRoutePoints();
        ArrayList<ExerciseRoute.Location> originals = new ArrayList<>(caller);
        ExerciseSessionRecord record = dataRecord(caller);
        ExerciseRoute route = ((ExerciseRouteResult.Data) record.getExerciseRouteResult())
            .getExerciseRoute();
        System.out.println("EX-MUT-ROUTE SDK constructor and getter preconditions passed");
        EncodedRecord first = encodeAuthorizedExpected(record, before);
        String firstJson = first.getRecordJson();
        caller.clear();
        assertSame(caller, route.getRoute());
        assertTrue(route.getRoute().isEmpty());
        EncodedRecord cleared = encodeAuthorizedExpected(record, clear);
        String clearedJson = cleared.getRecordJson();
        assertSnapshot(before, first, "synthetic-provider-id");
        assertEquals(firstJson, first.getRecordJson());
        Collections.reverse(originals);
        caller.addAll(originals);
        assertSame(caller, route.getRoute());
        assertSame(originals.get(0), route.getRoute().get(0));
        assertSame(originals.get(1), route.getRoute().get(1));
        assertEquals("2001-10-28T00:45:00.987654321Z",
            route.getRoute().get(0).getTime().toString());
        assertEquals("2001-10-28T00:35:00.000000001Z",
            route.getRoute().get(1).getTime().toString());
        encodeAuthorizedExpected(record, reverse);
        assertSnapshot(before, first, "synthetic-provider-id");
        assertSnapshot(clear, cleared, "synthetic-provider-id");
        assertEquals(firstJson, first.getRecordJson());
        assertEquals(clearedJson, cleared.getRecordJson());
    }

    @Test public void x07DefaultDenyAndNullAuthorityRefuseBeforeListTraversal() {
        ArmableRouteList caller = new ArmableRouteList();
        ExerciseSessionRecord record = dataRecord(caller);
        caller.armed = true;
        assertEquals(0, caller.touches);
        System.out.println("EX-DENY SDK constructor and getter preconditions passed");
        assertRefused(ExerciseRouteRefusalReason.AUTHORITY_REQUIRED,
            () -> RecordCodecs.INSTANCE.encode(record));
        assertEquals(0, caller.touches);
        assertRefused(ExerciseRouteRefusalReason.AUTHORITY_REQUIRED,
            () -> RecordCodecs.INSTANCE.encode(record, ExerciseRoutePayloadAuthority.DENY.INSTANCE));
        assertEquals(0, caller.touches);
        assertRefused(ExerciseRouteRefusalReason.AUTHORITY_REQUIRED,
            () -> RecordCodecs.INSTANCE.encode(record, null));
        assertEquals(0, caller.touches);
    }

    @Test public void x08EitherOrBothAuthorityBindingsMismatchBeforeListTraversal() {
        ArmableRouteList caller = new ArmableRouteList();
        ExerciseSessionRecord record = dataRecord(caller);
        caller.armed = true;
        ExerciseRoutePayloadAuthority[] authorities = {
            new ExerciseRoutePayloadAuthority.ForRecord(
                "synthetic-provider-id-other", "org.example.synthetic.producer"),
            new ExerciseRoutePayloadAuthority.ForRecord(
                "synthetic-provider-id", "org.example.synthetic.other"),
            new ExerciseRoutePayloadAuthority.ForRecord(
                "synthetic-provider-id-other", "org.example.synthetic.other")
        };
        System.out.println("EX-MISMATCH SDK constructor and getter preconditions passed");
        for (ExerciseRoutePayloadAuthority authority : authorities) {
            assertEquals("ExerciseRoutePayloadAuthority(redacted)", authority.toString());
            assertRefused(ExerciseRouteRefusalReason.AUTHORITY_MISMATCH,
                () -> RecordCodecs.INSTANCE.encode(record, authority));
            assertEquals(0, caller.touches);
        }
    }

    @Test public void x09UnknownResultRefusesWholeRecordForEveryAuthority() {
        ExerciseSessionRecord original = fullNoData();
        observe(original);
        UnknownRouteResult unknown = new UnknownRouteResult();
        ExerciseSessionRecord record = withRoute(original, unknown);
        assertSame(unknown, record.getExerciseRouteResult());
        System.out.println("EX-UNKNOWN SDK constructor and getter preconditions passed");
        assertRefused(ExerciseRouteRefusalReason.UNKNOWN_RESULT,
            () -> RecordCodecs.INSTANCE.encode(record));
        assertRefused(ExerciseRouteRefusalReason.UNKNOWN_RESULT,
            () -> RecordCodecs.INSTANCE.encode(record, null));
        assertRefused(ExerciseRouteRefusalReason.UNKNOWN_RESULT,
            () -> RecordCodecs.INSTANCE.encode(record, ExerciseRoutePayloadAuthority.DENY.INSTANCE));
        assertRefused(ExerciseRouteRefusalReason.UNKNOWN_RESULT,
            () -> RecordCodecs.INSTANCE.encode(record, matchingAuthority()));
    }

    @Test public void x10NoDataAndConsentRequiredIgnoreAbsentOrMismatchedAuthority()
            throws Exception {
        ExerciseSessionRecord noData = fullNoData(), consent = nullableConsentRequired();
        observe(noData);
        observeNullable(consent);
        byte[] noDataExpected = expectedResource("exercise-full-nodata-record-codecs-v1.json");
        byte[] consentExpected = expectedResource("exercise-null-consent-required-record-codecs-v1.json");
        ExerciseRoutePayloadAuthority[] authorities = {null,
            ExerciseRoutePayloadAuthority.DENY.INSTANCE,
            new ExerciseRoutePayloadAuthority.ForRecord("different-id", "different.origin")};
        System.out.println("EX-NO-PAYLOAD SDK constructor and getter preconditions passed");
        for (ExerciseRoutePayloadAuthority authority : authorities) {
            assertSnapshot(noDataExpected, RecordCodecs.INSTANCE.encode(noData, authority),
                "synthetic-provider-id");
            assertSnapshot(consentExpected, RecordCodecs.INSTANCE.encode(consent, authority),
                "synthetic-provider-id-device-null-fields");
        }
    }

    @Test public void x11ArmedListCanaryRetainsExactReferenceAndSizeGetSentinels() {
        ArmableRouteList caller = new ArmableRouteList();
        ExerciseSessionRecord record = dataRecord(caller);
        caller.armed = true;
        List<ExerciseRoute.Location> exposed = ((ExerciseRouteResult.Data)
            record.getExerciseRouteResult()).getExerciseRoute().getRoute();
        assertSame(caller, exposed);
        assertEquals(0, caller.touches);
        System.out.println("EX-LIST-TRAP SDK constructor and getter preconditions passed");
        try { exposed.size(); fail("Armed size must throw"); }
        catch (IllegalStateException error) { assertSame(caller.sentinel, error); }
        assertEquals(1, caller.touches);
        try { exposed.get(0); fail("Armed get must throw"); }
        catch (IllegalStateException error) { assertSame(caller.sentinel, error); }
        assertEquals(2, caller.touches);
    }

    @Test public void x12RegistryAddsPlannedRemainsExactAndImmutable() {
        java.util.Set<String> expected = new java.util.LinkedHashSet<>(Arrays.asList(
            "StepsRecord", "WeightRecord", "BodyFatRecord", "BodyWaterMassRecord",
            "BoneMassRecord", "LeanBodyMassRecord", "HeightRecord", "HeartRateVariabilityRmssdRecord",
            "RespiratoryRateRecord", "RestingHeartRateRecord", "BasalMetabolicRateRecord", "BasalBodyTemperatureRecord",
            "BodyTemperatureRecord", "BloodGlucoseRecord", "BloodPressureRecord", "OxygenSaturationRecord",
            "Vo2MaxRecord", "HeartRateRecord", "SpeedRecord", "PowerRecord",
            "StepsCadenceRecord", "CyclingPedalingCadenceRecord", "ActiveCaloriesBurnedRecord", "TotalCaloriesBurnedRecord",
            "DistanceRecord", "ElevationGainedRecord", "FloorsClimbedRecord", "HydrationRecord",
            "WheelchairPushesRecord", "MenstruationPeriodRecord", "MindfulnessSessionRecord", "ActivityIntensityRecord",
            "CervicalMucusRecord", "IntermenstrualBleedingRecord", "MenstruationFlowRecord", "OvulationTestRecord",
            "SexualActivityRecord", "NutritionRecord", "SkinTemperatureRecord", "SleepSessionRecord",
            "ExerciseSessionRecord", "PlannedExerciseSessionRecord"
        ));
        assertEquals(42, expected.size());
        System.out.println("EX-REGISTRY independent42 registry expectations frozen");
        java.util.Set<String> actual = RecordCodecs.INSTANCE.getSupportedRecordTypes();
        assertEquals("Exact42 ordinary codec registry", expected, actual);
        assertTrue(actual.contains("PlannedExerciseSessionRecord"));
        try {
            actual.add("FutureRecord");
            fail("Ordinary codec registry must remain immutable");
        } catch (UnsupportedOperationException expectedRefusal) {
            assertEquals(expected, actual);
        }
        assertEquals(expected, actual);
    }
}
