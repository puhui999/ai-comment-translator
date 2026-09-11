package com.puhui.commenttranslator.agent

import org.junit.Assert.*
import org.junit.Test

class DshBrowserLoadLifecycleTest {
    @Test fun missingHandshakeExpiresOnceAndRetryStartsAFreshAttempt() {
        val load = DshBrowserLoadLifecycle()
        val first = load.begin()
        assertTrue(load.expire(first))
        assertFalse(load.expire(first))
        val retry = load.begin()
        assertFalse(load.expire(first))
        assertTrue(load.expire(retry))
    }

    @Test fun successfulHandshakeAndRuntimeRestartInvalidateOutstandingTimers() {
        val load = DshBrowserLoadLifecycle()
        val first = load.begin()
        load.finish()
        assertFalse(load.expire(first))
        val afterRestart = load.begin()
        assertFalse(load.expire(first))
        load.finish()
        assertFalse(load.expire(afterRestart))
    }
}
