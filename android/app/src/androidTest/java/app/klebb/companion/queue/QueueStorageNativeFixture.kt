// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Collections
import java.util.UUID
import java.util.concurrent.Executor
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Independent native controls: neither product storage nor its envelope primitive seeds these rows. */
internal class QueueStorageNativeFixture : AutoCloseable {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val suffix = UUID.randomUUID().toString()
    val alias = "klebb-queue-test-$suffix"
    private val databaseName = "queue-test-$suffix.db"
    val sql = Collections.synchronizedList(mutableListOf<String>())
    var db: QueueDatabase
        private set
    private val fixed = JSONObject(
        instrumentation.context.assets.open("queue-storage-inputs-v1.json")
            .bufferedReader(Charsets.UTF_8).use { it.readText() }
    ).getJSONArray("blobs")

    init {
        assertTrue("This gate is restricted to a clean emulator", Build.HARDWARE in setOf("ranchu", "goldfish"))
        assertEquals("The initial native target is API 35", 35, Build.VERSION.SDK_INT)
        assertFalse(context.getDatabasePath(databaseName).exists())
        assertFalse(keyStore().containsAlias(alias))
        db = openDatabase()
        assertEquals("wal", scalar("PRAGMA journal_mode"))
    }

    private fun openDatabase(): QueueDatabase =
        Room.databaseBuilder(context, QueueDatabase::class.java, databaseName)
            .setJournalMode(RoomDatabase.JournalMode.WRITE_AHEAD_LOGGING)
            .setQueryCallback({ statement, _ -> sql.add(statement) }, Executor { it.run() })
            .build()

    fun reopen() {
        db.close()
        db = openDatabase()
        assertEquals("wal", scalar("PRAGMA journal_mode"))
    }

    fun bytes(id: String): ByteArray {
        val item = (0 until fixed.length()).map { fixed.getJSONObject(it) }.single { it.getString("id") == id }
        val value = unhex(item.getString("utf8Hex"))
        assertEquals(item.getInt("bytes"), value.size)
        assertEquals(item.getString("sha256"), hex(MessageDigest.getInstance("SHA-256").digest(value)))
        return value
    }

    fun createIndependentKey() {
        assertFalse(keyStore().containsAlias(alias))
        val spec = KeyGenParameterSpec.Builder(
            alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        ).setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build()
        KeyGenerator.getInstance("AES", "AndroidKeyStore").apply { init(spec); generateKey() }
        assertTrue(keyStore().containsAlias(alias))
    }

    fun key(): SecretKey = keyStore().getKey(alias, null) as SecretKey
    fun aliasPresent(): Boolean = keyStore().containsAlias(alias)
    fun deleteOwnedAlias() = keyStore().deleteEntry(alias)
    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    // Independent compact-JSON AAD, not a call into the product store.
    fun aad(rowId: String, stream: String, kind: String): ByteArray =
        JSONArray(listOf("klebb-health-queue-v1", 1, kind, rowId, stream))
            .toString().toByteArray(Charsets.UTF_8)

    fun seed(rowId: String, stream: String, kind: BlobKind, input: String): QueueBlob {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(aad(rowId, stream, kind.stored))
        val encrypted = cipher.doFinal(bytes(input))
        val row = QueueBlob(rowId, stream, kind.stored, 1, cipher.iv, encrypted, cipher.iv.size + encrypted.size)
        db.blobs().insert(row)
        assertArrayEquals(bytes(input), independentOpen(db.blobs().find(rowId)))
        return row
    }

    fun seedAll() {
        createIndependentKey()
        seed("opaque-a", "stream-a", BlobKind.PAYLOAD, "steps")
        seed("opaque-b", "stream-a", BlobKind.PAYLOAD, "weight")
        seed("opaque-c", "stream-a", BlobKind.CURSOR, "cursor")
        seed("opaque-d", "stream-a", BlobKind.STATE, "operational")
        assertEquals(4, db.blobs().all().size)
    }

    fun independentOpen(row: QueueBlob): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, row.nonce))
        cipher.updateAAD(aad(row.rowId, row.localStreamId, row.kind))
        return cipher.doFinal(row.ciphertextAndTag)
    }

    data class Stored(
        val id: String, val stream: String, val kind: String, val version: Int,
        val nonceHex: String, val encryptedHex: String, val encryptedBytes: Int
    )

    fun snapshot(): List<Stored> = db.blobs().all().map {
        Stored(it.rowId, it.localStreamId, it.kind, it.version, hex(it.nonce.copyOf()),
            hex(it.ciphertextAndTag.copyOf()), it.encryptedBytes)
    }

    fun replaceEncrypted(rowId: String, encrypted: ByteArray) {
        val statement = db.openHelper.writableDatabase.compileStatement(
            "UPDATE queue_blobs SET ciphertext_and_tag = ? WHERE row_id = ?"
        )
        statement.use { it.bindBlob(1, encrypted.copyOf()); it.bindString(2, rowId); assertEquals(1, it.executeUpdateDelete()) }
    }

    fun moveStream(rowId: String, stream: String) {
        val statement = db.openHelper.writableDatabase.compileStatement(
            "UPDATE queue_blobs SET local_stream_id = ? WHERE row_id = ?"
        )
        statement.use { it.bindString(1, stream); it.bindString(2, rowId); assertEquals(1, it.executeUpdateDelete()) }
    }

    fun scalar(statement: String): String = db.openHelper.readableDatabase.query(statement).use {
        assertTrue(it.moveToFirst())
        it.getString(0)
    }

    /** Actual populated native files; absent temporary artifacts are recorded, never counted as scanned. */
    fun assertNoPlaintextArtifacts() {
        val path = context.getDatabasePath(databaseName)
        val files = path.parentFile!!.listFiles().orEmpty()
            .filter { it.isFile && (it.name == databaseName || it.name.startsWith("$databaseName-")) }
        assertTrue(files.any { it.name == databaseName && it.length() > 0 })
        assertTrue("A populated WAL must actually be inspected", files.any { it.name == "$databaseName-wal" && it.length() > 0 })
        val sentinels = listOf(
            "StepsRecord", "synthetic-provider-id", "org.example.synthetic.producer",
            "2001-10-29T03:04:05.987654321Z", "2001-10-28T00:30:00.123456789Z",
            "2001-10-28T02:30:00.987654321Z", "2001-02-03T04:05:06.123456789Z",
            "synthetic-client-id/", "Synthetic maker", "Synthetic model",
            "synthetic-read-token-before", "tenant-a", "instance-a", "store-a", "install-a", "epoch-a",
            "\"count\":\"1234\"",
            "\"nativeRecordIds\":[\"r1\",\"r2\"]", "\"value\":\"75.25\"",
            "f169411fc9ecb99344ee8dd40baef7a4e618a046ca63592d3cf01689a105bb0d"
        ).map { it.toByteArray(Charsets.UTF_8) }
        val artifactRoot = File(context.getExternalFilesDir(null), "queue-foundation-evidence/$suffix").apply { mkdirs() }
        val metadata = JSONArray()
        files.forEachIndexed { index, file ->
            val raw = file.readBytes()
            sentinels.forEach { assertFalse("Plaintext in populated native file ${file.name}", contains(raw, it)) }
            File(artifactRoot, "native-$index.bin").writeBytes(raw)
            metadata.put(JSONObject().put("file", file.name).put("bytes", raw.size)
                .put("sha256", hex(MessageDigest.getInstance("SHA-256").digest(raw))))
        }
        val diagnostics = android.os.ParcelFileDescriptor.AutoCloseInputStream(
            instrumentation.uiAutomation.executeShellCommand("logcat -d --pid=${android.os.Process.myPid()} -v brief")
        ).use { it.readBytes() }
        sentinels.forEach { assertFalse("Plaintext in current-process diagnostics", contains(diagnostics, it)) }
        File(artifactRoot, "diagnostics.bin").writeBytes(diagnostics)
        File(artifactRoot, "inspection.json").writeText(JSONObject()
            .put("nativeFiles", metadata).put("diagnosticBytes", diagnostics.size)
            .put("tempFilesPresent", files.filter { it.name !in setOf(databaseName, "$databaseName-wal", "$databaseName-shm") }.size)
            .put("temporaryFileLimit", "Only actual artifacts of this owned database were inspected")
            .put("scope", "API35 emulator; no hardware, deletion, backup or personal-data claim").toString())
    }

    override fun close() {
        db.close()
        context.deleteDatabase(databaseName)
        if (aliasPresent()) deleteOwnedAlias()
    }

    companion object {
        fun hex(value: ByteArray) = value.joinToString("") { "%02x".format(it.toInt() and 255) }
        fun unhex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        private fun contains(bytes: ByteArray, needle: ByteArray): Boolean =
            bytes.size >= needle.size && (0..bytes.size - needle.size).any { offset ->
                needle.indices.all { bytes[offset + it] == needle[it] }
            }
    }
}
