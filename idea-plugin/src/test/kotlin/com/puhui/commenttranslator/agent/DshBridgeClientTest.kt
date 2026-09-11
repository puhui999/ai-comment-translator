package com.puhui.commenttranslator.agent

import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpServer
import org.junit.Assert.*
import org.junit.Test
import java.net.InetSocketAddress

class DshBridgeClientTest {
    @Test fun modeChangeKeepsExplicitNullAsDefaultInsteadOfTargetingLaterCurrentSession() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        var received = ""
        server.createContext("/mode") { exchange ->
            received = exchange.requestBody.bufferedReader().readText()
            val body = "{\"accepted\":true}".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            DshBridgeClient(endpoint(server)).use { client ->
                client.setMode(DshMode.TUTOR, "", null)
                val payload = JsonParser.parseString(received).asJsonObject
                assertTrue(payload.has("sessionId"))
                assertTrue(payload.get("sessionId").isJsonNull)
            }
        } finally { server.stop(0) }
    }

    @Test fun sendsAuthenticatedFrozenContextToItsCapturedSession() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        var received = ""
        var authorization: String? = null
        server.createContext("/context") { exchange ->
            authorization = exchange.requestHeaders.getFirst("Authorization")
            received = exchange.requestBody.bufferedReader().readText()
            val body = "{\"sessionId\":\"session-at-click\",\"accepted\":true}".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            DshBridgeClient(endpoint(server)).use { client ->
                val selection = DshCodeContext("selection-id", "const x = `a`;\n", "/project/src/a.ts", "src/a.ts", "ts",
                    3, 3, DshCodeRange(3, 1, 4, 1, 12, 27), "9934", true)
                assertEquals("session-at-click", client.send(selection, DshMode.TUTOR, "", "session-at-click"))
                val payload = JsonParser.parseString(received).asJsonObject
                assertEquals("Bearer bridge-test-token", authorization)
                assertEquals(selection.text, payload.get("text").asString)
                assertEquals("session-at-click", payload.get("sessionId").asString)
                assertEquals("selection-id", payload.get("id").asString)
                assertEquals("tutor", payload.get("mode").asString)
                assertTrue(payload.get("unsaved").asBoolean)
                assertEquals("9934", payload.get("documentVersion").asString)
                assertEquals(27, payload.getAsJsonObject("range").get("endOffset").asInt)
            }
        } finally { server.stop(0) }
    }

    @Test fun rejectsExternalTransportAndRedactsBridgeErrors() {
        try {
            DshBridgeClient(DshRuntimeEndpoint("http://127.0.0.1/", "https://example.com", "secret"))
            fail("External destinations must not receive bridge credentials")
        } catch (_: IllegalArgumentException) { }

        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/state") { exchange ->
            val body = "{\"error\":\"rejected bridge-test-token\"}".toByteArray()
            exchange.sendResponseHeaders(403, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            DshBridgeClient(endpoint(server)).use { client ->
                try { client.state(); fail("Rejected request must fail") }
                catch (failure: IllegalStateException) {
                    assertFalse(failure.message.orEmpty().contains("bridge-test-token"))
                    assertTrue(failure.message.orEmpty().contains("[redacted]"))
                }
            }
        } finally { server.stop(0) }
    }

    private fun endpoint(server: HttpServer) = DshRuntimeEndpoint("http://127.0.0.1:1234/",
        "http://127.0.0.1:${server.address.port}", "bridge-test-token")
}
