package com.puhui.commenttranslator.agent

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import java.nio.file.Path

/** Covers completion detection without running npm or modifying an external runtime. */
class DshInstallationTest {
    @get:Rule val temporary = TemporaryFolder()
    private val version = "0.1.5-rc.2"

    @Test fun `a partial managed install is not reused just because its package and bin exist`() {
        val root = temporary.root.toPath()
        val entry = packageFiles(root, version)
        assertEquals(entry, DshInstallation.findEntry(root, version))
        assertNull(DshInstallation.completedEntry(root, version))
        DshInstallation.markCompleted(root, version)
        assertEquals(entry, DshInstallation.completedEntry(root, version))
    }

    @Test fun `completed marker cannot bypass version or entry validation`() {
        val root = temporary.root.toPath()
        val entry = packageFiles(root, version)
        DshInstallation.markCompleted(root, version)
        assertNull(DshInstallation.completedEntry(root, "0.1.5"))
        Files.delete(entry)
        assertNull(DshInstallation.completedEntry(root, version))
        packageFiles(root, "0.1.6")
        assertNull(DshInstallation.completedEntry(root, version))
    }

    @Test fun `a failed repair cannot reuse an earlier successful completion marker`() {
        val root = temporary.root.toPath()
        val entry = packageFiles(root, version)
        DshInstallation.markCompleted(root, version)
        Files.delete(entry)
        assertNull(DshInstallation.completedEntry(root, version))

        DshInstallation.beginInstallation(root)
        // npm restores the entry before failing while writing another dependency.
        packageFiles(root, version)
        assertNull(DshInstallation.completedEntry(root, version))
        DshInstallation.markCompleted(root, version)
        assertEquals(entry, DshInstallation.completedEntry(root, version))
    }

    @Test fun `external roots package directories and explicit bins are read only and do not require a managed marker`() {
        val root = temporary.root.toPath()
        val entry = packageFiles(root, version)
        assertEquals(entry, DshInstallation.findEntry(root, version))
        assertEquals(entry, DshInstallation.findEntry(entry.parent.parent, version))
        assertEquals(entry, DshInstallation.findEntry(entry, version))
        assertFalse(Files.exists(root.resolve(".dsh-install-complete")))
        val other = entry.parent.resolve("other.js")
        Files.writeString(other, "not the CLI")
        assertNull(DshInstallation.findEntry(other, version))
    }

    private fun packageFiles(root: Path, pinned: String): Path {
        val directory = root.resolve("node_modules/@deepseek-ai/dsh")
        Files.createDirectories(directory.resolve("lib"))
        Files.writeString(directory.resolve("package.json"), """{"name":"@deepseek-ai/dsh","version":"$pinned"}""")
        return directory.resolve("lib/bin.js").also { Files.writeString(it, "// test CLI") }
    }
}
