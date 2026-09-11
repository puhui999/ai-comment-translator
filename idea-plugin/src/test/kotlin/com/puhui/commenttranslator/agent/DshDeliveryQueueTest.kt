package com.puhui.commenttranslator.agent

import org.junit.Assert.*
import org.junit.Test

class DshDeliveryQueueTest {
    @Test fun currentModeAndDestinationAreResolvedTogetherAndStayFrozenAcrossRetry() {
        val template = item()
        val pending = DshPendingContext(template.context, DshMode.GENERAL, "", null, false, resolveCurrentMode = true)
        var reads = 0
        val chosenSkills = mutableListOf("project-review")
        pending.resolveSnapshot { reads++; DshBrowserState("session-at-send", DshMode.CUSTOM, "Fresh current prompt", true, chosenSkills) }
        chosenSkills[0] = "different-skill"
        pending.resolveSnapshot { reads++; DshBrowserState("later-session", DshMode.GENERAL, "", true, chosenSkills) }
        assertEquals(1, reads)
        assertEquals("session-at-send", pending.sessionId)
        assertEquals(DshMode.CUSTOM, pending.mode)
        assertEquals("Fresh current prompt", pending.customPrompt)
        assertEquals(listOf("project-review"), pending.skillNames)
    }

    @Test fun explicitTutorSelectionKeepsTutorWhileResolvingTheFreshTarget() {
        val pending = item()
        pending.resolveSnapshot { DshBrowserState("fresh-target", DshMode.CUSTOM, "Other session persona", true, listOf("other-mode-skill")) }
        assertEquals("fresh-target", pending.sessionId)
        assertEquals(DshMode.TUTOR, pending.mode)
        assertEquals("", pending.customPrompt)
        assertTrue("Explicit Tutor must not inherit another mode's bindings", pending.skillNames.isEmpty())
    }

    @Test fun missingSessionIsResolvedOnceAndRemainsAbsentAfterAmbiguousFailure() {
        val queue = DshDeliveryQueue()
        val item = item()
        queue.add(item)
        val first = queue.begin()!!
        var resolutions = 0
        first.item.resolveDestination { resolutions++; null }
        assertTrue(queue.complete(first, success = false))
        assertNull(queue.begin())

        queue.retry()
        val second = queue.begin()!!
        second.item.resolveDestination { resolutions++; "session-created-after-first-send" }
        assertEquals(1, resolutions)
        assertNull(second.item.sessionId)
        assertSame(item.context, second.item.context)
        assertEquals(first.item.context.id, second.item.context.id)
    }

    @Test fun staleFailureAfterRestartCannotBlockOrFinishTheNewAttempt() {
        val queue = DshDeliveryQueue()
        queue.add(item())
        val oldAttempt = queue.begin()!!
        queue.connectionChanged()
        val newAttempt = queue.begin()!!

        assertFalse(queue.complete(oldAttempt, success = false))
        assertFalse(queue.failed)
        assertTrue(queue.isSending)
        assertEquals(1, queue.size)
        assertNull(queue.begin())
        assertTrue(queue.complete(newAttempt, success = true))
        assertTrue(queue.isEmpty)
        assertFalse(queue.isSending)
    }

    @Test fun staleSuccessCannotDiscardAnUnacknowledgedSelectionOrTheFollowingItem() {
        val queue = DshDeliveryQueue()
        val first = item()
        val second = item("second-selection")
        queue.add(first)
        queue.add(second)
        val oldAttempt = queue.begin()!!
        queue.connectionChanged()
        assertFalse(queue.complete(oldAttempt, success = true))
        assertEquals(2, queue.size)
        val retried = queue.begin()!!
        assertSame(first, retried.item)
        assertTrue(queue.complete(retried, success = true))
        assertSame(second, queue.begin()!!.item)
    }

    private fun item(id: String = "first-selection") = DshPendingContext(
        DshCodeContext(id, "println(1)", "/project/main.kt", "main.kt", "kt", 1, 1,
            DshCodeRange(1, 1, 1, 11, 0, 10), "42", true),
        DshMode.TUTOR, "", null, false,
    )
}
