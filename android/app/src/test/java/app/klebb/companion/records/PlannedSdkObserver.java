// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records;

import android.os.Build;
import android.os.ext.SdkExtensions;
import androidx.health.connect.client.records.ExerciseCompletionGoal;
import androidx.health.connect.client.records.ExercisePerformanceTarget;
import androidx.health.connect.client.records.PlannedExerciseBlock;
import androidx.health.connect.client.records.PlannedExerciseSessionRecord;
import androidx.health.connect.client.records.PlannedExerciseStep;
import androidx.health.connect.client.records.metadata.DataOrigin;
import androidx.health.connect.client.records.metadata.Device;
import androidx.health.connect.client.records.metadata.Metadata;
import androidx.health.connect.client.units.Energy;
import androidx.health.connect.client.units.Length;
import androidx.health.connect.client.units.Mass;
import androidx.health.connect.client.units.Power;
import androidx.health.connect.client.units.Velocity;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/** Fixed synthetic SDK constructors and direct getter observations; no mapper or launcher. */
public final class PlannedSdkObserver {
    private PlannedSdkObserver() {}

    public static final class OwnedFixture {
        public final PlannedExerciseSessionRecord record;
        public final List<PlannedExerciseBlock> suppliedBlocks;
        public final List<PlannedExerciseStep> suppliedSteps;
        public final List<ExercisePerformanceTarget> suppliedTargets;
        public final String stepListPath;
        public final String targetListPath;

        private OwnedFixture(PlannedExerciseSessionRecord record, Parts parts, boolean reversed) {
            this.record = record;
            this.suppliedBlocks = parts.blocks;
            this.suppliedSteps = parts.steps;
            this.suppliedTargets = parts.distanceTargets;
            this.stepListPath = reversed ? "blocks[1].steps" : "blocks[0].steps";
            this.targetListPath = reversed ? "blocks[1].steps[8].performanceTargets"
                    : "blocks[0].steps[0].performanceTargets";
        }
    }

    private static final class Parts {
        final List<PlannedExerciseBlock> blocks;
        final List<PlannedExerciseStep> steps;
        final List<ExercisePerformanceTarget> distanceTargets;
        Parts(List<PlannedExerciseBlock> blocks, List<PlannedExerciseStep> steps,
              List<ExercisePerformanceTarget> distanceTargets) {
            this.blocks = blocks;
            this.steps = steps;
            this.distanceTargets = distanceTargets;
        }
    }

    public static final class SyntheticFutureGoal extends ExerciseCompletionGoal {
        private final int syntheticValue;
        public SyntheticFutureGoal(int value) { this.syntheticValue = value; }
        public int getSyntheticValue() { return syntheticValue; }
    }

    public static final class SyntheticFutureTarget extends ExercisePerformanceTarget {
        private final int syntheticValue;
        public SyntheticFutureTarget(int value) { this.syntheticValue = value; }
        public int getSyntheticValue() { return syntheticValue; }
    }

    private static Metadata fullMetadata() {
        return new Metadata(2, "synthetic-provider-id",
                new DataOrigin("org.example.synthetic.producer"),
                Instant.parse("2001-10-29T03:04:05.987654321Z"),
                "synthetic-client-id/\u03b1\n\"quoted\"", 9007199254740993L,
                new Device(1, "Synthetic maker", "Synthetic model \u0394"));
    }

    private static Metadata nullableMetadata() {
        return new Metadata(0, "synthetic-provider-id-nullable",
                new DataOrigin("org.example.synthetic.producer"), Instant.EPOCH,
                null, 0L, null);
    }

    private static Metadata nullableDeviceMetadata() {
        return new Metadata(3, "synthetic-provider-id-device-null-fields",
                new DataOrigin("org.example.synthetic.producer"),
                Instant.parse("2001-10-29T03:04:05.000000001Z"), "", Long.MAX_VALUE,
                new Device(0, null, null));
    }

    private static ExercisePerformanceTarget.PowerTarget powerTarget() {
        return new ExercisePerformanceTarget.PowerTarget(Power.watts(80.125), Power.watts(200.25));
    }

    private static ExercisePerformanceTarget.CadenceTarget cadenceTarget() {
        return new ExercisePerformanceTarget.CadenceTarget(72.125, 90.25);
    }

    private static List<ExercisePerformanceTarget> targets(ExercisePerformanceTarget... values) {
        return new ArrayList<>(Arrays.asList(values));
    }

    private static Parts parts(boolean reversed) {
        return parts(reversed, 0);
    }

    private static Parts parts(boolean reversed, int control) {
        List<ExercisePerformanceTarget> distanceTargets = control == 13
                ? targets(new SyntheticFutureTarget(9)) : control == 14
                ? targets(powerTarget(), new ExercisePerformanceTarget.WeightTarget(Mass.grams(6250)),
                        new ExercisePerformanceTarget.RateOfPerceivedExertionTarget(7)) : reversed
                ? targets(powerTarget(), cadenceTarget(), powerTarget()) : targets(powerTarget());
        ExerciseCompletionGoal distanceGoal = control == 12 ? new SyntheticFutureGoal(9)
                : new ExerciseCompletionGoal.DistanceGoal(Length.meters(100.125));
        List<PlannedExerciseStep> steps = new ArrayList<>();
        // Every override is chosen BEFORE Step/Block construction; no retention assumption.
        steps.add(new PlannedExerciseStep(control == 5 ? 9022 : 0, control == 5 ? 9023 : 1,
                distanceGoal, distanceTargets, "Synthetic distance goal."));
        steps.add(new PlannedExerciseStep(0, 3,
                new ExerciseCompletionGoal.DistanceAndDurationGoal(Length.meters(200.25),
                        Duration.ofSeconds(100L, 123456789L)),
                targets(new ExercisePerformanceTarget.SpeedTarget(
                        Velocity.metersPerSecond(1.125), Velocity.metersPerSecond(3.25))),
                "Synthetic distance plus duration."));
        steps.add(new PlannedExerciseStep(0, 3, new ExerciseCompletionGoal.StepsGoal(321),
                targets(cadenceTarget()), "Synthetic steps goal."));
        steps.add(new PlannedExerciseStep(0, 3,
                new ExerciseCompletionGoal.DurationGoal(Duration.ofSeconds(12L, 987654321L)),
                targets(new ExercisePerformanceTarget.HeartRateTarget(120.125, 160.25)),
                "Synthetic duration goal."));
        steps.add(new PlannedExerciseStep(0, 3, new ExerciseCompletionGoal.RepetitionsGoal(9),
                targets(new ExercisePerformanceTarget.WeightTarget(Mass.grams(6250.0))),
                "Synthetic repetitions goal."));
        steps.add(new PlannedExerciseStep(0, 3,
                new ExerciseCompletionGoal.TotalCaloriesBurnedGoal(Energy.kilocalories(12.125)),
                targets(new ExercisePerformanceTarget.RateOfPerceivedExertionTarget(7)),
                "Synthetic total energy goal."));
        steps.add(new PlannedExerciseStep(0, 3,
                new ExerciseCompletionGoal.ActiveCaloriesBurnedGoal(Energy.kilocalories(14.25)),
                targets(ExercisePerformanceTarget.AmrapTarget.INSTANCE), "Synthetic active energy goal."));
        steps.add(new PlannedExerciseStep(0, 0, ExerciseCompletionGoal.UnknownGoal.INSTANCE,
                targets(ExercisePerformanceTarget.UnknownTarget.INSTANCE), ""));
        steps.add(new PlannedExerciseStep(0, 2, ExerciseCompletionGoal.ManualCompletion.INSTANCE,
                targets(), null));
        if (reversed) Collections.reverse(steps);
        List<PlannedExerciseBlock> blocks = new ArrayList<>();
        blocks.add(new PlannedExerciseBlock(2, steps, "Synthetic block \u03b1\nRepeat twice."));
        List<PlannedExerciseStep> finalSteps = new ArrayList<>();
        finalSteps.add(new PlannedExerciseStep(0, 2, ExerciseCompletionGoal.ManualCompletion.INSTANCE,
                targets(), "Synthetic final step."));
        blocks.add(new PlannedExerciseBlock(1, finalSteps, null));
        if (reversed) Collections.reverse(blocks);
        return new Parts(blocks, steps, distanceTargets);
    }

    private static PlannedExerciseSessionRecord primary(List<PlannedExerciseBlock> blocks,
                                                         int exerciseType) {
        // The JVM-public eleven-argument path preserves the fixed nonnull completed ID.
        return new PlannedExerciseSessionRecord(
                Instant.parse("2001-10-28T00:30:00.123456789Z"), ZoneOffset.of("+02:00"),
                Instant.parse("2001-10-28T02:30:00.987654321Z"), ZoneOffset.of("+01:00"),
                fullMetadata(), true, exerciseType, "synthetic-completed-session-id", blocks,
                "Synthetic training plan", "Retain block and step order.\n\u0394");
    }

    public static OwnedFixture ownedFixture(String caseId) {
        if (!"O1".equals(caseId) && !"O4".equals(caseId) && !"N4".equals(caseId)) {
            throw new IllegalArgumentException("fixed ownership case required");
        }
        boolean reversed = "O4".equals(caseId) || "N4".equals(caseId);
        Parts parts = "N4".equals(caseId) ? parts(true, 14) : parts(reversed);
        return new OwnedFixture(primary(parts.blocks, 0), parts, reversed);
    }

    public static PlannedExerciseSessionRecord fixture(String caseId) {
        switch (caseId) {
            case "O1": return ownedFixture("O1").record;
            case "O2":
                // This case is only valid inside the isolated UTC observation/test process.
                if (!ZoneId.systemDefault().getRules().equals(ZoneOffset.UTC.getRules())) {
                    throw new IllegalStateException("UTC precondition missing");
                }
                return new PlannedExerciseSessionRecord(nullableMetadata(), LocalDate.of(2001, 2, 3),
                        Duration.ofSeconds(1800L, 123456789L), new ArrayList<>(), 0, null, "");
            case "O3": return new PlannedExerciseSessionRecord(
                    Instant.parse("2001-10-28T00:30:00.000000001Z"), null,
                    Instant.parse("2001-10-28T00:30:00.000000002Z"), null,
                    nullableDeviceMetadata(), new ArrayList<>(), 0, "", null);
            case "O4": return ownedFixture("O4").record;
            case "N4": return ownedFixture("N4").record;
            case "O5": return primary(parts(false, 5).blocks, 9021);
            case "O6": {
                List<PlannedExerciseStep> steps = new ArrayList<>();
                steps.add(new PlannedExerciseStep(0, 0, new ExerciseCompletionGoal.RepetitionsGoal(0),
                        targets(new ExercisePerformanceTarget.RateOfPerceivedExertionTarget(0)), ""));
                List<PlannedExerciseBlock> blocks = new ArrayList<>();
                blocks.add(new PlannedExerciseBlock(0, steps, null));
                return primary(blocks, 0);
            }
            default: throw new IllegalArgumentException("fixed fixture case required");
        }
    }

    public static PlannedExerciseSessionRecord futureGoal() {
        return primary(parts(false, 12).blocks, 0);
    }

    public static PlannedExerciseSessionRecord futureTarget() {
        return primary(parts(false, 13).blocks, 0);
    }

    private static void put(Map<String, String> values, String path, Object value) {
        values.put(path, value == null ? null : String.valueOf(value));
    }

    private static void bits(Map<String, String> values, String path, double value) {
        put(values, path + ".rawBits", String.format(Locale.ROOT, "0x%016x",
                Double.doubleToRawLongBits(value)));
    }

    private static void length(Map<String, String> out, String p, Length v) {
        put(out, p + ".kind", "Length");
        bits(out, p + ".getMeters", v.getMeters());
        bits(out, p + ".getKilometers", v.getKilometers());
        bits(out, p + ".getMiles", v.getMiles());
        bits(out, p + ".getInches", v.getInches());
        bits(out, p + ".getFeet", v.getFeet());
    }

    private static void energy(Map<String, String> out, String p, Energy v) {
        put(out, p + ".kind", "Energy");
        bits(out, p + ".getCalories", v.getCalories());
        bits(out, p + ".getKilocalories", v.getKilocalories());
        bits(out, p + ".getJoules", v.getJoules());
        bits(out, p + ".getKilojoules", v.getKilojoules());
    }

    private static void power(Map<String, String> out, String p, Power v) {
        put(out, p + ".kind", "Power");
        bits(out, p + ".getWatts", v.getWatts());
        bits(out, p + ".getKilocaloriesPerDay", v.getKilocaloriesPerDay());
    }

    private static void velocity(Map<String, String> out, String p, Velocity v) {
        put(out, p + ".kind", "Velocity");
        bits(out, p + ".getMetersPerSecond", v.getMetersPerSecond());
        bits(out, p + ".getKilometersPerHour", v.getKilometersPerHour());
        bits(out, p + ".getMilesPerHour", v.getMilesPerHour());
    }

    private static void mass(Map<String, String> out, String p, Mass v) {
        put(out, p + ".kind", "Mass");
        bits(out, p + ".getGrams", v.getGrams());
        bits(out, p + ".getKilograms", v.getKilograms());
        bits(out, p + ".getMilligrams", v.getMilligrams());
        bits(out, p + ".getMicrograms", v.getMicrograms());
        bits(out, p + ".getOunces", v.getOunces());
        bits(out, p + ".getPounds", v.getPounds());
    }

    private static void duration(Map<String, String> out, String p, Duration value) {
        put(out, p + ".seconds", value.getSeconds());
        put(out, p + ".nanoAdjustment", value.getNano());
    }

    private static void goal(Map<String, String> out, String p, ExerciseCompletionGoal value) {
        if (value instanceof ExerciseCompletionGoal.DistanceGoal) {
            put(out, p + ".variant", "DistanceGoal");
            length(out, p + ".distance", ((ExerciseCompletionGoal.DistanceGoal) value).getDistance());
        } else if (value instanceof ExerciseCompletionGoal.DistanceAndDurationGoal) {
            put(out, p + ".variant", "DistanceAndDurationGoal");
            ExerciseCompletionGoal.DistanceAndDurationGoal v = (ExerciseCompletionGoal.DistanceAndDurationGoal) value;
            length(out, p + ".distance", v.getDistance()); duration(out, p + ".duration", v.getDuration());
        } else if (value instanceof ExerciseCompletionGoal.StepsGoal) {
            put(out, p + ".variant", "StepsGoal"); put(out, p + ".steps", ((ExerciseCompletionGoal.StepsGoal) value).getSteps());
        } else if (value instanceof ExerciseCompletionGoal.DurationGoal) {
            put(out, p + ".variant", "DurationGoal"); duration(out, p + ".duration", ((ExerciseCompletionGoal.DurationGoal) value).getDuration());
        } else if (value instanceof ExerciseCompletionGoal.RepetitionsGoal) {
            put(out, p + ".variant", "RepetitionsGoal"); put(out, p + ".repetitions", ((ExerciseCompletionGoal.RepetitionsGoal) value).getRepetitions());
        } else if (value instanceof ExerciseCompletionGoal.TotalCaloriesBurnedGoal) {
            put(out, p + ".variant", "TotalCaloriesBurnedGoal"); energy(out, p + ".totalCalories", ((ExerciseCompletionGoal.TotalCaloriesBurnedGoal) value).getTotalCalories());
        } else if (value instanceof ExerciseCompletionGoal.ActiveCaloriesBurnedGoal) {
            put(out, p + ".variant", "ActiveCaloriesBurnedGoal"); energy(out, p + ".activeCalories", ((ExerciseCompletionGoal.ActiveCaloriesBurnedGoal) value).getActiveCalories());
        } else if (value instanceof ExerciseCompletionGoal.UnknownGoal) {
            put(out, p + ".variant", "UnknownGoal");
        } else if (value instanceof ExerciseCompletionGoal.ManualCompletion) {
            put(out, p + ".variant", "ManualCompletion");
        } else if (value instanceof SyntheticFutureGoal) {
            put(out, p + ".variant", "SyntheticFutureGoal"); put(out, p + ".syntheticValue", ((SyntheticFutureGoal) value).getSyntheticValue());
        } else {
            throw new IllegalArgumentException("unbound goal subtype");
        }
    }

    private static void target(Map<String, String> out, String p, ExercisePerformanceTarget value) {
        if (value instanceof ExercisePerformanceTarget.PowerTarget) {
            put(out, p + ".variant", "PowerTarget"); ExercisePerformanceTarget.PowerTarget v = (ExercisePerformanceTarget.PowerTarget) value;
            power(out, p + ".minPower", v.getMinPower()); power(out, p + ".maxPower", v.getMaxPower());
        } else if (value instanceof ExercisePerformanceTarget.SpeedTarget) {
            put(out, p + ".variant", "SpeedTarget"); ExercisePerformanceTarget.SpeedTarget v = (ExercisePerformanceTarget.SpeedTarget) value;
            velocity(out, p + ".minSpeed", v.getMinSpeed()); velocity(out, p + ".maxSpeed", v.getMaxSpeed());
        } else if (value instanceof ExercisePerformanceTarget.CadenceTarget) {
            put(out, p + ".variant", "CadenceTarget"); ExercisePerformanceTarget.CadenceTarget v = (ExercisePerformanceTarget.CadenceTarget) value;
            bits(out, p + ".minCadence", v.getMinCadence()); bits(out, p + ".maxCadence", v.getMaxCadence());
        } else if (value instanceof ExercisePerformanceTarget.HeartRateTarget) {
            put(out, p + ".variant", "HeartRateTarget"); ExercisePerformanceTarget.HeartRateTarget v = (ExercisePerformanceTarget.HeartRateTarget) value;
            bits(out, p + ".minHeartRate", v.getMinHeartRate()); bits(out, p + ".maxHeartRate", v.getMaxHeartRate());
        } else if (value instanceof ExercisePerformanceTarget.WeightTarget) {
            put(out, p + ".variant", "WeightTarget"); mass(out, p + ".mass", ((ExercisePerformanceTarget.WeightTarget) value).getMass());
        } else if (value instanceof ExercisePerformanceTarget.RateOfPerceivedExertionTarget) {
            put(out, p + ".variant", "RateOfPerceivedExertionTarget"); put(out, p + ".rpe", ((ExercisePerformanceTarget.RateOfPerceivedExertionTarget) value).getRpe());
        } else if (value instanceof ExercisePerformanceTarget.AmrapTarget) {
            put(out, p + ".variant", "AmrapTarget");
        } else if (value instanceof ExercisePerformanceTarget.UnknownTarget) {
            put(out, p + ".variant", "UnknownTarget");
        } else if (value instanceof SyntheticFutureTarget) {
            put(out, p + ".variant", "SyntheticFutureTarget"); put(out, p + ".syntheticValue", ((SyntheticFutureTarget) value).getSyntheticValue());
        } else {
            throw new IllegalArgumentException("unbound target subtype");
        }
    }

    /** No expected values or mapper call participate in this actual-getter snapshot. */
    public static Map<String, String> snapshot(PlannedExerciseSessionRecord record) {
        Map<String, String> out = new LinkedHashMap<>();
        put(out, "startTime", record.getStartTime()); put(out, "startZoneOffset", record.getStartZoneOffset());
        put(out, "endTime", record.getEndTime()); put(out, "endZoneOffset", record.getEndZoneOffset());
        put(out, "hasExplicitTime", record.hasExplicitTime()); put(out, "exerciseType", record.getExerciseType());
        put(out, "completedExerciseSessionId", record.getCompletedExerciseSessionId());
        put(out, "title", record.getTitle()); put(out, "notes", record.getNotes());
        Metadata metadata = record.getMetadata();
        put(out, "metadata.recordingMethod", metadata.getRecordingMethod()); put(out, "metadata.id", metadata.getId());
        put(out, "metadata.lastModifiedTime", metadata.getLastModifiedTime());
        put(out, "metadata.clientRecordId", metadata.getClientRecordId());
        put(out, "metadata.clientRecordVersion", metadata.getClientRecordVersion());
        put(out, "metadata.dataOrigin.packageName", metadata.getDataOrigin().getPackageName());
        Device device = metadata.getDevice(); put(out, "metadata.device.present", device != null);
        if (device != null) {
            put(out, "metadata.device.type", device.getType());
            put(out, "metadata.device.manufacturer", device.getManufacturer()); put(out, "metadata.device.model", device.getModel());
        }
        List<PlannedExerciseBlock> blocks = record.getBlocks(); put(out, "blocks.size", blocks.size());
        for (int i = 0; i < blocks.size(); i++) {
            PlannedExerciseBlock block = blocks.get(i); String bp = "blocks[" + i + "]";
            put(out, bp + ".repetitions", block.getRepetitions()); put(out, bp + ".description", block.getDescription());
            List<PlannedExerciseStep> steps = block.getSteps(); put(out, bp + ".steps.size", steps.size());
            for (int j = 0; j < steps.size(); j++) {
                PlannedExerciseStep step = steps.get(j); String sp = bp + ".steps[" + j + "]";
                put(out, sp + ".exerciseType", step.getExerciseType()); put(out, sp + ".exercisePhase", step.getExercisePhase());
                put(out, sp + ".description", step.getDescription()); goal(out, sp + ".completionGoal", step.getCompletionGoal());
                List<ExercisePerformanceTarget> targets = step.getPerformanceTargets();
                put(out, sp + ".performanceTargets.size", targets.size());
                for (int k = 0; k < targets.size(); k++) target(out, sp + ".performanceTargets[" + k + "]", targets.get(k));
            }
        }
        return out;
    }

    private static PlannedExerciseSessionRecord intervalControl(boolean reversed) {
        Instant first = Instant.parse("2001-10-28T00:30:00.123456789Z");
        Instant start = reversed ? Instant.parse("2001-10-28T02:30:00.987654321Z") : first;
        return new PlannedExerciseSessionRecord(start, ZoneOffset.of("+02:00"), first,
                ZoneOffset.of("+01:00"), fullMetadata(), true, 0,
                "synthetic-completed-session-id", parts(false).blocks,
                "Synthetic training plan", "Retain block and step order.\n\u0394");
    }

    private static Map<String, String> slot(int number) {
        if (number <= 6) return snapshot(fixture("O" + number));
        switch (number) {
            case 7:
            case 8: {
                Map<String, String> out = new LinkedHashMap<>();
                ExercisePerformanceTarget.RateOfPerceivedExertionTarget v =
                        new ExercisePerformanceTarget.RateOfPerceivedExertionTarget(number == 7 ? 10 : 11);
                put(out, "target.rpe", v.getRpe()); return out;
            }
            case 9: return snapshot(intervalControl(false));
            case 10: return snapshot(intervalControl(true));
            case 11: return snapshot(new PlannedExerciseSessionRecord(nullableMetadata(),
                    LocalDate.of(2001, 2, 3), Duration.ZERO, new ArrayList<>(), 0, null, ""));
            case 12: return snapshot(futureGoal());
            case 13: return snapshot(futureTarget());
            default: throw new IllegalArgumentException("fixed slot required");
        }
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\t", "\\t").replace("\r", "\\r").replace("\n", "\\n");
    }

    private static void raw(Appendable sink, String path, String value) throws IOException {
        // NULL has its own value-kind column; no empty/null or escape ambiguity.
        sink.append(escape(path)).append('\t').append(value == null ? "NULL" : "STRING")
                .append('\t').append(value == null ? "" : escape(value)).append('\n');
    }

    private static void emit(Appendable sink, String prefix, Map<String, String> values) throws IOException {
        for (Map.Entry<String, String> entry : values.entrySet()) raw(sink, prefix + entry.getKey(), entry.getValue());
    }

    private static void runtime(Appendable sink) throws IOException {
        try {
            int sdk = Build.VERSION.SDK_INT;
            raw(sink, "runtime.sdkInt", Integer.toString(sdk));
            if (sdk < 34) {
                raw(sink, "runtime.extensionVersion", "NOT_OBSERVED_GUARD_FALSE");
                raw(sink, "runtime.alphaValidationBranch", "FALLBACK_GUARD");
            } else {
                try {
                    int extension = SdkExtensions.getExtensionVersion(34);
                    raw(sink, "runtime.extensionVersion", Integer.toString(extension));
                    raw(sink, "runtime.alphaValidationBranch", extension >= 13 ? "PLATFORM_GUARD" : "FALLBACK_GUARD");
                } catch (RuntimeException | LinkageError failure) {
                    raw(sink, "runtime.extensionVersion", "NOT_OBSERVED");
                    raw(sink, "runtime.extensionFailureClass", failure.getClass().getName());
                    raw(sink, "runtime.alphaValidationBranch", "NOT_OBSERVED");
                }
            }
            raw(sink, "runtime.stableValidationBranch", "NOT_OBSERVED_SOURCE_UNKNOWN");
        } catch (RuntimeException | LinkageError failure) {
            raw(sink, "runtime.sdkInt", "NOT_OBSERVED");
            raw(sink, "runtime.sdkFailureClass", failure.getClass().getName());
            raw(sink, "runtime.alphaValidationBranch", "NOT_OBSERVED");
            raw(sink, "runtime.stableValidationBranch", "NOT_OBSERVED_SOURCE_UNKNOWN");
        }
    }

    /**
     * Thirteen fixed case slots, raw observations only. Caller retains native exit/timeout and
     * raw streams before interpretation; no mapper, expected comparison, process or launcher.
     */
    public static void observeAll(String pin, Appendable rawSink) throws IOException {
        raw(rawSink, "pin", pin);
        runtime(rawSink);
        TimeZone saved = TimeZone.getDefault();
        raw(rawSink, "timezone.before", saved.getID());
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
        try {
            raw(rawSink, "timezone.controlled", ZoneId.systemDefault().getId());
            for (int number = 1; number <= 13; number++) {
                String id = String.format(Locale.ROOT, "S%02d", number);
                raw(rawSink, id + ".status", "STARTED");
                try {
                    Map<String, String> observed = slot(number);
                    emit(rawSink, id + ".", observed);
                    raw(rawSink, id + ".status", "CONSTRUCTED_AND_GETTERS_RETURNED");
                    if (number == 1 || number == 4) ownership(rawSink, "O" + number, id);
                } catch (IllegalArgumentException refusal) {
                    raw(rawSink, id + ".status", "CONSTRUCTOR_OR_GETTER_REFUSED");
                    raw(rawSink, id + ".exceptionClass", refusal.getClass().getName());
                    if (number == 1) return;
                } catch (RuntimeException | LinkageError setupFailure) {
                    raw(rawSink, id + ".status", "SDK_SETUP_ERROR");
                    raw(rawSink, id + ".exceptionClass", setupFailure.getClass().getName());
                    return;
                }
            }
        } finally {
            TimeZone.setDefault(saved);
            raw(rawSink, "timezone.restored", ZoneId.systemDefault().getId());
        }
    }

    private static void ownership(Appendable rawSink, String caseId, String slot) throws IOException {
        for (int list = 0; list < 3; list++) {
            OwnedFixture owned = ownedFixture(caseId);
            String label = list == 0 ? "blocks" : list == 1 ? "steps" : "targets";
            emit(rawSink, slot + ".ownership." + label + ".before.", snapshot(owned.record));
            if (list == 0) owned.suppliedBlocks.clear();
            else if (list == 1) owned.suppliedSteps.clear();
            else owned.suppliedTargets.clear();
            emit(rawSink, slot + ".ownership." + label + ".after.", snapshot(owned.record));
        }
    }
}
