package com.puhui.commenttranslator.agent

import java.awt.Color
import javax.swing.UIManager

/** Exact IDE colors sent to the embedded DSH client; no appearance preference is written to DSH. */
data class DshAppearance(
    val dark: Boolean,
    val background: String,
    val foreground: String,
    val muted: String,
    val border: String,
    val accent: String,
) {
    companion object {
        /** Captures the current Look and Feel on the IDE event thread. */
        fun capture(): DshAppearance {
            val background = color("ToolWindow.background", "Panel.background") ?: Color(0x2b2d30)
            val dark = isDark(background)
            val foreground = color("Label.foreground", "TextArea.foreground") ?: if (dark) Color(0xdfe1e5) else Color(0x1e1f22)
            return DshAppearance(
                dark, hex(background), hex(foreground),
                // Secondary text is readable help text, not a disabled control.
                hex(color("ContextHelp.foreground") ?: if (dark) Color(0x9da0a8) else Color(0x6c707e)),
                hex(color("Component.borderColor", "Separator.separatorColor") ?: if (dark) Color(0x43454a) else Color(0xd3d5db)),
                hex(color("Component.focusColor", "Link.activeForeground") ?: if (dark) Color(0x548af7) else Color(0x3574f0)),
            )
        }

        internal fun hex(color: Color): String = "#%02x%02x%02x".format(color.red, color.green, color.blue)
        internal fun isDark(color: Color): Boolean = color.red * 299 + color.green * 587 + color.blue * 114 < 128000
        private fun color(vararg names: String): Color? = names.firstNotNullOfOrNull(UIManager::getColor)
    }
}

/** A bounded user-facing delivery status rendered by the DSH extension itself. */
data class DshIdeStatus(val message: String, val kind: String, val queued: Int)

/** The only browser-originated host actions supported by the private bridge. */
data class DshIdeCommand(val id: String, val action: String)
