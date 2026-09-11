package com.puhui.commenttranslator.agent

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

/** Launcher preferences only; model credentials remain in DSH's own settings. */
data class DshSettingsState(
    var nodePath: String = "",
    var npmPath: String = "",
    var installDirectory: String = "",
    var autoInstall: Boolean = true,
    var startupTimeoutSeconds: Int = 120,
)

/** Stores launcher configuration outside project files without changing existing DSH configuration. */
@Service(Service.Level.APP)
@State(name = "PuhuiDshLauncher", storages = [Storage("puhui-dsh-launcher.xml")])
class DshSettings : PersistentStateComponent<DshSettingsState> {
    @Volatile private var value = DshSettingsState()

    /** Returns non-secret launcher settings. */
    override fun getState(): DshSettingsState = value

    /** Restores a detached settings object. */
    override fun loadState(state: DshSettingsState) { value = state.copy() }

    /** Saves validated launcher settings for the next runtime start. */
    fun update(state: DshSettingsState) { value = state.copy() }

    companion object {
        const val PINNED_VERSION = "0.1.5-rc.2"
        const val CONFIGURABLE_ID = "com.puhui.comment-translator.dsh.settings"

        /** Returns the application-wide preferences. */
        fun getInstance(): DshSettings = service()
    }
}
