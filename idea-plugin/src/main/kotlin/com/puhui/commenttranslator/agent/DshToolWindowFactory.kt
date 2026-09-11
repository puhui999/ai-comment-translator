package com.puhui.commenttranslator.agent

import com.intellij.ide.BrowserUtil
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
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
import java.awt.Color
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

/** Only the loading/error fallback is native; every normal control and status belongs to DSH. */
internal class DshAgentPanel(private val project: Project) : Disposable {
    val component = JPanel(BorderLayout())
    @Volatile var disposed = false
        private set
    private val runtime = DshRuntime.getInstance(project)
    private val cards = CardLayout()
    private val body = JPanel(cards)
    private val landingMessage = JTextArea(5, 28).apply {
        isEditable = false; lineWrap = true; wrapStyleWord = true; isOpaque = false
        border = BorderFactory.createEmptyBorder(16, 16, 8, 16)
    }
    private val retry = JButton("启动 / 重试")
    private val externalBrowser = JButton("在浏览器中打开 DSH").apply { isVisible = false }
    private val landing = JPanel(BorderLayout()).apply {
        add(landingMessage, BorderLayout.CENTER)
        add(JPanel(FlowLayout(FlowLayout.LEFT, 8, 8)).apply {
            add(retry)
            add(JButton("设置").apply { addActionListener { openSettings() } })
            add(externalBrowser)
        }, BorderLayout.SOUTH)
    }
    private val worker = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "dsh-ide-bridge-${project.locationHash}").apply { isDaemon = true }
    }
    private var browser: JBCefBrowser? = null
    @Volatile private var endpoint: DshRuntimeEndpoint? = null
    @Volatile private var bridge: DshBridgeClient? = null
    private var browserState: DshBrowserState? = null
    private var browserLoadStarted = false
    private var browserVisible = false
    private val browserLoad = DshBrowserLoadLifecycle()
    private var handshakeTimer: Timer? = null
    private var connectionProblem = false
    private val deliveries = DshDeliveryQueue()
    private val handledCommands = LinkedHashSet<String>()
    @Volatile private var appearance = DshAppearance.capture()
    @Volatile private var ideStatus = DshIdeStatus("正在启动 DSH…", "busy", 0)
    // The worker owns these publication fingerprints; UI events only replace immutable snapshots.
    private var publishedBridge: DshBridgeClient? = null
    private var publishedAppearance: DshAppearance? = null
    private var publishedStatus: DshIdeStatus? = null

    init {
        component.minimumSize = Dimension(320, 200)
        body.add(landing, "landing")
        component.add(body, BorderLayout.CENTER)
        retry.addActionListener { retryPending() }
        externalBrowser.addActionListener { endpoint?.webUrl?.let(BrowserUtil::browse) }
        applyNativeAppearance()
        landingMessage.text = ideStatus.message
        Disposer.register(this, runtime.addListener(::runtimeChanged))
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(LafManagerListener.TOPIC,
            LafManagerListener { later {
                appearance = DshAppearance.capture()
                applyNativeAppearance()
                pushIdeState()
            } })
        worker.scheduleWithFixedDelay(::pollState, 300, 700, TimeUnit.MILLISECONDS)
        start()
    }

    /** Freezes source now; the target and current-mode choice are resolved together before sending. */
    fun enqueue(context: DshCodeContext, requestedMode: DshMode?) {
        deliveries.add(DshPendingContext(context, requestedMode ?: DshMode.GENERAL, "", null, false,
            resolveCurrentMode = requestedMode == null))
        deliveries.retry()
        setStatus("已保存选区，等待发送。", "busy")
        if (bridge == null) start() else flushQueue()
    }

    private fun start() { runtime.ensureStarted().exceptionally { null } }

    private fun retryPending() {
        deliveries.retry()
        val active = bridge
        when {
            active == null -> start()
            !browserLoadStarted || !browserVisible -> prepareBrowser(active)
            else -> flushQueue()
        }
    }

    private fun runtimeChanged(state: DshRuntimeState) {
        if (disposed) return
        setStatus(state.message, when (state.phase) {
            DshRuntimePhase.FAILED -> "error"
            DshRuntimePhase.INSTALLING, DshRuntimePhase.STARTING, DshRuntimePhase.STOPPING -> "busy"
            else -> "idle"
        })
        retry.isEnabled = state.phase !in setOf(DshRuntimePhase.INSTALLING, DshRuntimePhase.STARTING, DshRuntimePhase.STOPPING)
        if (state.phase == DshRuntimePhase.READY && state.endpoint != null) {
            if (endpoint !== state.endpoint) {
                endpoint = state.endpoint
                bridge?.close()
                val active = DshBridgeClient(state.endpoint)
                bridge = active
                browserState = null
                connectionProblem = false
                deliveries.connectionChanged()
                handledCommands.clear()
                finishBrowserLoad()
                browserLoadStarted = false
                showLanding("正在加载 DSH 工作台…")
                prepareBrowser(active)
            }
        } else if (state.phase != DshRuntimePhase.READY) {
            endpoint = null
            bridge?.close(); bridge = null
            browserState = null
            connectionProblem = false
            deliveries.connectionChanged()
            finishBrowserLoad()
            browserLoadStarted = false
            externalBrowser.isVisible = false
            showLanding(state.message)
        }
    }

    /** Sends IDE colors before Chromium requests the authenticated DSH page. */
    private fun prepareBrowser(active: DshBridgeClient) {
        worker.execute {
            runCatching { publishState(active, force = true) }.fold(
                onSuccess = { later {
                    if (bridge !== active) return@later
                    val current = endpoint ?: return@later
                    runCatching { showBrowser(current.webUrl) }.onFailure {
                        finishBrowserLoad()
                        browserLoadStarted = false
                        browser?.let { failed -> body.remove(failed.component); Disposer.dispose(failed) }
                        browser = null
                        setStatus("无法打开 DSH 页面，请点击重试；若仍失败，请检查 IDE 的 JCEF 运行时。", "error")
                        showLanding(ideStatus.message)
                    }
                } },
                onFailure = { failure -> later {
                    if (bridge !== active) return@later
                    setStatus("无法准备 DSH 页面：${safeError(failure)}", "error")
                    showLanding(ideStatus.message)
                } },
            )
        }
    }

    private fun showBrowser(url: String) {
        if (!JBCefApp.isSupported()) {
            externalBrowser.isVisible = true
            showLanding("当前 IDE 运行时不支持 JCEF。请使用带 JCEF 的 JetBrains Runtime，或在浏览器打开完整 DSH 界面。")
            browserLoadStarted = true
            return
        }
        val current = browser ?: JBCefBrowser.createBuilder().setCreateImmediately(false).build().also { created ->
            browser = created
            created.component.background = Color.decode(appearance.background)
            created.setPageBackgroundColor(appearance.background)
            Disposer.register(this, created)
            created.jbCefClient.addRequestHandler(object : CefRequestHandlerAdapter() {
                override fun onBeforeBrowse(cefBrowser: CefBrowser?, frame: CefFrame?, request: CefRequest?, userGesture: Boolean, isRedirect: Boolean): Boolean {
                    if (frame?.isMain != true) return false
                    val target = request?.url ?: return false
                    if (target == "about:blank" || sameOrigin(target, endpoint?.webUrl)) return false
                    if (userGesture && runCatching { URI(target).scheme in setOf("http", "https") }.getOrDefault(false)) {
                        later { BrowserUtil.browse(target) }
                    }
                    return true
                }
            }, created.cefBrowser)
            created.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
                override fun onLoadEnd(cefBrowser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                    if (frame?.isMain == true) later { browser?.setPageBackgroundColor(appearance.background) }
                }
                override fun onLoadError(cefBrowser: CefBrowser?, frame: CefFrame?, errorCode: CefLoadHandler.ErrorCode?, errorText: String?, failedUrl: String?) {
                    if (frame?.isMain == true && errorCode != CefLoadHandler.ErrorCode.ERR_ABORTED) later {
                        if (browser !== created || !sameOrigin(failedUrl ?: "", endpoint?.webUrl)) return@later
                        finishBrowserLoad()
                        browserLoadStarted = false
                        setStatus("DSH 页面加载失败，请点击重试。", "error")
                        showLanding(ideStatus.message)
                    }
                }
            }, created.cefBrowser)
            body.add(created.component, "browser")
        }
        current.setPageBackgroundColor(appearance.background)
        current.component.background = Color.decode(appearance.background)
        current.createImmediately()
        browserLoadStarted = true
        // Keep the same-colored native loading page until the DSH client handshake completes.
        showLanding("正在加载 DSH 工作台…")
        awaitBrowserHandshake()
        current.loadURL(url)
    }

    private fun pollState() {
        val active = bridge ?: return
        runCatching {
            publishState(active)
            val next = active.state()
            val commands = active.commands()
            later {
                if (bridge !== active) return@later
                val previous = browserState
                browserState = next
                if (connectionProblem) {
                    connectionProblem = false
                    if (!deliveries.failed && !deliveries.isSending) setStatus("", "idle")
                }
                if (next.browserConnected && browserLoadStarted && browser != null && !browserVisible) {
                    finishBrowserLoad()
                    cards.show(body, "browser")
                    browserVisible = true
                    setStatus("", "idle")
                }
                if (previous?.browserConnected != next.browserConnected && !next.browserConnected && deliveries.isEmpty) {
                    setStatus("等待 DSH 页面连接…", "busy")
                } else if (previous?.browserConnected == false && next.browserConnected && !deliveries.failed && !deliveries.isSending) {
                    setStatus("", "idle")
                }
                for (command in commands) {
                    if (!handledCommands.add(command.id)) continue
                    if (handledCommands.size > 256) handledCommands.remove(handledCommands.first())
                    when (command.action) {
                        "settings" -> openSettings()
                        "restart" -> { runtime.restart(); return@later }
                        "retry" -> retryPending()
                    }
                }
                if (next.browserConnected) flushQueue()
            }
        }.onFailure { failure -> later {
            if (bridge === active) {
                connectionProblem = true
                if (!deliveries.isSending && !deliveries.failed) setStatus("DSH 连接异常：${safeError(failure)}", "error")
            }
        } }
    }

    private fun flushQueue() {
        if (disposed || browserState?.browserConnected != true) return
        val active = bridge ?: return
        val attempt = deliveries.begin() ?: return
        val item = attempt.item
        setStatus("正在发送选区…", "busy")
        worker.execute {
            runCatching {
                item.resolveSnapshot { active.state() }
                active.send(item.context, item.mode, item.customPrompt, item.sessionId, item.skillNames)
            }.fold(
                onSuccess = { later {
                    if (!deliveries.complete(attempt, success = true)) return@later
                    setStatus(if (deliveries.isEmpty) "选区已加入 DSH 对话。" else "选区已发送，继续处理队列。", if (deliveries.isEmpty) "success" else "busy")
                    flushQueue()
                } },
                onFailure = { failure -> later {
                    val cancelled = failure is DshSelectionCanceledException
                    if (!deliveries.complete(attempt, success = cancelled)) return@later
                    if (cancelled) {
                        setStatus("这条选区已被 DSH 取消；如仍需处理，请重新选择并发送。", "error")
                        flushQueue()
                        return@later
                    }
                    setStatus("选区仍保留，发送失败：${safeError(failure)}。可在 DSH 中重试。", "error")
                } },
            )
        }
    }

    private fun setStatus(message: String, kind: String) {
        ideStatus = DshIdeStatus(message.take(300), kind, deliveries.size.coerceAtMost(10000))
        if (!browserVisible) landingMessage.text = ideStatus.message
        pushIdeState()
    }

    private fun pushIdeState() {
        val active = bridge ?: return
        if (disposed) return
        worker.execute { runCatching { if (bridge === active) publishState(active) } }
    }

    private fun publishState(active: DshBridgeClient, force: Boolean = false) {
        val colors = appearance
        val status = ideStatus
        if (force || active !== publishedBridge || colors != publishedAppearance || status != publishedStatus) {
            active.updateIdeState(colors, status)
            publishedBridge = active; publishedAppearance = colors; publishedStatus = status
        }
    }

    private fun applyNativeAppearance() {
        val background = Color.decode(appearance.background)
        component.background = background; body.background = background; landing.background = background
        landingMessage.foreground = Color.decode(appearance.foreground)
        browser?.component?.background = background
        browser?.setPageBackgroundColor(appearance.background)
    }

    private fun showLanding(message: String) {
        landingMessage.text = message
        browserVisible = false
        cards.show(body, "landing")
    }

    private fun awaitBrowserHandshake() {
        handshakeTimer?.stop()
        val attempt = browserLoad.begin()
        handshakeTimer = Timer(60_000) {
            if (!disposed && !browserVisible && browserLoad.expire(attempt)) {
                setStatus("DSH 页面在 60 秒内未完成连接。请点击重试重新加载；若持续失败，请检查 DSH 安装或重新打开项目。", "error")
                showLanding(ideStatus.message)
            }
        }.apply { isRepeats = false; start() }
    }

    private fun finishBrowserLoad() {
        handshakeTimer?.stop(); handshakeTimer = null
        browserLoad.finish()
    }

    private fun openSettings() { ShowSettingsUtil.getInstance().showSettingsDialog(project, DshConfigurable::class.java) }
    private fun safeError(failure: Throwable): String = (failure.message ?: "连接未完成").take(300)
        .let { message -> endpoint?.bridgeToken?.takeIf { it.isNotBlank() }?.let { message.replace(it, "[redacted]") } ?: message }
    private fun later(action: () -> Unit) {
        ApplicationManager.getApplication().invokeLater { if (!disposed && !project.isDisposed) action() }
    }
    override fun dispose() {
        disposed = true
        finishBrowserLoad()
        worker.shutdownNow()
        bridge?.close(); bridge = null
        deliveries.clear()
    }

    companion object {
        internal fun sameOrigin(target: String, base: String?): Boolean = runCatching {
            if (base == null) return@runCatching false
            val left = URI(target); val right = URI(base)
            left.scheme == right.scheme && left.host == right.host && left.port == right.port && left.userInfo == null
        }.getOrDefault(false)
    }
}
