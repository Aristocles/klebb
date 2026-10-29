// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.queue

import java.security.GeneralSecurityException

sealed interface QueueResult<out T>
data class Ok<out T>(val value: T) : QueueResult<T>
data class Blocked(val state: String, val cause: String) : QueueResult<Nothing>
data class QueueEnvelope(val version: Int, val nonce: ByteArray, val ciphertextAndTag: ByteArray)
enum class BlobKind(val stored: String) { PAYLOAD("payload"), CURSOR("cursor"), STATE("state") }

interface QueueCipher {
    fun seal(plaintext: ByteArray, aad: ByteArray): QueueEnvelope
    fun open(envelope: QueueEnvelope, aad: ByteArray): ByteArray
}

internal class UnsupportedEnvelope : GeneralSecurityException()
internal class MalformedEnvelope : GeneralSecurityException()
internal class QueueKeyUnavailable : GeneralSecurityException()
