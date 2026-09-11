package com.puhui.commenttranslator.agent

import com.intellij.ide.BrowserUtil
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.swing.*

const val DSH_TOOL_WINDOW_ID = "DSH Agent"

class DshToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val controller = DshToolWindowController.getInstance(project)
        val panel = DshAgentPanel(project)
        val content = ContentFactory.getInstance().createContent(panel.component, "", false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
        controller.attach(panel)
    }
}

/** Keeps invocations made before lazy ToolWindow creation without re-reading the editor later. */
@Service(Service.Level.PROJECT)
class DshToolWindowController(private val project: Project) {
    private var panel: DshAgentPanel? = null
    private val waiting = ArrayDeque<Pair<DshCodeContext, DshMode?>>()

    fun show(context: DshCodeContext? = null, mode: DshMode? = null) {
        if (context != null) {
            val current = panel?.takeUnless { it.disposed }
            if (current == null) waiting.add(context to mode) else current.enqueue(context, mode)
        }
        ToolWindowManager.getInstance(project).getToolWindow(DSH_TOOL_WINDOW_ID)?.activate(null, true)
    }

    internal fun attach(next: DshAgentPanel) {
        panel = next
        while (waiting.isNotEmpty()) waiting.removeFirst().let { next.enqueue(it.first, it.second) }
    }

    companion object {
        fun getInstance(project: Project): DshToolWindowController = project.getService(DshToolWindowController::class.java)
    }
}

internal class DshAgentPanel(private val project: Project) : Disposable {
    val component = JPanel(BorderLayout())
    @Volatile var disposed = false
        private set
    private val runtime = DshRuntime.getInstance(project)
    private val properties = PropertiesComponent.getInstance(project)
    private val mode = JComboBox(DshMode.entries.toTypedArray())
    private val editPrompt = JButton("提示词…")
    private val retry = JButton("启动 / 重试")
    private val restart = JButton("重启")
    private val status = JTextArea(2, 24).apply {
        isEditable = false; lineWrap = true; wrapStyleWord = true; isOpaque = false
        border = BorderFactory.createEmptyBorder(5, 9, 5, 9)
    }
    private val cards = CardLayout()
    private val body = JPanel(cards)
    private val landing = JLabel("<html><div style='padding:16px'>正在启动 DSH…<br><br>完整 Agent 对话、工具、文件与会话将在这里打开。<br>助教模式在 DSH 原有能力上加入教学提示词。</div></html>")
    private val worker = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "dsh-ide-bridge-${project.locationHash}").apply { isDaemon = true }
    }
    private var browser: JBCefBrowser? = null
    private var endpoint: DshRuntimeEndpoint? = null
    @Volatile private var bridge: DshBridgeClient? = null
    private var browserState: DshBrowserState? = null
    private var customPrompt = properties.getValue(CUSTOM_PROMPT_KEY, "")
    private var changingMode = false
    private var previousMode = DshMode.fromWire(properties.getValue(MODE_KEY))
    private var modeRevision = 0L
    private val deliveries = DshDeliveryQueue()

    init {
        component.minimumSize = Dimension(320, 200)
        mode.selectedItem = DshMode.fromWire(properties.getValue(MODE_KEY))
        mode.isEnabled = false
        val top = JPanel(BorderLayout()).apply {
            val modes = JPanel(FlowLayout(FlowLayout.LEFT, 5, 3)).apply {
                add(JLabel("模式")); add(mode); add(editPrompt)
            }
            val controls = JPanel(FlowLayout(FlowLayout.LEFT, 5, 3)).apply {
                add(retry); add(restart)
                add(JButton("设置").apply { addActionListener { openSettings() } })
            }
            add(modes, BorderLayout.NORTH); add(controls, BorderLayout.SOUTH)
        }
        body.add(landing, "landing")
        component.add(top, BorderLayout.NORTH)
        component.add(body, BorderLayout.CENTER)
        component.add(status, BorderLayout.SOUTH)
        mode.toolTipText = "模式只增补系统提示词；DSH 原有工具与权限配置保持生效。"
        editPrompt.isEnabled = false
        mode.addActionListener {
            editPrompt.isEnabled = mode.isEnabled && selectedMode() == DshMode.CUSTOM
            if (!changingMode) {
                if (selectedMode() == DshMode.CUSTOM && customPrompt.isBlank()) {
                    val dialog = DshPromptDialog(project, customPrompt)
                    if (dialog.showAndGet()) {
                        customPrompt = dialog.prompt
                        properties.setValue(CUSTOM_PROMPT_KEY, customPrompt)
                    } else {
                        changingMode = true
                        mode.selectedItem = previousMode
                        changingMode = false
                        return@addActionListener
                    }
                }
                previousMode = selectedMode()
                applyMode()
            }
        }
        editPrompt.addActionListener {
            val dialog = DshPromptDialog(project, customPrompt)
            if (dialog.showAndGet()) {
                customPrompt = dialog.prompt
                properties.setValue(CUSTOM_PROMPT_KEY, customPrompt)
                applyMode()
            }
        }
        retry.addActionListener {
            deliveries.retry()
            if (bridge != null) flushQueue() else start()
        }
        restart.addActionListener { runtime.restart() }
        Disposer.register(this, runtime.addListener(::runtimeChanged))
        worker.scheduleWithFixedDelay(::pollState, 300, 1200, TimeUnit.MILLISECONDS)
        start()
    }

    fun enqueue(context: DshCodeContext, requestedMode: DshMode?) {
        val actualMode = requestedMode ?: selectedMode()
        if (requestedMode != null) {
            changingMode = true
            mode.selectedItem = requestedMode
            changingMode = false
            previousMode = requestedMode
        }
        // Source is frozen before focus moves; the destination is read from the bridge once before sending.
        deliveries.add(DshPendingContext(context, actualMode, customPrompt, null, false))
        deliveries.retry()
        status.text = "已保存选区，等待发送（${deliveries.size} 条）。"
        if (bridge == null) start() else flushQueue()
    }

    private fun start() {
        runtime.ensureStarted().exceptionally { null }
    }

    private fun runtimeChanged(state: DshRuntimeState) {
        if (disposed) return
        restart.isEnabled = state.phase == DshRuntimePhase.READY || state.phase == DshRuntimePhase.FAILED
        status.text = state.message + if (!deliveries.isEmpty) " · 等待发送 ${deliveries.size} 条选区" else ""
        if (state.phase == DshRuntimePhase.READY && state.endpoint != null) {
            if (endpoint != state.endpoint) {
                endpoint = state.endpoint
                bridge?.close()
                bridge = DshBridgeClient(state.endpoint)
                browserState = null
                deliveries.connectionChanged()
                showBrowser(state.endpoint.webUrl)
            }
        } else if (state.phase in setOf(DshRuntimePhase.IDLE, DshRuntimePhase.STOPPING, DshRuntimePhase.FAILED)) {
            endpoint = null
            bridge?.close(); bridge = null
            browserState = null
            deliveries.connectionChanged()
            mode.isEnabled = false
            editPrompt.isEnabled = false
            if (state.phase == DshRuntimePhase.FAILED) {
                landing.text = "<html><div style='padding:16px'>DSH 未能启动。<br>请查看下方原因，调整设置后点击“启动 / 重试”。</div></html>"
                cards.show(body, "landing")
            }
        }
    }

    private fun showBrowser(url: String) {
        if (!JBCefApp.isSupported()) {
            landing.text = "<html><div style='padding:16px'>当前 IDE 运行时不支持 JCEF。<br>请使用带 JCEF 的 JetBrains Runtime 后重新打开。<br><br>DSH 已启动，也可以在浏览器打开完整界面。</div></html>"
            if (body.getComponentZOrder(landing) >= 0) {
                val fallback = JPanel(BorderLayout()).apply {
                    add(landing, BorderLayout.CENTER)
                    add(JButton("在浏览器中打开 DSH").apply { addActionListener {
                        endpoint?.webUrl?.let { BrowserUtil.browse(it) }
                    } }, BorderLayout.SOUTH)
                }
                body.add(fallback, "fallback")
            }
            cards.show(body, "fallback")
            return
        }
        val current = browser ?: JBCefBrowser().also { created ->
            browser = created
            Disposer.register(this, created)
            created.jbCefClient.addRequestHandler(object : CefRequestHandlerAdapter() {
                override fun onBeforeBrowse(cefBrowser: CefBrowser?, frame: CefFrame?, request: CefRequest?, userGesture: Boolean, isRedirect: Boolean): Boolean {
                    if (frame?.isMain != true) return false
                    val target = request?.url ?: return false
                    if (target == "about:blank" || sameOrigin(target, endpoint?.webUrl)) return false
                    // The authenticated local app remains the top-level page; ordinary links use the system browser.
                    if (userGesture && runCatching { URI(target).scheme in setOf("http", "https") }.getOrDefault(false)) {
                        later { BrowserUtil.browse(target) }
                    }
                    return true
                }
            }, created.cefBrowser)
            created.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
                override fun onLoadError(cefBrowser: CefBrowser?, frame: CefFrame?, errorCode: CefLoadHandler.ErrorCode?, errorText: String?, failedUrl: String?) {
                    if (frame?.isMain == true && errorCode != CefLoadHandler.ErrorCode.ERR_ABORTED) later {
                        status.text = "DSH 页面加载失败，请点击重启后重试。"
                    }
                }
            }, created.cefBrowser)
            body.add(created.component, "browser")
        }
        cards.show(body, "browser")
        current.loadURL(url)
    }

    private fun applyMode() {
        val desired = selectedMode()
        val prompt = customPrompt
        properties.setValue(MODE_KEY, desired.wireName)
        val active = bridge ?: return
        val revision = ++modeRevision
        worker.execute {
            runCatching {
                val targetSession = active.state().sessionId
                active.setMode(desired, prompt, targetSession)
            }.fold(
                onSuccess = { later { if (bridge === active && revision == modeRevision) status.text = "已切换到${desired}模式。" } },
                onFailure = { failure -> later {
                    if (bridge === active && revision == modeRevision) {
                        changingMode = true
                        mode.selectedItem = browserState?.mode ?: DshMode.GENERAL
                        changingMode = false
                        previousMode = selectedMode()
                        status.text = "模式切换失败：${safeError(failure)}"
                    }
                } },
            )
        }
    }

    private fun pollState() {
        val active = bridge ?: return
        runCatching { active.state() }.onSuccess { next -> later {
            if (bridge !== active) return@later
            val previous = browserState
            browserState = next
            mode.isEnabled = next.browserConnected
            editPrompt.isEnabled = next.browserConnected && selectedMode() == DshMode.CUSTOM
            if (previous != next) {
                changingMode = true
                mode.selectedItem = next.mode
                changingMode = false
                previousMode = next.mode
                if (next.mode == DshMode.CUSTOM) {
                    customPrompt = next.customPrompt
                    properties.setValue(CUSTOM_PROMPT_KEY, customPrompt)
                }
                if (deliveries.isEmpty) status.text = if (next.browserConnected) "${next.mode}模式 · DSH 已连接" else "等待 DSH 页面连接…"
            }
            if (next.browserConnected) flushQueue()
        } }.onFailure { failure -> later {
            if (bridge === active && !deliveries.isSending) status.text = "DSH 连接异常：${safeError(failure)}"
        } }
    }

    private fun flushQueue() {
        if (disposed || browserState?.browserConnected != true) return
        val active = bridge ?: return
        val attempt = deliveries.begin() ?: return
        val item = attempt.item
        status.text = "正在发送选区…"
        worker.execute {
            runCatching {
                // When no session existed at capture time, resolve once, then retain it across retries.
                item.resolveDestination { active.state().sessionId }
                active.send(item.context, item.mode, item.customPrompt, item.sessionId)
            }.fold(
                onSuccess = { later {
                    if (!deliveries.complete(attempt, success = true)) return@later
                    status.text = "选区已加入 DSH 对话${if (deliveries.isEmpty) "。" else "，剩余 ${deliveries.size} 条。"}"
                    flushQueue()
                } },
                onFailure = { failure -> later {
                    if (!deliveries.complete(attempt, success = false)) return@later
                    status.text = "选区仍保留，发送失败：${safeError(failure)}。点击“启动 / 重试”重试。"
                } },
            )
        }
    }

    private fun selectedMode(): DshMode = mode.selectedItem as? DshMode ?: DshMode.GENERAL
    private fun openSettings() { ShowSettingsUtil.getInstance().showSettingsDialog(project, DshConfigurable::class.java) }
    private fun safeError(failure: Throwable): String = (failure.message ?: "连接未完成").take(300)
        .let { message -> endpoint?.bridgeToken?.takeIf { it.isNotBlank() }?.let { message.replace(it, "[redacted]") } ?: message }
    private fun later(action: () -> Unit) {
        ApplicationManager.getApplication().invokeLater { if (!disposed && !project.isDisposed) action() }
    }
    override fun dispose() {
        disposed = true
        worker.shutdownNow()
        bridge?.close(); bridge = null
        deliveries.clear()
    }

    companion object {
        private const val MODE_KEY = "comment-translator.dsh.mode"
        private const val CUSTOM_PROMPT_KEY = "comment-translator.dsh.customPrompt"
        internal fun sameOrigin(target: String, base: String?): Boolean = runCatching {
            if (base == null) return@runCatching false
            val left = URI(target); val right = URI(base)
            left.scheme == right.scheme && left.host == right.host && left.port == right.port && left.userInfo == null
        }.getOrDefault(false)
    }
}

private class DshPromptDialog(project: Project, initial: String) : DialogWrapper(project) {
    private val text = JTextArea(initial, 14, 54).apply { lineWrap = true; wrapStyleWord = true }
    val prompt: String get() = text.text.trim()
    init { title = "自定义模式提示词"; init() }
    override fun createCenterPanel(): JComponent = JPanel(BorderLayout(0, 8)).apply {
        add(JLabel("在 DSH 原有系统提示词后添加；不会移除工具能力。"), BorderLayout.NORTH)
        add(JScrollPane(text), BorderLayout.CENTER)
    }
    override fun getPreferredFocusedComponent(): JComponent = text
    override fun doValidate(): ValidationInfo? = when {
        prompt.isBlank() -> ValidationInfo("请输入自定义模式提示词。", text)
        prompt.length > 16_000 -> ValidationInfo("提示词最多 16,000 字符，请缩短后保存。", text)
        else -> null
    }
}
