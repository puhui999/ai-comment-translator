package com.puhui.commenttranslator.agent

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

enum class DshMode(val wireName: String, private val label: String) {
    GENERAL("general", "通用"), TUTOR("tutor", "助教"), CUSTOM("custom", "自定义");
    override fun toString(): String = label
    companion object {
        fun fromWire(value: String?): DshMode = entries.firstOrNull { it.wireName == value } ?: GENERAL
    }
}

data class DshBrowserState(val sessionId: String?, val mode: DshMode, val customPrompt: String, val browserConnected: Boolean)

/** Only talks to the private, loopback IDE bridge. The bearer token never enters the browser. */
class DshBridgeClient(private val endpoint: DshRuntimeEndpoint) : AutoCloseable {
    private val gson = GsonBuilder().serializeNulls().create()
    private val base = URI.create(endpoint.bridgeEndpoint.trimEnd('/') + "/").also {
        require(it.scheme == "http" && it.host in setOf("127.0.0.1", "localhost", "[::1]", "::1") && it.userInfo == null) {
            "DSH bridge must use a loopback HTTP endpoint"
        }
    }
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4))
        .followRedirects(HttpClient.Redirect.NEVER).build()

    fun state(): DshBrowserState {
        val body = request("GET", "state")
        return DshBrowserState(body.string("sessionId"), DshMode.fromWire(body.string("mode")),
            body.string("customPrompt") ?: "", body.get("browserConnected")?.asBoolean == true)
    }

    fun setMode(mode: DshMode, customPrompt: String, sessionId: String?) {
        // Explicit null means the instance default; it must never resolve to a later-selected session.
        request("POST", "mode", mapOf("mode" to mode.wireName, "customPrompt" to customPrompt, "sessionId" to sessionId))
    }

    /** Publishes only supplied fields; appearance is delivered before the embedded page opens. */
    fun updateIdeState(appearance: DshAppearance? = null, status: DshIdeStatus? = null) {
        val values = buildMap<String, Any> {
            if (appearance != null) put("appearance", appearance)
            if (status != null) put("status", status.copy(message = status.message.take(300), queued = status.queued.coerceIn(0, 10000)))
        }
        if (values.isNotEmpty()) request("POST", "ide/state", values)
    }

    /** Drains explicit host commands, rejecting unknown actions rather than executing arbitrary IDE commands. */
    fun commands(): List<DshIdeCommand> {
        val response = request("GET", "ide/commands")
        val commands = response.get("commands")?.takeIf { it.isJsonArray }?.asJsonArray ?: return emptyList()
        return commands.take(100).mapNotNull { value ->
            runCatching {
                val command = value.asJsonObject
                val id = command.string("id") ?: return@runCatching null
                val action = command.string("action") ?: return@runCatching null
                if (id.isBlank() || id.length > 128 || action !in setOf("settings", "restart", "retry")) return@runCatching null
                DshIdeCommand(id, action)
            }.getOrNull()
        }
    }

    fun send(context: DshCodeContext, mode: DshMode, customPrompt: String, sessionId: String? = null): String? {
        val payload = gson.toJsonTree(context).asJsonObject.apply {
            addProperty("mode", mode.wireName)
            addProperty("customPrompt", customPrompt)
            if (sessionId != null) addProperty("sessionId", sessionId)
            addProperty("instruction", if (mode == DshMode.TUTOR)
                "请作为助教讲解这段选中的代码，结合项目说明它的用途、执行过程与关键设计；根据需要检查相关定义，再引导我理解。"
                else "请结合项目上下文分析这段选中的代码。")
        }
        return request("POST", "context", payload).string("sessionId")
    }

    private fun request(method: String, path: String, body: Any? = null): JsonObject {
        val builder = HttpRequest.newBuilder(base.resolve(path)).timeout(Duration.ofSeconds(12))
            .header("Authorization", "Bearer ${endpoint.bridgeToken}")
            .header("Accept", "application/json")
        if (body == null) builder.GET() else {
            val json = gson.toJson(body)
            require(json.toByteArray(Charsets.UTF_8).size <= 2 * 1024 * 1024) {
                "选区与提示词编码后超过 2 MiB，请缩小选区或提示词后重新发送。"
            }
            builder.header("Content-Type", "application/json")
                .method(method, HttpRequest.BodyPublishers.ofString(json))
        }
        val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
        val data = runCatching { JsonParser.parseString(response.body()).asJsonObject }.getOrElse {
            throw IllegalStateException("DSH 返回了无效响应（HTTP ${response.statusCode()}）")
        }
        if (response.statusCode() !in 200..299) {
            val message = data.string("error")?.take(400) ?: "HTTP ${response.statusCode()}"
            throw IllegalStateException(message.replace(endpoint.bridgeToken, "[redacted]"))
        }
        return data
    }

    override fun close() { client.shutdownNow() }
    private fun JsonObject.string(key: String): String? = get(key)?.takeUnless { it.isJsonNull }?.asString
}
