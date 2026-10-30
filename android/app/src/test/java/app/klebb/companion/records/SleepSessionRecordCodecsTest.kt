// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.records

import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.metadata.Metadata
import app.klebb.companion.protocol.StrictJson
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.lang.reflect.Modifier
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset

class SleepSessionRecordCodecsTest {
    private val fixed = StrictJson.parse(checkNotNull(javaClass.classLoader!!
        .getResourceAsStream("sleep-session-record-codecs-v1.json"))
        .use { it.readBytes() }) as Map<*, *>
    private fun case(id: String) = (fixed["cases"] as Map<*, *>)[id] as Map<*, *>
    private fun fields(body: Map<*, *>) = body["record"] as Map<*, *>
    private fun stages(input: Map<*, *>): MutableList<SleepSessionRecord.Stage> =
        (input["stages"] as List<*>).map { raw ->
            val row = raw as Map<*, *>
            SleepSessionRecord.Stage(Instant.parse(row["startTime"] as String),
                Instant.parse(row["endTime"] as String), (row["stage"] as Number).toInt())
        }.toMutableList()
    private fun metadata(input: Map<*, *>): Metadata = when (
        (input["metadata"] as Map<*, *>)["id"]) {
        "synthetic-provider-id" -> NativeMetadataFixture.full()
        "synthetic-provider-id-nullable" -> NativeMetadataFixture.nullable()
        "synthetic-provider-id-device-null-fields" -> NativeMetadataFixture.nullableDeviceFields()
        else -> error("Unknown independently fixed metadata profile")
    }
    private fun construct(body: Map<*, *>, mutable: List<SleepSessionRecord.Stage>? = null): SleepSessionRecord {
        val input = fields(body)
        fun offset(key: String) = (input[key] as String?)?.let { ZoneOffset.of(it) }
        return SleepSessionRecord(Instant.parse(input["startTime"] as String), offset("startZoneOffset"),
            Instant.parse(input["endTime"] as String), offset("endZoneOffset"), metadata(input),
            input["title"] as String?, input["notes"] as String?, mutable ?: stages(input))
    }
    private fun observe(body: Map<*, *>, record: SleepSessionRecord) {
        val expected = fields(body)
        assertEquals(expected["startTime"], record.startTime.toString())
        assertEquals(expected["startZoneOffset"], record.startZoneOffset?.toString())
        assertEquals(expected["endTime"], record.endTime.toString())
        assertEquals(expected["endZoneOffset"], record.endZoneOffset?.toString())
        assertEquals(expected["title"], record.title)
        assertEquals(expected["notes"], record.notes)
        val m = expected["metadata"] as Map<*, *>
        val native = record.metadata
        assertEquals((m["recordingMethod"] as Number).toInt(), native.recordingMethod)
        assertEquals(m["id"], native.id)
        assertEquals((m["dataOrigin"] as Map<*, *>)["packageName"], native.dataOrigin.packageName)
        assertEquals(m["lastModifiedTime"], native.lastModifiedTime.toString())
        assertEquals(m["clientRecordId"], native.clientRecordId)
        assertEquals(m["clientRecordVersion"], native.clientRecordVersion.toString())
        val device = m["device"] as Map<*, *>?
        if (device == null) assertNull(native.device) else {
            assertNotNull(native.device)
            assertEquals((device["type"] as Number).toInt(), native.device!!.type)
            assertEquals(device["manufacturer"], native.device!!.manufacturer)
            assertEquals(device["model"], native.device!!.model)
        }
        val ordered = expected["stages"] as List<*>
        assertEquals(ordered.size, record.stages.size)
        for ((index, raw) in ordered.withIndex()) {
            val stage = raw as Map<*, *>
            assertEquals(stage["startTime"], record.stages[index].startTime.toString())
            assertEquals(stage["endTime"], record.stages[index].endTime.toString())
            assertEquals((stage["stage"] as Number).toInt(), record.stages[index].stage)
        }
    }
    private fun assertEncoding(body: Map<*, *>, result: EncodedRecord) {
        assertEquals(body["record"], StrictJson.parse(result.recordJson.toByteArray(Charsets.UTF_8)))
        assertArrayEquals("independent whole UTF8 JSON", (body["recordJson"] as String).toByteArray(Charsets.UTF_8),
            result.recordJson.toByteArray(Charsets.UTF_8))
        assertEquals(body["nativeRecordId"], result.nativeRecordId)
        assertEquals(body["recordType"], result.recordType)
        assertEquals(body["serializerId"], result.serializerId)
        assertEquals((body["serializerVersion"] as Number).toInt(), result.serializerVersion)
        assertEquals(body["dataFamily"], result.dataFamily)
        assertEquals("EncodedRecord(redacted)", result.toString())
    }
    private fun checkCase(id: String) {
        val body = case(id)
        val record = construct(body)
        observe(body, record) // Actual SDK preconditions precede unsupported mapper behavior.
        assertEncoding(body, RecordCodecs.encode(record))
    }
    @Test fun l01CompletePrimaryKeepsMetadataOffsetsAndUnclassified300SecondGap() {
        val body = case("L01")
        val record = construct(body)
        observe(body, record)
        assertEquals(300000000000L, Duration.between(record.stages[0].endTime,
            record.stages[1].startTime).toNanos())
        assertEncoding(body, RecordCodecs.encode(record))
    }
    @Test fun l02EmptyTitleNullNotesAndEmptyStagesStayDistinct() = checkCase("L02")
    @Test fun l03NullableDeviceFieldsInt64MaxAndOneNanosecondSessionRemainExact() = checkCase("L03")
    @Test fun l04OpaqueStage9019RemainsNumericWithoutInterpretation() = checkCase("L04")
    @Test fun l05ReversedValidStagesStayInExposedOrder() = checkCase("L05")
    @Test fun l06NullOffsetUnicodeTextAndStageZeroKeepNanosecondBounds() = checkCase("L06")
    @Test fun l07PriorReturnedJsonSnapshotsSurviveClearAndReversedCallerReplacement() {
        val before = case("L07")
        val original = stages(fields(before))
        val mutable = original.toMutableList()
        val record = construct(before, mutable)
        assertSame("both observed SDKs retain the caller list", mutable, record.stages)
        observe(before, record)
        val first = RecordCodecs.encode(record)
        assertEncoding(before, first)
        fun mutationBody(key: String): Map<*, *> {
            val text = (fixed["mutation"] as Map<*, *>)[key] as String
            return linkedMapOf<Any?, Any?>().apply {
                putAll(before); put("record", StrictJson.parse(text.toByteArray(Charsets.UTF_8)))
                put("recordJson", text)
            }
        }
        mutable.clear()
        val empty = mutationBody("afterClearingCallerListExpectedNextRecordJson")
        observe(empty, record)
        assertEncoding(before, first)
        assertEncoding(empty, RecordCodecs.encode(record))
        mutable.addAll(original.reversed())
        val reversed = mutationBody("afterReplacingWithOriginalReversedStagesExpectedNextRecordJson")
        observe(reversed, record)
        assertEncoding(before, first)
        assertEncoding(reversed, RecordCodecs.encode(record))
    }
    @Test fun l08EightActualFallbackConstructorRefusalsPrecedeAnyMapperCall() {
        assertEquals("actual selected JVM fallback", 0, android.os.Build.VERSION.SDK_INT)
        val primary = fields(case("L01"))
        val m = metadata(primary)
        val valid = stages(primary)
        assertEquals(2, valid.size)
        val negatives = fixed["constructorRefusals"] as List<*>
        assertEquals(8, negatives.size)
        for (raw in negatives) {
            val input = raw as Map<*, *>
            assertEquals("java.lang.IllegalArgumentException", input["expectedSdkFallbackConstructorException"])
            val start = Instant.parse((input["startTime"] ?: primary["startTime"]) as String)
            val end = Instant.parse((input["endTime"] ?: primary["endTime"]) as String)
            if (input["construct"] == "Stage") {
                val stage = (input["stage"] as Number).toInt()
                assertThrows(input["id"] as String, IllegalArgumentException::class.java) {
                    SleepSessionRecord.Stage(start, end, stage)
                }
            } else {
                // Valid nested construction is outside the target-refusal assertion.
                val nested = stages(mapOf("stages" to input["stages"]))
                val startOffset = (primary["startZoneOffset"] as String?)?.let { ZoneOffset.of(it) }
                val endOffset = (primary["endZoneOffset"] as String?)?.let { ZoneOffset.of(it) }
                val title = primary["title"] as String?
                val notes = primary["notes"] as String?
                assertThrows(input["id"] as String, IllegalArgumentException::class.java) {
                    SleepSessionRecord(start, startOffset, end, endOffset, m, title, notes, nested)
                }
            }
        }
    }
    @Test fun l09BothPinned11TypedPublicGettersAndImmutable40RegistryStayExact() {
        val grouped = fixed["expectedPublicGetters"] as Map<*, *>
        assertEquals(11, grouped.values.sumOf { (it as Map<*, *>).size })
        for (version in listOf("1.1.0", "1.2.0-alpha06")) {
            val inventory = StrictJson.parse(File("../docs/sdk-inventory/$version-inventory.json").readBytes()) as Map<*, *>
            assertEquals(version, inventory["version"])
            val getters = (inventory["exposedGetters"] as List<*>).map { it as Map<*, *> }
            for ((name, expected) in grouped) assertEquals("$version $name", expected,
                getters.filter { it["class"] == name }.associate { it["method"] to it["type"] })
        }
        for ((name, expected) in grouped) {
            val methods = Class.forName(name as String).declaredMethods.filter {
                Modifier.isPublic(it.modifiers) && !Modifier.isStatic(it.modifiers) &&
                    it.parameterCount == 0 && it.name.matches(Regex("(get|is|has)[A-Z][A-Za-z0-9]*"))
            }.associate { it.name to it.genericReturnType.typeName }
            assertEquals(name, expected, methods)
        }
        assertNotNull(SleepSessionRecord::class.java.getConstructor(Instant::class.java, ZoneOffset::class.java,
            Instant::class.java, ZoneOffset::class.java, Metadata::class.java, String::class.java,
            String::class.java, List::class.java))
        assertNotNull(SleepSessionRecord.Stage::class.java.getConstructor(Instant::class.java,
            Instant::class.java, Int::class.javaPrimitiveType!!))
        val registry = (fixed["expectedRegistry"] as List<*>).toSet() + setOf("ExerciseSessionRecord")
        assertEquals(41, registry.size)
        assertEquals(registry, RecordCodecs.supportedRecordTypes)
        assertThrows(UnsupportedOperationException::class.java) {
            (RecordCodecs.supportedRecordTypes as MutableSet<String>).add("FutureRecord")
        }
    }
    @Test fun l10AllThirtyNinePriorGoldenUtf8JsonStringsRemainByteExact() {
        val golden = fixed["originalRecordJson"] as Map<*, *>
        val all = PriorOrdinaryRecordFixture.records()
        assertEquals(39, golden.size)
        assertEquals(golden.keys, all.map { it.javaClass.simpleName }.toSet())
        for (record in all) {
            val result = RecordCodecs.encode(record)
            assertArrayEquals(record.javaClass.simpleName,
                (golden[result.recordType] as String).toByteArray(Charsets.UTF_8),
                result.recordJson.toByteArray(Charsets.UTF_8))
        }
    }
}
