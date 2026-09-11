package com.puhui.commenttranslator.agent

import org.junit.Assert.*
import org.junit.Test
import java.awt.Color
import javax.swing.UIManager

class DshAppearanceTest {
    @Test fun `IDE dark and light themes retain exact UI colors`() {
        val keys = listOf("ToolWindow.background", "Label.foreground", "Label.disabledForeground", "Component.borderColor", "Component.focusColor")
        val original = keys.associateWith { UIManager.get(it) }
        try {
            UIManager.put("ToolWindow.background", Color(0x202326))
            UIManager.put("Label.foreground", Color(0xf1f2f3))
            UIManager.put("Label.disabledForeground", Color(0x909396))
            UIManager.put("Component.borderColor", Color(0x404346))
            UIManager.put("Component.focusColor", Color(0x3366cc))
            assertEquals(DshAppearance(true, "#202326", "#f1f2f3", "#909396", "#404346", "#3366cc"), DshAppearance.capture())

            UIManager.put("ToolWindow.background", Color(0xf6f7f8))
            UIManager.put("Label.foreground", Color(0x202326))
            val light = DshAppearance.capture()
            assertFalse(light.dark)
            assertEquals("#f6f7f8", light.background)
            assertEquals("#202326", light.foreground)
        } finally { original.forEach { (key, value) -> UIManager.put(key, value) } }
    }

    @Test fun `CSS colors have a bounded six digit representation without alpha or arbitrary content`() {
        assertEquals("#010aff", DshAppearance.hex(Color(1, 10, 255, 31)))
        assertTrue(DshAppearance.isDark(Color.BLACK))
        assertFalse(DshAppearance.isDark(Color.WHITE))
    }
}
