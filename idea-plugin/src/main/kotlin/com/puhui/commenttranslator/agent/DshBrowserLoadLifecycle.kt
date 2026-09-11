package com.puhui.commenttranslator.agent

/** Distinguishes the current page handshake from stale timers after a reload or runtime restart. */
internal class DshBrowserLoadLifecycle {
    private var generation = 0L
    private var waiting = false

    fun begin(): Long { waiting = true; return ++generation }
    fun finish() { waiting = false; generation++ }
    fun expire(attempt: Long): Boolean {
        if (!waiting || attempt != generation) return false
        waiting = false
        return true
    }
}
