package com.puhui.commenttranslator.agent

import com.google.gson.JsonParser
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import java.io.InputStream
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Duration
import java.util.Base64
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Public lifecycle states; messages never contain process output or authenticated URLs. */
enum class DshRuntimePhase { IDLE, INSTALLING, STARTING, READY, STOPPING, FAILED }

/** Private transport endpoints, passed directly to the browser/bridge and never logged. */
class DshRuntimeEndpoint(val webUrl: String, val bridgeEndpoint: String, val bridgeToken: String) {
    override fun toString(): String = "DshRuntimeEndpoint(credentials=redacted)"
}

/** A UI-safe state object whose optional endpoint has a redacted diagnostic representation. */
data class DshRuntimeState(val phase: DshRuntimePhase, val message: String, val endpoint: DshRuntimeEndpoint? = null)

/** Tracks exact child-process instances; shutdown never searches for processes by executable or port. */
internal class DshProcessRegistry {
    private val processes = java.util.concurrent.ConcurrentHashMap.newKeySet<Process>()
    fun add(process: Process) { processes.add(process) }
    fun remove(process: Process) { processes.remove(process) }

    /** Terminates only the supplied tracked processes and their own descendants. */
    fun stop(process: Process) {
        if (!processes.remove(process)) return
        val descendants = try { process.descendants().use { it.toList() } } catch (_: Exception) { emptyList() }
        descendants.asReversed().forEach { try { it.destroy() } catch (_: Exception) { } }
        try { process.destroy() } catch (_: Exception) { }
        try { if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly() } catch (_: Exception) {
            try { process.destroyForcibly() } catch (_: Exception) { }
        }
        descendants.asReversed().forEach { try { if (it.isAlive) it.destroyForcibly() } catch (_: Exception) { } }
        if (!process.waitFor(3, TimeUnit.SECONDS)) throw IllegalStateException("无法确认 DSH 进程已退出。")
        descendants.forEach { if (it.isAlive) it.onExit().get(3, TimeUnit.SECONDS) }
    }

    /** Detaches the current set so a delayed stop cannot target the next launch. */
    fun snapshot(): List<Process> = processes.toList()
}

/** Validates private startup messages without exposing rejected strings in exceptions. */
internal object DshRuntimeProtocol {
    private val ansi = Regex("\u001B\\[[;\\d]*[ -/]*[@-~]")

    fun webUrl(line: String): String? {
        val clean = line.replace(ansi, "")
        val marker = "dsh web: "
        val offset = clean.indexOf(marker)
        if (offset < 0) return null
        val value = clean.substring(offset + marker.length).takeWhile { !it.isWhitespace() }
        return value.takeIf { isLoopbackHttp(it) }
    }

    fun bridgeEndpoint(line: String): String? {
        if (!line.startsWith("DSH_IDE_BRIDGE_READY ")) return null
        return try {
            val json = JsonParser.parseString(line.substringAfter(' ')).asJsonObject
            if (json.keySet() != setOf("endpoint")) return null
            json.get("endpoint").asString.takeIf { isLoopbackHttp(it, allowCredentials = false) }
        } catch (_: Exception) { null }
    }

    fun isLoopbackHttp(value: String, allowCredentials: Boolean = true): Boolean = try {
        val uri = URI(value)
        uri.scheme == "http" && uri.host in setOf("127.0.0.1", "localhost", "[::1]", "::1") &&
            uri.port in 1..65535 && uri.rawUserInfo == null &&
            (allowCredentials || (uri.rawQuery == null && uri.rawFragment == null && uri.path.orEmpty() in setOf("", "/")))
    } catch (_: Exception) { false }

    fun supportsNode(version: String): Boolean = Regex("^v?(\\d+)\\.\\d+\\.\\d+(?:[-+].*)?$")
        .matchEntire(version.trim())?.groupValues?.get(1)?.toIntOrNull()?.let { it >= 24 } == true

    fun projectKey(path: String): String = MessageDigest.getInstance("SHA-256").digest(path.toByteArray(Charsets.UTF_8))
        .take(16).joinToString("") { "%02x".format(it) }

    /** Reduces known failures to fixed labels; arbitrary output, paths, tokens and source never survive. */
    fun diagnostic(line: String): String? = when {
        line.contains("ERR_MODULE_NOT_FOUND") || line.contains("Cannot find module") -> "缺少 DSH 依赖模块，请重新安装固定版本。"
        line.contains("EADDRINUSE") -> "本地监听地址已被占用。"
        line.contains("EACCES") || line.contains("EPERM") -> "启动进程没有访问所需文件或端口的权限。"
        line.contains("ENOTFOUND") || line.contains("ECONNRESET") || line.contains("ETIMEDOUT") -> "网络连接或域名解析失败。"
        line.contains("SyntaxError") -> "DSH 或扩展配置存在语法错误。"
        line.contains("Unsupported engine", ignoreCase = true) || line.contains("EBADENGINE") -> "Node 版本不满足某项依赖要求。"
        else -> null
    }
}

/** Owns a project-isolated, on-demand DSH process, its installation and private startup handshake. */
@Service(Service.Level.PROJECT)
class DshRuntime(private val project: Project) : Disposable {
    private val lock = Any()
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "dsh-runtime-launcher").apply { isDaemon = true } }
    private val io = Executors.newCachedThreadPool { Thread(it, "dsh-runtime-io").apply { isDaemon = true } }
    private val processes = DshProcessRegistry()
    private val listeners = CopyOnWriteArrayList<(DshRuntimeState) -> Unit>()
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).followRedirects(HttpClient.Redirect.NEVER).build()
    private var generation = 0L
    private var disposed = false
    private var pending: CompletableFuture<DshRuntimeEndpoint>? = null
    private var stopBarrier = CompletableFuture.completedFuture(Unit)
    @Volatile var snapshot = DshRuntimeState(DshRuntimePhase.IDLE, "打开 DSH 时启动 Agent。")
        private set

    /** Starts lazily and shares the same future for concurrent callers. */
    fun ensureStarted(): CompletableFuture<DshRuntimeEndpoint> = synchronized(lock) {
        if (disposed || project.isDisposed) return CompletableFuture.failedFuture(CancellationException("项目已关闭。"))
        if (!TrustedProjects.isProjectTrusted(project)) {
            val message = "项目尚未受信任，请先通过 IDE 的项目信任提示确认后使用 DSH。"
            publish(DshRuntimeState(DshRuntimePhase.FAILED, message))
            return CompletableFuture.failedFuture(IllegalStateException(message))
        }
        snapshot.endpoint?.takeIf { snapshot.phase == DshRuntimePhase.READY }?.let { return CompletableFuture.completedFuture(it) }
        pending?.takeIf { !it.isDone }?.let { return it }
        val epoch = ++generation
        val future = CompletableFuture<DshRuntimeEndpoint>()
        pending = future
        publish(DshRuntimeState(DshRuntimePhase.STARTING, "正在检查 Node 和 DSH…"))
        val afterStop = stopBarrier
        worker.execute { launch(epoch, future, afterStop) }
        future
    }

    /** Convenience entry for callers wanting lifecycle updates from first launch. */
    fun start(listener: (DshRuntimeState) -> Unit) { addListener(listener); ensureStarted() }

    /** Registers an EDT-delivered listener and immediately supplies the current state. */
    fun addListener(listener: (DshRuntimeState) -> Unit): Disposable {
        listeners.add(listener)
        deliver(listener, snapshot)
        return Disposable { listeners.remove(listener) }
    }

    /** Cancels installation/startup and asynchronously stops only this project's owned processes. */
    fun stop() {
        val stopped = synchronized(lock) {
            if (disposed) return
            generation++
            pending?.completeExceptionally(CancellationException("DSH 已停止。")); pending = null
            publish(DshRuntimeState(DshRuntimePhase.STOPPING, "正在停止 DSH…"))
            val prior = stopBarrier
            val completed = CompletableFuture<Unit>()
            stopBarrier = completed
            StopRequest(generation, processes.snapshot(), prior, completed)
        }
        io.execute {
            try {
                stopped.prior.join()
                stopped.processes.forEach(processes::stop)
                synchronized(lock) { if (!disposed && generation == stopped.epoch) publish(DshRuntimeState(DshRuntimePhase.IDLE, "DSH 已停止。")) }
                stopped.completed.complete(Unit)
            } catch (_: Exception) {
                stopped.completed.completeExceptionally(IllegalStateException("无法确认之前的 DSH 进程已退出，请关闭项目后重试。"))
                synchronized(lock) { if (!disposed && generation == stopped.epoch) publish(DshRuntimeState(DshRuntimePhase.FAILED, "无法确认 DSH 已退出，请关闭项目后重试。")) }
            }
        }
    }

    /** Keeps project settings and sessions while replacing the owned runtime. */
    fun restart(): CompletableFuture<DshRuntimeEndpoint> { stop(); return ensureStarted() }

    /** Cancels startup and releases owned resources without blocking the IDE event thread. */
    override fun dispose() {
        val owned = synchronized(lock) {
            if (disposed) return
            disposed = true; generation++
            pending?.completeExceptionally(CancellationException("项目已关闭。")); pending = null
            listeners.clear()
            processes.snapshot()
        }
        worker.shutdownNow()
        io.execute { owned.forEach(processes::stop); http.close() }
        io.shutdown()
    }

    private data class StopRequest(val epoch: Long, val processes: List<Process>, val prior: CompletableFuture<Unit>, val completed: CompletableFuture<Unit>)

    private fun launch(epoch: Long, future: CompletableFuture<DshRuntimeEndpoint>, afterStop: CompletableFuture<Unit>) {
        var runtime: Process? = null
        val diagnostic = AtomicReference<String?>()
        try {
            // A new process must never open the previous process's session/config files before it exits.
            afterStop.get()
            checkActive(epoch)
            val settings = DshSettings.getInstance().state.copy()
            val node = findExecutable(settings.nodePath, "node") ?: fail("未找到 Node.js；请在 DSH Agent 设置中填写 Node 24 或以上的可执行文件。")
            if (!DshRuntimeProtocol.supportsNode(capture(listOf(node.toString(), "--version"), epoch))) fail("DSH 需要 Node.js 24 或以上，请更新 DSH Agent 的 Node 路径。")
            val root = Path.of(PathManager.getSystemPath(), "puhui-comment-translator", "dsh")
            Files.createDirectories(root)
            val entry = resolveInstallation(root, settings, node, epoch)
            checkActive(epoch)
            val workspace = project.basePath?.let(Path::of)?.takeIf(Files::isDirectory) ?: fail("请先打开一个本地项目目录。")
            val home = root.resolve("projects").resolve(DshRuntimeProtocol.projectKey(workspace.toAbsolutePath().normalize().toString())).resolve("home")
            Files.createDirectories(home)
            val bridge = extractBridge(home.resolve("ide-integration"))
            val token = ByteArray(32).also { SecureRandom().nextBytes(it) }.let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
            val url = AtomicReference<String?>()
            val bridgeEndpoint = AtomicReference<String?>()
            update(epoch, DshRuntimeState(DshRuntimePhase.STARTING, "正在启动完整 DSH 工作台…"))
            runtime = spawn(listOf(node.toString(), entry.toString(), "--profile", "web", "--patch", bridge.toString(), "--no-open", "--host", "127.0.0.1", "--port", "0"), epoch, workspace,
                mapOf("DSH_HOME" to home.toString(), "DSH_IDE_BRIDGE_TOKEN" to token, "DSH_IDE_PROJECT_DIR" to workspace.toString()), node.parent)
            val child = runtime
            io.execute { consumeLines(child.inputStream) { line ->
                DshRuntimeProtocol.webUrl(line)?.let(url::set)
                DshRuntimeProtocol.bridgeEndpoint(line)?.let(bridgeEndpoint::set)
                DshRuntimeProtocol.diagnostic(line)?.let(diagnostic::set)
            } }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(settings.startupTimeoutSeconds.coerceIn(15, 600).toLong())
            var ready: DshRuntimeEndpoint? = null
            while (System.nanoTime() < deadline) {
                checkActive(epoch)
                if (!child.isAlive) fail("DSH 启动失败（退出码 ${child.exitValue()}）。请确认安装完整、Node 版本和 DSH 设置。")
                val web = url.get(); val endpoint = bridgeEndpoint.get()
                if (web != null && endpoint != null && healthy(endpoint, token)) {
                    ready = DshRuntimeEndpoint(web, endpoint, token); break
                }
                Thread.sleep(100)
            }
            val endpoint = ready ?: fail("DSH 启动超时。请检查安装与 DSH 设置，或提高启动超时后重试。")
            synchronized(lock) {
                checkActive(epoch)
                publish(DshRuntimeState(DshRuntimePhase.READY, "DSH 已就绪。", endpoint))
                future.complete(endpoint)
            }
            io.execute {
                val exit = child.waitFor()
                processes.remove(child)
                synchronized(lock) {
                    if (!disposed && generation == epoch) {
                        pending = null
                        publish(DshRuntimeState(DshRuntimePhase.FAILED, "DSH 已退出（退出码 $exit），可以重新启动。"))
                    }
                }
            }
        } catch (error: Exception) {
            try { runtime?.let(processes::stop) } catch (_: Exception) { }
            val basic = if (error is LauncherFailure) error.message!! else if (error is CancellationException || error is InterruptedException) "DSH 启动已取消。" else "无法启动 DSH。请检查 Node、npm 和 DSH 安装目录后重试。"
            val message = basic + diagnostic.get()?.let { " $it" }.orEmpty()
            future.completeExceptionally(IllegalStateException(message))
            synchronized(lock) { if (!disposed && generation == epoch) { pending = null; publish(DshRuntimeState(DshRuntimePhase.FAILED, message)) } }
        }
    }

    private fun resolveInstallation(root: Path, settings: DshSettingsState, node: Path, epoch: Long): Path {
        if (settings.installDirectory.isNotBlank()) return findEntry(Path.of(settings.installDirectory))
            ?: fail("指定目录中未找到 DSH ${DshSettings.PINNED_VERSION}；可选择 npm 安装目录、DSH 包目录或 lib/bin.js。")
        val installation = root.resolve("runtime-${DshSettings.PINNED_VERSION}")
        findEntry(installation)?.let { return it }
        if (!settings.autoInstall) fail("尚未安装 DSH。请启用首次自动安装或选择已有安装目录。")
        update(epoch, DshRuntimeState(DshRuntimePhase.INSTALLING, "首次启动：正在准备安装 DSH ${DshSettings.PINNED_VERSION}…"))
        FileChannel.open(root.resolve("install-${DshSettings.PINNED_VERSION}.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
            val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(10)
            while (true) {
                checkActive(epoch)
                val lease = try { channel.tryLock() } catch (_: OverlappingFileLockException) { null }
                if (lease != null) {
                    lease.use {
                        findEntry(installation)?.let { return it }
                        Files.createDirectories(installation)
                        val npm = findNpm(settings.npmPath, node)
                        update(epoch, DshRuntimeState(DshRuntimePhase.INSTALLING, "正在联网安装 DSH ${DshSettings.PINNED_VERSION}，首次安装可能需要几分钟…"))
                        val command = npm + listOf("install", "--prefix", installation.toString(), "--no-audit", "--no-fund", "--save-exact", "@deepseek-ai/dsh@${DshSettings.PINNED_VERSION}")
                        val child = spawn(command, epoch, installation, emptyMap(), node.parent)
                        io.execute { consumeLines(child.inputStream) { } }
                        try {
                            while (!child.waitFor(200, TimeUnit.MILLISECONDS)) {
                                checkActive(epoch)
                                if (System.nanoTime() > deadline) fail("DSH 安装超时。请检查 npm 网络或选择已有安装目录。")
                            }
                            if (child.exitValue() != 0) fail("DSH 安装失败（npm 退出码 ${child.exitValue()}）。请检查 npm 网络与目录权限后重试。")
                        } finally { processes.stop(child) }
                        return findEntry(installation) ?: fail("安装未产生有效的 DSH 入口，请重试或选择已有安装目录。")
                    }
                }
                if (System.nanoTime() > deadline) fail("等待其他 DSH 安装任务超时，请稍后重试。")
                Thread.sleep(200)
            }
        }
    }

    private fun findEntry(root: Path): Path? {
        val candidates = if (Files.isRegularFile(root)) listOf(root) else listOf(root.resolve("node_modules/@deepseek-ai/dsh/lib/bin.js"), root.resolve("lib/bin.js"))
        return candidates.firstOrNull { entry ->
            try {
                val manifest = JsonParser.parseString(Files.readString(entry.parent.parent.resolve("package.json"))).asJsonObject
                Files.isRegularFile(entry) && manifest.get("name").asString == "@deepseek-ai/dsh" && manifest.get("version").asString == DshSettings.PINNED_VERSION
            } catch (_: Exception) { false }
        }?.toAbsolutePath()?.normalize()
    }

    private fun extractBridge(directory: Path): Path {
        Files.createDirectories(directory)
        for (file in listOf("package.json", "idea-bridge.mjs", "idea-client.js")) {
            val content = DshRuntime::class.java.getResourceAsStream("/dsh/$file")?.use { it.readBytes() }
                ?: fail("插件缺少 DSH 集成资源，请重新安装插件。")
            Files.write(directory.resolve(file), content)
        }
        val path = directory.resolve("idea-bridge.mjs").toAbsolutePath().toString()
        // JSON strings are valid YAML scalars, so spaces, colons and Windows separators remain literal.
        val encoded = com.google.gson.Gson().toJson(path)
        return directory.resolve("ide.cordis.patch.yml").also { Files.writeString(it, "- insert:\n    - id: ide-bridge\n      name: $encoded\n") }
    }

    private fun spawn(command: List<String>, epoch: Long, directory: Path? = null, environment: Map<String, String> = emptyMap(), nodeDirectory: Path? = null): Process = synchronized(lock) {
        checkActive(epoch)
        val builder = ProcessBuilder(command).redirectErrorStream(true)
        directory?.let { builder.directory(it.toFile()) }
        builder.environment().putAll(environment)
        if (nodeDirectory != null) builder.environment()["PATH"] = "$nodeDirectory${java.io.File.pathSeparator}${builder.environment()["PATH"].orEmpty()}"
        builder.start().also(processes::add)
    }

    private fun capture(command: List<String>, epoch: Long): String {
        val child = spawn(command, epoch)
        val output = AtomicReference("")
        val read = io.submit { consumeLines(child.inputStream) { if (output.get().isEmpty()) output.set(it) } }
        try {
            if (!child.waitFor(10, TimeUnit.SECONDS)) fail("Node 版本检查超时，请检查 Node 可执行文件。")
            read.get(2, TimeUnit.SECONDS)
            if (child.exitValue() != 0) fail("无法运行 Node，请检查配置的可执行文件。")
            checkActive(epoch)
            return output.get()
        } finally { processes.stop(child) }
    }

    private fun findNpm(configured: String, node: Path): List<String> {
        val npm = if (configured.isNotBlank()) findExecutable(configured, "npm") else {
            listOf(node.parent.resolve("node_modules/npm/bin/npm-cli.js"), node.parent.resolve("../lib/node_modules/npm/bin/npm-cli.js").normalize())
                .firstOrNull(Files::isRegularFile) ?: findExecutable("", "npm")
        } ?: fail("未找到 npm。请在 DSH Agent 设置中填写 npm 或 npm-cli.js 路径。")
        val real = try { npm.toRealPath() } catch (_: Exception) { npm }
        if (real.fileName.toString().endsWith(".js")) return listOf(node.toString(), real.toString())
        if (real.fileName.toString().endsWith(".cmd")) {
            val script = real.parent.resolve("node_modules/npm/bin/npm-cli.js")
            if (Files.isRegularFile(script)) return listOf(node.toString(), script.toString())
            fail("请将 npm 路径设置为 npm-cli.js。")
        }
        return listOf(real.toString())
    }

    private fun findExecutable(configured: String, name: String): Path? {
        if (configured.isNotBlank() && (configured.contains('/') || configured.contains('\\'))) {
            return Path.of(configured).takeIf(Files::isRegularFile)?.let { try { it.toRealPath() } catch (_: Exception) { it } }
        }
        val executable = configured.ifBlank { name }
        val dirs = System.getenv("PATH").orEmpty().split(java.io.File.pathSeparator).filter { it.isNotBlank() }.map(Path::of).toMutableList()
        dirs += listOf(Path.of("/opt/homebrew/bin"), Path.of("/usr/local/bin"), Path.of(System.getProperty("user.home"), ".local/bin"))
        val nodeVersions = listOf(".local/share/fnm/node-versions", ".fnm/node-versions", "Library/Application Support/fnm/node-versions")
        for (relative in nodeVersions) {
            val path = Path.of(System.getProperty("user.home"), relative)
            if (Files.isDirectory(path)) try { Files.list(path).use { it.sorted(Comparator.reverseOrder()).forEach { version -> dirs.add(version.resolve("installation/bin")) } } } catch (_: Exception) { }
        }
        return dirs.asSequence().flatMap { dir -> sequenceOf(dir.resolve(executable), dir.resolve("$executable.exe"), dir.resolve("$executable.cmd")) }
            .firstOrNull(Files::isRegularFile)?.let { try { it.toRealPath() } catch (_: Exception) { it } }
    }

    private fun healthy(endpoint: String, token: String): Boolean = try {
        val request = HttpRequest.newBuilder(URI(endpoint.trimEnd('/') + "/health")).timeout(Duration.ofSeconds(2)).header("Authorization", "Bearer $token").GET().build()
        http.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200
    } catch (_: Exception) { false }

    private fun checkActive(epoch: Long) { synchronized(lock) { if (disposed || project.isDisposed || generation != epoch || Thread.currentThread().isInterrupted) throw CancellationException() } }
    private fun update(epoch: Long, state: DshRuntimeState) { synchronized(lock) { checkActive(epoch); publish(state) } }
    private fun publish(state: DshRuntimeState) { snapshot = state; listeners.forEach { deliver(it, state) } }
    private fun deliver(listener: (DshRuntimeState) -> Unit, state: DshRuntimeState) {
        ApplicationManager.getApplication().invokeLater { if (!disposed && !project.isDisposed && listeners.contains(listener)) listener(state) }
    }

    private class LauncherFailure(message: String) : RuntimeException(message)
    private fun fail(message: String): Nothing = throw LauncherFailure(message)

    companion object {
        /** Returns the project-owned launcher. */
        fun getInstance(project: Project): DshRuntime = project.service()

        /** Drains output continuously with bounded line memory; process logs are never retained. */
        private fun consumeLines(input: InputStream, consume: (String) -> Unit) {
            try {
                input.bufferedReader(Charsets.UTF_8).use { reader ->
                    val line = StringBuilder()
                    var overflow = false
                    val buffer = CharArray(2048)
                    while (true) {
                        val count = reader.read(buffer)
                        if (count < 0) break
                        for (index in 0 until count) {
                            val char = buffer[index]
                            if (char == '\n') { if (!overflow) consume(line.toString().trimEnd('\r')); line.setLength(0); overflow = false }
                            else if (line.length < 8192) line.append(char) else overflow = true
                        }
                    }
                    if (!overflow && line.isNotEmpty()) consume(line.toString())
                }
            } catch (_: Exception) { /* Closing an owned process closes this stream. */ }
        }
    }
}
