package com.puhui.commenttranslator.agent

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.ConfigurationException
import java.awt.BorderLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import java.nio.file.Path
import javax.swing.*

/** Native launcher settings; the complete model and Agent configuration lives inside DSH. */
class DshConfigurable : Configurable {
    private val node = JTextField(42)
    private val npm = JTextField(42)
    private val installation = JTextField(42)
    private val autoInstall = JCheckBox("首次启动时安装固定版本的 DSH 到 IDE 缓存目录")
    private val timeout = JSpinner(SpinnerNumberModel(120, 15, 600, 15))

    /** Names the configuration page. */
    override fun getDisplayName(): String = "DSH Agent"

    /** Builds a form without launching Node, npm, or DSH. */
    override fun createComponent(): JComponent {
        val form = JPanel(GridBagLayout())
        var row = 0
        fun add(label: String, component: JComponent) {
            form.add(JLabel(label).apply { labelFor = component }, GridBagConstraints().apply {
                gridx = 0; gridy = row; anchor = GridBagConstraints.NORTHWEST; insets = Insets(7, 0, 7, 14)
            })
            form.add(component, GridBagConstraints().apply {
                gridx = 1; gridy = row++; weightx = 1.0; fill = GridBagConstraints.HORIZONTAL; insets = Insets(7, 0, 7, 0)
            })
        }
        add("Node 可执行文件", node)
        add("", JLabel("需要 Node.js 24 或以上；留空自动查找。可填写完整路径。"))
        add("npm 可执行文件", npm)
        add("", JLabel("留空使用 Node 附带的 npm；也可指定 npm-cli.js。"))
        add("已有 DSH 安装目录", installation)
        add("", JLabel("留空使用插件管理的独立安装；可选择 npm 安装目录或 DSH 包目录。"))
        add("", autoInstall)
        add("", JLabel("固定版本：@deepseek-ai/dsh@${DshSettings.PINNED_VERSION}；首次安装需要联网。"))
        add("启动超时（秒）", timeout)
        add("", JLabel("每个项目使用独立的 DSH 会话和设置，关闭项目时结束插件启动的进程。"))
        add("", JLabel("模型与 Key 在 DSH 面板设置内配置；已有 DSH 配置不会被覆盖。"))
        add("", JLabel("修改启动设置后，在 DSH 面板点击重启生效。"))
        reset()
        return JPanel(BorderLayout()).apply { add(form, BorderLayout.NORTH) }
    }

    /** Compares the form to the saved launcher settings. */
    override fun isModified(): Boolean {
        try { timeout.commitEdit() } catch (_: Exception) { return true }
        return readForm() != DshSettings.getInstance().state
    }

    /** Validates paths without performing installation or starting a runtime. */
    override fun apply() {
        try { timeout.commitEdit() } catch (_: Exception) { throw ConfigurationException("启动超时必须为 15–600 秒。") }
        val next = readForm()
        if (next.startupTimeoutSeconds !in 15..600) throw ConfigurationException("启动超时必须为 15–600 秒。")
        listOf(next.nodePath, next.npmPath, next.installDirectory).filter { it.isNotBlank() }.forEach {
            try { Path.of(it) } catch (_: Exception) { throw ConfigurationException("请输入有效路径，不要填写命令参数。") }
        }
        DshSettings.getInstance().update(next)
    }

    /** Restores saved values without reading any credentials. */
    override fun reset() {
        val saved = DshSettings.getInstance().state
        node.text = saved.nodePath; npm.text = saved.npmPath; installation.text = saved.installDirectory
        autoInstall.isSelected = saved.autoInstall; timeout.value = saved.startupTimeoutSeconds.coerceIn(15, 600)
    }

    private fun readForm() = DshSettingsState(
        nodePath = node.text.trim(), npmPath = npm.text.trim(), installDirectory = installation.text.trim(),
        autoInstall = autoInstall.isSelected, startupTimeoutSeconds = (timeout.value as Number).toInt(),
    )
}
