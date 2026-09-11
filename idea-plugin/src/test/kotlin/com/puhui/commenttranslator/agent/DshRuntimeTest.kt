package com.puhui.commenttranslator.agent

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

/** Exercises credential boundaries and exact process ownership without installing or contacting DSH. */
class DshRuntimeTest {
    @Test fun `authenticated web URL remains usable but does not appear in diagnostics`() {
        val url = "http://127.0.0.1:38127/?token=private-token#session"
        assertEquals(url, DshRuntimeProtocol.webUrl("dsh web: $url"))
        val endpoint = DshRuntimeEndpoint(url, "http://127.0.0.1:38128", "private-bridge-token")
        val state = DshRuntimeState(DshRuntimePhase.READY, "DSH 已就绪。", endpoint)
        assertFalse(endpoint.toString().contains("private"))
        assertFalse(state.toString().contains("private"))
        assertFalse(state.toString().contains("38127"))
    }

    @Test fun `startup accepts only local HTTP origins with explicit valid ports`() {
        assertTrue(DshRuntimeProtocol.isLoopbackHttp("http://127.0.0.1:4317/?token=a"))
        assertTrue(DshRuntimeProtocol.isLoopbackHttp("http://[::1]:4317/"))
        for (url in listOf("https://example.com:4317/", "http://example.com:4317/", "http://127.0.0.1.example.com:4317/", "file:///tmp/index.html", "http://user:secret@127.0.0.1:4317/", "http://127.0.0.1/", "http://127.0.0.1:0/", "http://127.0.0.1:99999/")) {
            assertFalse(url, DshRuntimeProtocol.isLoopbackHttp(url))
        }
    }

    @Test fun `bridge handshake rejects remote addresses credentials and unexpected fields`() {
        assertEquals("http://127.0.0.1:4318", DshRuntimeProtocol.bridgeEndpoint("DSH_IDE_BRIDGE_READY {\"endpoint\":\"http://127.0.0.1:4318\"}"))
        for (payload in listOf("{\"endpoint\":\"http://example.com:4318\"}", "{\"endpoint\":\"http://127.0.0.1:4318/?token=secret\"}", "{\"endpoint\":\"http://127.0.0.1:4318\",\"token\":\"secret\"}", "null", "[]", "not-json")) {
            assertNull(DshRuntimeProtocol.bridgeEndpoint("DSH_IDE_BRIDGE_READY $payload"))
        }
    }

    @Test fun `unrelated console messages cannot become browser navigation`() {
        assertNull(DshRuntimeProtocol.webUrl("Error connecting to http://127.0.0.1:1234"))
        assertNull(DshRuntimeProtocol.webUrl("dsh web: opening the default browser"))
        assertEquals("http://127.0.0.1:1234/?token=x", DshRuntimeProtocol.webUrl("\u001B[32mdsh web: http://127.0.0.1:1234/?token=x\u001B[0m"))
    }

    @Test fun `Node requirement is based on numeric major version`() {
        assertTrue(DshRuntimeProtocol.supportsNode("v24.1.0\n"))
        assertTrue(DshRuntimeProtocol.supportsNode("v25.0.0"))
        assertFalse(DshRuntimeProtocol.supportsNode("v22.20.0"))
        assertFalse(DshRuntimeProtocol.supportsNode("v9.10.0"))
        assertFalse(DshRuntimeProtocol.supportsNode("Node version 24"))
    }

    @Test fun `diagnostics preserve only known failure classes and never raw paths or secrets`() {
        val error = DshRuntimeProtocol.diagnostic("ERR_MODULE_NOT_FOUND /private/secret-project token=private-token")
        assertNotNull(error)
        assertFalse(error!!.contains("private"))
        assertFalse(error.contains("token"))
        assertNull(DshRuntimeProtocol.diagnostic("Authorization: Bearer private-token"))
        assertNull(DshRuntimeProtocol.diagnostic("const customerSecret = 'private-token'"))
    }

    @Test fun `shutdown never targets unowned or newly started processes`() {
        val registry = DshProcessRegistry()
        val old = FakeProcess(); val unrelated = FakeProcess(); val replacement = FakeProcess()
        registry.add(old)
        val stopping = registry.snapshot()
        registry.add(replacement)
        stopping.forEach(registry::stop)
        registry.stop(unrelated)
        assertTrue(old.destroyed)
        assertFalse(unrelated.destroyed)
        assertFalse(replacement.destroyed)
        assertEquals(listOf(replacement), registry.snapshot())
    }

    @Test fun `removing a completed process prevents a later stop`() {
        val registry = DshProcessRegistry()
        val completed = FakeProcess()
        registry.add(completed); registry.remove(completed); registry.stop(completed)
        assertFalse(completed.destroyed)
        assertTrue(registry.snapshot().isEmpty())
    }

    @Test fun `project home keys are stable and do not disclose project paths`() {
        val path = "/Users/example/private-project"
        assertEquals(DshRuntimeProtocol.projectKey(path), DshRuntimeProtocol.projectKey(path))
        assertNotEquals(DshRuntimeProtocol.projectKey(path), DshRuntimeProtocol.projectKey("/Users/example/other-project"))
        assertTrue(DshRuntimeProtocol.projectKey(path).matches(Regex("[a-f0-9]{32}")))
    }

    private class FakeProcess : Process() {
        var destroyed = false
        override fun getOutputStream() = ByteArrayOutputStream()
        override fun getInputStream() = ByteArrayInputStream(byteArrayOf())
        override fun getErrorStream() = ByteArrayInputStream(byteArrayOf())
        override fun waitFor(): Int = 0
        override fun waitFor(timeout: Long, unit: TimeUnit): Boolean = true
        override fun exitValue(): Int = 0
        override fun destroy() { destroyed = true }
        override fun isAlive(): Boolean = !destroyed
    }
}
