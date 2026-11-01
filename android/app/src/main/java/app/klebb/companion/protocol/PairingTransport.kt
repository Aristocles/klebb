// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.net.URI
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection

class ApprovedOrigin private constructor(val text: String, private val uri: URI) {
    companion object {
        fun parse(text: String): ApprovedOrigin {
            val uri = try { URI(text) } catch (_: Exception) { throw ProtocolException("invalid-destination") }
            val host = uri.host
            if (uri.scheme != "https" || host == null || host != host.lowercase(Locale.ROOT) ||
                host.any { it.code > 127 } || uri.rawUserInfo != null ||
                !uri.rawPath.isNullOrEmpty() || uri.rawQuery != null || uri.rawFragment != null ||
                uri.port == 443 || uri.port == 0 || uri.port > 65535 ||
                uri.toASCIIString() != text) throw ProtocolException("invalid-destination")
            val authority = canonicalHost(host) + if (uri.port < 0) "" else ":${uri.port}"
            if (uri.rawAuthority != authority) throw ProtocolException("invalid-destination")
            return ApprovedOrigin(text, uri)
        }
        private fun canonicalHost(host: String): String {
            fun invalid(): Nothing = throw ProtocolException("invalid-destination")
            if (!host.startsWith("[")) {
                val last = host.removeSuffix(".").substringAfterLast('.')
                if (Regex("([0-9]+|0x[0-9a-f]*)").matches(last)) {
                    val words = host.split('.')
                    if (words.size != 4 || words.any {
                        !Regex("(0|[1-9][0-9]{0,2})").matches(it) || it.toInt() > 255
                    }) invalid()
                }
                return host
            }
            val literal = host.removeSurrounding("[", "]")
            if (!Regex("[0-9a-f:]+").matches(literal)) invalid()
            val halves = literal.split("::")
            fun words(part: String) = if (part.isEmpty()) emptyList<Int>() else part.split(':').map {
                it.toIntOrNull(16) ?: invalid()
            }
            val left = words(halves.first())
            val right = if (halves.size == 2) words(halves.last()) else emptyList()
            if (halves.size > 2 || left.size + right.size > 8 ||
                (halves.size == 1 && left.size != 8) ||
                (halves.size == 2 && left.size + right.size >= 8)) invalid()
            val all = left + List(8 - left.size - right.size) { 0 } + right
            var bestStart = -1
            var bestLength = 1
            var index = 0
            while (index < all.size) {
                if (all[index] != 0) { index++; continue }
                val start = index
                while (index < all.size && all[index] == 0) index++
                if (index - start > bestLength) { bestStart = start; bestLength = index - start }
            }
            fun text(values: List<Int>) = values.joinToString(":") { it.toString(16) }
            val normalized = if (bestStart < 0) text(all) else
                text(all.take(bestStart)) + "::" + text(all.drop(bestStart + bestLength))
            return "[$normalized]"
        }
    }
    fun target(path: String): URL {
        if (!Regex("^/[A-Za-z0-9/_-]+$").matches(path) || path.startsWith("//")) {
            throw ProtocolException("invalid-destination")
        }
        return URI(text + path).toURL()
    }
    fun validate(target: URL) {
        val destination = target.toURI()
        if (destination.scheme != uri.scheme || destination.host != uri.host ||
            destination.port != uri.port || destination.rawUserInfo != null ||
            destination.rawQuery != null || destination.rawFragment != null) {
            throw ProtocolException("invalid-destination")
        }
    }
    override fun toString() = text
}
class TransportResponse(val status: Int, val body: ByteArray) {
    override fun toString() = "TransportResponse($status)"
}
class PairingTransport internal constructor(
    private val origin: ApprovedOrigin,
    private val open: (URL) -> HttpsURLConnection
) {
    constructor(origin: ApprovedOrigin) : this(origin, { it.openConnection() as HttpsURLConnection })
    val destination: String get() = origin.text
    private class Request(val connection: HttpsURLConnection) {
        val cancelled = AtomicBoolean()
        val expired = AtomicBoolean()
    }
    private val active = AtomicReference<Request?>()
    private val cancelled = AtomicBoolean()

    fun request(method: String, path: String, body: ByteArray? = null,
                headers: Map<String, String> = emptyMap()): TransportResponse {
        if (cancelled.get()) throw ProtocolException("cancelled")
        if (method !in setOf("GET", "POST") || (body?.size ?: 0) > 1048576) {
            throw ProtocolException("invalid-message")
        }
        val allowed = setOf("Authorization", "Klebb-Health-Protocol", "Klebb-Health-Generation",
            "Klebb-Health-Restore-Epoch")
        if (headers.any { (name, value) -> name !in allowed || value.any { it < ' ' || it == '\u007f' } }) {
            throw ProtocolException("invalid-message")
        }
        val target = origin.target(path)
        origin.validate(target)
        val connection = open(target)
        val ticket = Request(connection)
        if (!active.compareAndSet(null, ticket)) {
            connection.disconnect()
            throw ProtocolException("request-active")
        }
        val timer = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "pairing-deadline").apply { isDaemon = true }
        }
        val deadline = timer.schedule({
            ticket.expired.set(true)
            connection.disconnect()
        }, 10, TimeUnit.SECONDS)
        try {
            if (cancelled.get() || ticket.cancelled.get()) throw ProtocolException("cancelled")
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = 3000
            connection.readTimeout = 3000
            connection.requestMethod = method
            headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            if (body != null) {
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(body.size)
                if (cancelled.get() || ticket.cancelled.get()) throw ProtocolException("cancelled")
                connection.outputStream.use {
                    if (cancelled.get() || ticket.cancelled.get()) throw ProtocolException("cancelled")
                    it.write(body)
                }
            }
            if (cancelled.get() || ticket.cancelled.get()) throw ProtocolException("cancelled")
            val status = connection.responseCode
            if (status in 300..399) throw ProtocolException("redirect-refused")
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val bytes = stream?.use {
                val result = java.io.ByteArrayOutputStream()
                val block = ByteArray(8192)
                while (true) {
                    if (ticket.cancelled.get()) throw ProtocolException("cancelled")
                    if (ticket.expired.get()) throw ProtocolException("timeout")
                    val count = it.read(block)
                    if (count < 0) break
                    if (result.size() + count > 1048576) throw ProtocolException("limit-exceeded")
                    result.write(block, 0, count)
                }
                result.toByteArray()
            } ?: byteArrayOf()
            if (ticket.cancelled.get()) throw ProtocolException("cancelled")
            if (ticket.expired.get()) throw ProtocolException("timeout")
            return TransportResponse(status, bytes)
        } finally {
            deadline.cancel(false)
            timer.shutdownNow()
            connection.disconnect()
            active.compareAndSet(ticket, null)
        }
    }
    fun cancel() {
        cancelled.set(true)
        active.get()?.let {
            it.cancelled.set(true)
            it.connection.disconnect()
        }
    }
}
