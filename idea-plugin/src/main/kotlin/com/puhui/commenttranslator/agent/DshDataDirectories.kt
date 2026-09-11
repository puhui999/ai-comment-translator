package com.puhui.commenttranslator.agent

import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption.COPY_ATTRIBUTES
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit

/** Separates disposable installation files from project settings, credentials and conversation history. */
internal class DshDataDirectories(systemDirectory: Path, configDirectory: Path, workspace: Path) {
    val installationRoot: Path = systemDirectory.resolve("puhui-comment-translator/dsh")
    private val dataRoot = configDirectory.resolve("puhui-comment-translator/dsh")
    private val projectKey = DshRuntimeProtocol.projectKey(workspace.toAbsolutePath().normalize().toString())
    val home: Path = dataRoot.resolve("projects").resolve(projectKey).resolve("home")
    val legacyHome: Path = installationRoot.resolve("projects").resolve(projectKey).resolve("home")

    /** Publishes a complete migration once; an existing stable home always wins without merging. */
    fun prepareProjectHome(checkActive: () -> Unit = {}): Path {
        try {
            checkActive()
            createPrivateDirectories(home.parent)
            FileChannel.open(home.parent.resolve(".home-migration.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
                while (true) {
                    checkActive()
                    val lease = try { channel.tryLock() } catch (_: OverlappingFileLockException) { null }
                    if (lease != null) return lease.use { prepareLocked(checkActive) }
                    if (System.nanoTime() >= deadline) throw DshDataDirectoryFailure("等待 DSH 数据迁移超时，请稍后重试。旧数据未被覆盖。")
                    Thread.sleep(100)
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            throw error
        } catch (error: DshDataDirectoryFailure) {
            throw error
        } catch (_: IOException) {
            throw DshDataDirectoryFailure("无法准备 DSH 数据目录。已有数据未被覆盖，请检查 IDE 配置目录权限和可用空间。")
        }
    }

    private fun prepareLocked(checkActive: () -> Unit): Path {
        if (Files.exists(home, NOFOLLOW_LINKS)) {
            requireDirectory(home)
            return home
        }
        if (!Files.exists(legacyHome, NOFOLLOW_LINKS)) {
            checkActive()
            createPrivateDirectories(home)
            return home
        }
        requireDirectory(legacyHome)
        val staging = createPrivateTempDirectory(home.parent)
        try {
            Files.walkFileTree(legacyHome, object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                    checkActive()
                    createPrivateDirectories(staging.resolve(legacyHome.relativize(dir)))
                    return FileVisitResult.CONTINUE
                }

                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    checkActive()
                    // Preserve file permissions and symbolic links without traversing their destinations.
                    Files.copy(file, staging.resolve(legacyHome.relativize(file)), COPY_ATTRIBUTES, NOFOLLOW_LINKS)
                    return FileVisitResult.CONTINUE
                }
            })
            checkActive()
            // No REPLACE_EXISTING or ATOMIC_MOVE: neither an existing target nor a racing creator may be overwritten.
            Files.move(staging, home)
            return home
        } finally {
            if (Files.exists(staging, NOFOLLOW_LINKS)) removeOwnedStaging(staging)
        }
    }

    private fun requireDirectory(path: Path) {
        if (!Files.isDirectory(path, NOFOLLOW_LINKS)) {
            throw DshDataDirectoryFailure("DSH 数据路径已有非目录项或符号链接，请检查后重试。已有数据未被覆盖。")
        }
    }

    /** Removes only this attempt's unpublished temporary copy, never the source or stable home. */
    private fun removeOwnedStaging(path: Path) {
        try {
            Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    Files.deleteIfExists(file)
                    return FileVisitResult.CONTINUE
                }
                override fun postVisitDirectory(dir: Path, error: IOException?): FileVisitResult {
                    if (error != null) throw error
                    Files.deleteIfExists(dir)
                    return FileVisitResult.CONTINUE
                }
            })
        } catch (_: IOException) { /* An incomplete copy is never adopted on the next launch. */ }
    }

    companion object {
        /** Creates new private directories where POSIX permissions are available; leaves existing permissions intact. */
        fun createPrivateDirectories(path: Path): Path = try {
            Files.createDirectories(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
        } catch (_: UnsupportedOperationException) {
            Files.createDirectories(path)
        }

        private fun createPrivateTempDirectory(parent: Path): Path = try {
            Files.createTempDirectory(parent, ".home-migration-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
        } catch (_: UnsupportedOperationException) {
            Files.createTempDirectory(parent, ".home-migration-")
        }
    }
}

/** Fixed, UI-safe data preparation failures never expose local paths or file contents. */
internal class DshDataDirectoryFailure(message: String) : IOException(message)
