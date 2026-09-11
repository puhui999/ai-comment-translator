package com.puhui.commenttranslator.agent

import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.Path

/** Validates the pinned package and distinguishes completed managed installs from interrupted npm writes. */
internal object DshInstallation {
    private const val COMPLETED_FILE = ".dsh-install-complete"

    fun findEntry(root: Path, version: String): Path? {
        val candidates = if (Files.isRegularFile(root)) listOf(root) else listOf(root.resolve("node_modules/@deepseek-ai/dsh/lib/bin.js"), root.resolve("lib/bin.js"))
        return candidates.firstOrNull { entry ->
            try {
                val manifest = JsonParser.parseString(Files.readString(entry.parent.parent.resolve("package.json"))).asJsonObject
                Files.isRegularFile(entry) && entry.fileName.toString() == "bin.js" && entry.parent.fileName.toString() == "lib" &&
                    manifest.get("name").asString == "@deepseek-ai/dsh" && manifest.get("version").asString == version
            } catch (_: Exception) { false }
        }?.toAbsolutePath()?.normalize()
    }

    /** Must be read under the same install lock that guards npm, so another project cannot start during a repair. */
    fun completedEntry(root: Path, version: String): Path? {
        val completed = try { Files.readString(root.resolve(COMPLETED_FILE)).trim() == version } catch (_: Exception) { false }
        return if (completed) findEntry(root, version) else null
    }

    /** Invalidates a previous success before npm repairs any files; a failed repair must not inherit its marker. */
    fun beginInstallation(root: Path) { Files.deleteIfExists(root.resolve(COMPLETED_FILE)) }

    /** Called only after npm succeeds and the pinned manifest and entry both validate. */
    fun markCompleted(root: Path, version: String) { Files.writeString(root.resolve(COMPLETED_FILE), "$version\n") }
}
