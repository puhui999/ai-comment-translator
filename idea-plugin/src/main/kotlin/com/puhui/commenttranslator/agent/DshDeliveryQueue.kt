package com.puhui.commenttranslator.agent

/** One immutable source snapshot with a destination resolved only once, including an absent session. */
internal class DshPendingContext(
    val context: DshCodeContext,
    val mode: DshMode,
    val customPrompt: String,
    initialSessionId: String?,
    private var destinationResolved: Boolean,
) {
    var sessionId: String? = initialSessionId
        private set

    fun resolveDestination(resolve: () -> String?) {
        if (!destinationResolved) {
            sessionId = resolve()
            destinationResolved = true
        }
    }
}

/** EDT-owned queue; attempt identity isolates late HTTP completions after a runtime restart. */
internal class DshDeliveryQueue {
    private val pending = ArrayDeque<DshPendingContext>()
    private var inFlight: Attempt? = null
    var failed: Boolean = false
        private set
    val size: Int get() = pending.size
    val isEmpty: Boolean get() = pending.isEmpty()
    val isSending: Boolean get() = inFlight != null
    class Attempt internal constructor(val item: DshPendingContext)

    fun add(item: DshPendingContext) { pending.add(item) }
    fun retry() { failed = false }
    fun connectionChanged() { inFlight = null; failed = false }
    fun begin(): Attempt? {
        if (failed || inFlight != null) return null
        return pending.firstOrNull()?.let { Attempt(it).also { attempt -> inFlight = attempt } }
    }
    fun complete(attempt: Attempt, success: Boolean): Boolean {
        if (inFlight !== attempt) return false
        inFlight = null
        if (success) pending.removeFirst() else failed = true
        return true
    }
    fun clear() { pending.clear(); connectionChanged() }
}
