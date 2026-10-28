// SPDX-License-Identifier: AGPL-3.0-only
package app.klebb.companion.protocol

import com.sun.net.httpserver.HttpsConfigurator
import com.sun.net.httpserver.HttpsServer
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.URL
import java.nio.file.Files
import java.nio.file.Path
import java.security.KeyStore
import java.security.cert.Certificate
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.TrustManagerFactory
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private object TestTls {
    val context: SSLContext by lazy {
        val folder = Files.createTempDirectory("pairing-tls-")
        val path = folder.resolve("server.p12")
        val password = "ephemeral-test-only".toCharArray()
        val javaRoot = Path.of(System.getProperty("java.home"), "bin")
        val keytool = javaRoot.resolve("keytool.exe").takeIf { Files.exists(it) }
            ?: javaRoot.resolve("keytool")
        val process = ProcessBuilder(keytool.toString(), "-genkeypair", "-alias", "server",
            "-keyalg", "RSA", "-keysize", "2048", "-dname", "CN=localhost",
            "-ext", "SAN=dns:localhost", "-validity", "2", "-startdate", "-1d",
            "-storetype", "PKCS12", "-keystore", path.toString(), "-storepass", String(password),
            "-keypass", String(password), "-noprompt").redirectErrorStream(true).start()
        process.inputStream.readBytes()
        check(process.waitFor() == 0) { "Ephemeral TLS certificate generation failed." }
        val store = KeyStore.getInstance("PKCS12").apply {
            Files.newInputStream(path).use { load(it, password) }
        }
        val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
            init(store, password)
        }
        val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(store)
        }
        Files.delete(path)
        Files.delete(folder)
        SSLContext.getInstance("TLS").apply { init(keys.keyManagers, trust.trustManagers, null) }
    }
}

class PairingTransportTest {
    private lateinit var approved: HttpsServer
    private lateinit var rejected: HttpsServer
    private lateinit var origin: ApprovedOrigin
    private val approvedRequests = AtomicInteger()
    private val rejectedRequests = AtomicInteger()
    private val rejectedAuthority = AtomicInteger()
    private val authority = "only-a-synthetic-redirect-grant"
    private val open = { url: URL ->
        (url.openConnection() as HttpsURLConnection).apply {
            // Only this test trusts its ephemeral CA; normal hostname checks stay.
            sslSocketFactory = TestTls.context.socketFactory
        }
    }

    @Before
    fun servers() {
        fun server() = HttpsServer.create(InetSocketAddress("localhost", 0), 0).apply {
            httpsConfigurator = HttpsConfigurator(TestTls.context)
        }
        approved = server()
        rejected = server()
        origin = ApprovedOrigin.parse("https://localhost:${approved.address.port}")
        rejected.createContext("/capture") { exchange ->
            rejectedRequests.incrementAndGet()
            val body = String(exchange.requestBody.readBytes())
            if (body.contains(authority) ||
                exchange.requestHeaders.getFirst("Authorization")?.contains(authority) == true) {
                rejectedAuthority.incrementAndGet()
            }
            exchange.sendResponseHeaders(200, 2)
            exchange.responseBody.use { it.write("{}".toByteArray()) }
        }
        approved.createContext("/redirect") { exchange ->
            approvedRequests.incrementAndGet()
            exchange.requestBody.readBytes()
            exchange.responseHeaders.add("Location", "https://localhost:${rejected.address.port}/capture")
            exchange.sendResponseHeaders(307, -1)
            exchange.close()
        }
        approved.createContext("/success") { exchange ->
            approvedRequests.incrementAndGet()
            exchange.requestBody.readBytes()
            exchange.sendResponseHeaders(200, 2)
            exchange.responseBody.use { it.write("{}".toByteArray()) }
        }
        approved.start()
        rejected.start()
    }

    @After
    fun stop() {
        approved.stop(0)
        rejected.stop(0)
    }

    @Test
    fun redirectNeverForwardsTheGrantBodyOrBearerToAnotherOrigin() {
        val transport = PairingTransport(origin, open)
        var code: String? = null
        try {
            transport.request("POST", "/redirect", """{"grant":"$authority"}""".toByteArray(),
                mapOf("Authorization" to "Bearer $authority"))
        } catch (error: ProtocolException) { code = error.code }
        assertEquals(0, rejectedAuthority.get())
        assertEquals(0, rejectedRequests.get())
        assertEquals(1, approvedRequests.get())
        assertEquals("redirect-refused", code)
    }

    @Test
    fun approvedHttpsUsesActualTransportAndReturnsTheWireBytes() {
        val response = PairingTransport(origin, open).request("POST", "/success", "{}".toByteArray())
        assertEquals(200, response.status)
        assertEquals("{}", String(response.body))
        assertEquals(1, approvedRequests.get())
    }

    @Test
    fun lookalikesUserinfoWrongPortsAndHttpRefuseBeforeAnyRequest() {
        for (target in listOf("http://localhost:${approved.address.port}/capture",
            "https://localhost.evil.test/capture", "https://elsewhere.example.test/capture",
            "https://user@localhost:${approved.address.port}/capture",
            "https://localhost:${rejected.address.port}/capture")) {
            assertEquals("invalid-destination", assertThrows(ProtocolException::class.java) {
                origin.validate(URL(target))
            }.code)
        }
        assertThrows(ProtocolException::class.java) {
            PairingTransport(origin, open).request("POST", "//localhost/capture", authority.toByteArray())
        }
        assertEquals(0, approvedRequests.get())
        assertEquals(0, rejectedRequests.get())
    }

    @Test
    fun untrustedCertificateIsNotAcceptedByTheProductionConnectionFactory() {
        assertThrows(SSLHandshakeException::class.java) {
            PairingTransport(origin).request("POST", "/success", authority.toByteArray())
        }
        assertEquals(0, approvedRequests.get())
    }

    @Test
    fun trustedCaDoesNotBypassHostnameVerification() {
        assertThrows(SSLHandshakeException::class.java) {
            PairingTransport(ApprovedOrigin.parse("https://127.0.0.1:${approved.address.port}"), open)
                .request("POST", "/success", authority.toByteArray())
        }
        assertEquals(0, approvedRequests.get())
    }

    @Test
    fun cancellationDuringConnectionCreationCannotLaterWriteAuthority() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val delivered = ByteArrayOutputStream()
        val transport = PairingTransport(origin) { url ->
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            object : HttpsURLConnection(url) {
                override fun connect() {}
                override fun disconnect() {}
                override fun usingProxy() = false
                override fun getCipherSuite() = "TLS_TEST"
                override fun getLocalCertificates(): Array<Certificate>? = null
                override fun getServerCertificates(): Array<Certificate> = emptyArray()
                override fun getOutputStream() = delivered
                override fun getResponseCode() = 200
                override fun getInputStream() = ByteArrayInputStream("{}".toByteArray())
            }
        }
        val worker = Executors.newSingleThreadExecutor()
        try {
            val outcome = worker.submit(Callable {
                try {
                    transport.request("POST", "/success", authority.toByteArray())
                    "accepted"
                } catch (failure: ProtocolException) { failure.code }
            })
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            transport.cancel()
            release.countDown()
            val result = outcome.get(5, TimeUnit.SECONDS)
            assertEquals(0, delivered.size())
            assertEquals("cancelled", result)
        } finally {
            release.countDown()
            worker.shutdownNow()
        }
    }
}
