// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class InMemoryPairingSessionTest {
    private fun wire(id: String): ByteArray =
        (SharedWire.read("authority-v1.json")["cases"] as List<*>)
            .map { it.objectValue() }.first { it["id"] == id }["wire"].let { (it as String).toByteArray() }
    private fun session() = InMemoryPairingSession(SharedWire.protocol(),
        { Instant.parse("2026-10-28T03:55:00Z") }, { "install-a" }).also {
        it.approveDestination("https://health.example.test")
    }
    private fun paired(): InMemoryPairingSession = session().also {
        it.prepareGrant(wire("approved-grant"))
        it.acceptPairing(it.beginExchange(), wire("paired"))
    }

    @Test
    fun lifecycleClearPreventsFurtherCredentialRequests() {
        val session = paired()
        val request = session.capabilityRequest()
        session.clear()
        assertEquals("not-paired", assertThrows(ProtocolException::class.java) {
            session.capabilityRequest()
        }.code)
        assertEquals(null, session.destination)
        assertEquals(emptySet<String>(), session.categories)
        assertEquals(emptyMap<String, String>(), request.headers)
    }

    @Test
    fun lateExchangeReplyCannotRestoreAuthorityAfterClear() {
        val session = session()
        session.prepareGrant(wire("approved-grant"))
        val attempt = session.beginExchange()
        session.clear()
        assertEquals("cancelled", assertThrows(ProtocolException::class.java) {
            session.acceptPairing(attempt, wire("paired"))
        }.code)
        assertEquals("not-paired", assertThrows(ProtocolException::class.java) {
            session.capabilityRequest()
        }.code)
    }

    @Test
    fun serverRevocationClearsCredentialAndPendingAuthority() {
        val session = paired()
        val request = session.capabilityRequest()
        assertEquals("revoked", assertThrows(ProtocolException::class.java) {
            session.acceptResult(request,
                """{"version":1,"kind":"error","code":"revoked","retryable":false}""".toByteArray())
        }.code)
        assertEquals("not-paired", assertThrows(ProtocolException::class.java) {
            session.capabilityRequest()
        }.code)
    }

    @Test
    fun unapprovedDestinationAndExpiredGrantRefuseBeforeExchange() {
        val session = InMemoryPairingSession(SharedWire.protocol(),
            { Instant.parse("2026-10-28T04:00:00.000000001Z") }, { "install-a" })
        session.approveDestination("https://health.example.test")
        assertEquals("expired-grant", assertThrows(ProtocolException::class.java) {
            session.prepareGrant(wire("approved-grant"))
        }.code)
        session.approveDestination("https://elsewhere.example.test")
        assertEquals("invalid-destination", assertThrows(ProtocolException::class.java) {
            session.prepareGrant(wire("approved-grant"))
        }.code)
    }

    @Test
    fun exchangeBodyEchoesApprovedNamespaceAndCannotBeRenderedAsAuthority() {
        val session = session()
        session.prepareGrant(wire("approved-grant"))
        val attempt = session.beginExchange()
        val body = StrictJson.parse(attempt.body).objectValue()
        assertEquals("store-a", body["sourceStoreId"])
        assertEquals("install-a", body["installationId"])
        assertEquals(listOf("StepsRecord"), body["categories"])
        assertFalse(attempt.toString().contains("AAAAAAAA"))
        session.acceptPairing(attempt, wire("paired"))
        val request = session.statusRequest("StepsRecord")
        assertEquals("7", request.headers["Klebb-Health-Generation"])
        assertEquals("epoch-a", request.headers["Klebb-Health-Restore-Epoch"])
        assertEquals("1", request.headers["Klebb-Health-Protocol"])
        assertFalse(request.toString().contains("klebb_hc1_"))
        assertFalse(session.toString().contains("klebb_hc1_"))
    }

    @Test
    fun lateStatusReplyCannotRestoreAStoppedSession() {
        val session = paired()
        val request = session.statusRequest("StepsRecord")
        session.clear()
        assertEquals("cancelled", assertThrows(ProtocolException::class.java) {
            session.acceptResult(request, wire("stream-status"))
        }.code)
        assertEquals(emptyMap<String, String>(), request.headers)
    }

    @Test
    fun failedHttpExchangeCannotInstallAnOtherwiseValidCredential() {
        val session = session()
        session.prepareGrant(wire("approved-grant"))
        val attempt = session.beginExchange()
        assertEquals("request-refused", assertThrows(ProtocolException::class.java) {
            session.acceptPairing(attempt, wire("paired"), 503)
        }.code)
        assertEquals("not-paired", assertThrows(ProtocolException::class.java) {
            session.capabilityRequest()
        }.code)
        org.junit.Assert.assertTrue(attempt.body.all { it == 0.toByte() })
    }

    @Test
    fun capabilityReplyFromAnotherConnectorCannotRetainAuthority() {
        val session = paired()
        val request = session.capabilityRequest()
        val actual = StrictJson.parse(wire("connector-capabilities")).objectValue()
        val wrongConnector = ControlJson.text(actual + ("connectorId" to "another-connector")).toByteArray()
        assertEquals("binding-mismatch", assertThrows(ProtocolException::class.java) {
            session.acceptResult(request, wrongConnector)
        }.code)
        assertEquals("not-paired", assertThrows(ProtocolException::class.java) {
            session.capabilityRequest()
        }.code)
    }
}
