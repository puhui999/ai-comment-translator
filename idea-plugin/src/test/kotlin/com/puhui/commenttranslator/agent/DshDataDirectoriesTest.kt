package com.puhui.commenttranslator.agent

import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Verifies migrations using real file operations while keeping installation and IDE services out of the test. */
class DshDataDirectoriesTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun `cache cleanup does not remove migrated conversations or model configuration`() {
        val paths = directories()
        write(paths.legacyHome.resolve("settings.json"), "private model settings")
        write(paths.legacyHome.resolve("sessions/conversation.json"), "conversation")

        val home = paths.prepareProjectHome()
        assertTrue(home.startsWith(temporary.root.toPath().resolve("config")))
        assertEquals("private model settings", Files.readString(paths.legacyHome.resolve("settings.json")))
        assertEquals("conversation", Files.readString(home.resolve("sessions/conversation.json")))
        paths.installationRoot.toFile().deleteRecursively()

        assertEquals(home, paths.prepareProjectHome())
        assertEquals("private model settings", Files.readString(home.resolve("settings.json")))
        assertEquals("conversation", Files.readString(home.resolve("sessions/conversation.json")))
    }

    @Test fun `existing stable data wins without merging or overwriting either copy`() {
        val paths = directories()
        write(paths.home.resolve("settings.json"), "new settings")
        write(paths.legacyHome.resolve("settings.json"), "old settings")
        write(paths.legacyHome.resolve("old-only.json"), "old conversation")

        assertEquals(paths.home, paths.prepareProjectHome())
        assertEquals("new settings", Files.readString(paths.home.resolve("settings.json")))
        assertFalse(Files.exists(paths.home.resolve("old-only.json")))
        assertEquals("old settings", Files.readString(paths.legacyHome.resolve("settings.json")))
        assertEquals("old conversation", Files.readString(paths.legacyHome.resolve("old-only.json")))
    }

    @Test fun `cancelled partial migration keeps source intact and can retry`() {
        val paths = directories()
        repeat(3) { write(paths.legacyHome.resolve("session-$it.json"), "conversation-$it") }
        var checks = 0
        assertThrows(CancellationException::class.java) {
            paths.prepareProjectHome { if (++checks == 6) throw CancellationException() }
        }

        assertFalse(Files.exists(paths.home))
        Files.list(paths.home.parent).use { children ->
            assertFalse(children.anyMatch { it.fileName.toString().startsWith(".home-migration-") })
        }
        paths.prepareProjectHome()
        repeat(3) {
            assertEquals("conversation-$it", Files.readString(paths.home.resolve("session-$it.json")))
            assertEquals("conversation-$it", Files.readString(paths.legacyHome.resolve("session-$it.json")))
        }
    }

    @Test fun `an orphaned interrupted staging directory is never adopted`() {
        val paths = directories()
        write(paths.home.parent.resolve(".home-migration-orphan/settings.json"), "partial file")
        write(paths.legacyHome.resolve("settings.json"), "complete settings")

        paths.prepareProjectHome()
        assertEquals("complete settings", Files.readString(paths.home.resolve("settings.json")))
        assertEquals("partial file", Files.readString(paths.home.parent.resolve(".home-migration-orphan/settings.json")))
    }

    @Test fun `a non-directory target is preserved and gives a safe error`() {
        val paths = directories()
        write(paths.home, "existing private file")
        write(paths.legacyHome.resolve("settings.json"), "old settings")

        val error = assertThrows(DshDataDirectoryFailure::class.java) { paths.prepareProjectHome() }
        assertFalse(error.message!!.contains(temporary.root.toString()))
        assertEquals("existing private file", Files.readString(paths.home))
        assertEquals("old settings", Files.readString(paths.legacyHome.resolve("settings.json")))
    }

    @Test fun `new homes and migrated directories are private and file permissions do not widen`() {
        assumeTrue(Files.getFileStore(temporary.root.toPath()).supportsFileAttributeView("posix"))
        val paths = directories()
        val source = paths.legacyHome.resolve("credentials/secret.json")
        write(source, "credential")
        Files.setPosixFilePermissions(source, PosixFilePermissions.fromString("rw-------"))

        paths.prepareProjectHome()
        assertEquals(PosixFilePermissions.fromString("rwx------"), Files.getPosixFilePermissions(paths.home))
        assertEquals(PosixFilePermissions.fromString("rwx------"), Files.getPosixFilePermissions(paths.home.resolve("credentials")))
        assertEquals(Files.getPosixFilePermissions(source), Files.getPosixFilePermissions(paths.home.resolve("credentials/secret.json")))
        assertEquals(PosixFilePermissions.fromString("rwx------"), Files.getPosixFilePermissions(paths.home.parent))
    }

    @Test fun `nested symbolic links are copied as links without traversing outside the home`() {
        assumeTrue(Files.getFileStore(temporary.root.toPath()).supportsFileAttributeView("posix"))
        val paths = directories()
        Files.createDirectories(paths.legacyHome)
        val outside = temporary.newFolder("outside").toPath()
        write(outside.resolve("credential"), "outside file")
        Files.createSymbolicLink(paths.legacyHome.resolve("external"), outside)

        paths.prepareProjectHome()
        assertTrue(Files.isSymbolicLink(paths.home.resolve("external")))
        assertEquals(outside, Files.readSymbolicLink(paths.home.resolve("external")))
        assertEquals("outside file", Files.readString(outside.resolve("credential")))
    }

    @Test fun `a stable home symlink is not traversed or replaced`() {
        assumeTrue(Files.getFileStore(temporary.root.toPath()).supportsFileAttributeView("posix"))
        val paths = directories()
        val outside = temporary.newFolder("outside").toPath()
        write(outside.resolve("settings.json"), "outside settings")
        Files.createDirectories(paths.home.parent)
        Files.createSymbolicLink(paths.home, outside)

        assertThrows(DshDataDirectoryFailure::class.java) { paths.prepareProjectHome() }
        assertTrue(Files.isSymbolicLink(paths.home))
        assertEquals("outside settings", Files.readString(outside.resolve("settings.json")))
    }

    @Test fun `concurrent migrations publish one complete home and retain the legacy source`() {
        val paths = directories()
        repeat(10) { write(paths.legacyHome.resolve("session-$it.json"), "conversation-$it") }
        val start = CountDownLatch(1)
        val attempts = (1..2).map { CompletableFuture.supplyAsync { start.await(); paths.prepareProjectHome() } }
        start.countDown()

        attempts.forEach { assertEquals(paths.home, it.get(5, TimeUnit.SECONDS)) }
        repeat(10) {
            assertEquals("conversation-$it", Files.readString(paths.home.resolve("session-$it.json")))
            assertEquals("conversation-$it", Files.readString(paths.legacyHome.resolve("session-$it.json")))
        }
    }

    @Test fun `separate projects have independent stable homes and preserve the previous cache key`() {
        val first = directories("project-one")
        val second = directories("project-two")
        assertNotEquals(first.home, second.home)
        assertEquals(first.legacyHome.parent.fileName, first.home.parent.fileName)
        first.prepareProjectHome()
        second.prepareProjectHome()
        write(first.home.resolve("settings.json"), "project one")
        assertFalse(Files.exists(second.home.resolve("settings.json")))
    }

    private fun directories(project: String = "project"): DshDataDirectories {
        val root = temporary.root.toPath()
        return DshDataDirectories(root.resolve("system"), root.resolve("config"), root.resolve(project))
    }

    private fun write(path: Path, text: String) { Files.createDirectories(path.parent); Files.writeString(path, text) }
}
