package com.puhui.commenttranslator.agent

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import java.nio.file.Path
import java.util.UUID

/** Captured from the editor at invocation time, including edits that have not reached disk. */
data class DshCodeContext(
    val id: String,
    val text: String,
    val filePath: String?,
    val relativePath: String?,
    val language: String,
    val startLine: Int,
    val endLine: Int,
    val range: DshCodeRange,
    val documentVersion: String,
    val unsaved: Boolean,
) {
    companion object {
        fun capture(project: Project, editor: Editor): DshCodeContext? {
            val selection = editor.selectionModel
            if (!selection.hasSelection()) return null
            val document = editor.document
            val start = selection.selectionStart
            val end = selection.selectionEnd
            if (end - start > MAX_CONTEXT_CHARS) return null
            val text = selection.selectedText ?: return null
            if (text.isBlank()) return null
            val file = FileDocumentManager.getInstance().getFile(document)
            val startLine = document.getLineNumber(start)
            val endLine = document.getLineNumber(end)
            val relativePath = runCatching {
                val base = project.basePath ?: return@runCatching null
                val path = file?.path ?: return@runCatching null
                Path.of(base).relativize(Path.of(path)).toString()
            }.getOrNull()
            return DshCodeContext(
                id = UUID.randomUUID().toString(),
                text = text,
                filePath = file?.path,
                relativePath = relativePath,
                language = file?.extension ?: file?.fileType?.name ?: "text",
                startLine = startLine + 1,
                endLine = document.getLineNumber((end - 1).coerceAtLeast(start)) + 1,
                range = DshCodeRange(startLine + 1, start - document.getLineStartOffset(startLine) + 1,
                    endLine + 1, end - document.getLineStartOffset(endLine) + 1, start, end),
                documentVersion = document.modificationStamp.toString(),
                unsaved = FileDocumentManager.getInstance().isDocumentUnsaved(document),
            )
        }
        const val MAX_CONTEXT_CHARS = 200_000
    }
}

/** Lines and columns are one-based; offsets and the selection end are exclusive UTF-16 positions. */
data class DshCodeRange(
    val startLine: Int,
    val startColumn: Int,
    val endLine: Int,
    val endColumn: Int,
    val startOffset: Int,
    val endOffset: Int,
)

class OpenDshAgentAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
    override fun update(e: AnActionEvent) { e.presentation.isEnabled = e.project != null }
    override fun actionPerformed(e: AnActionEvent) {
        e.project?.let { DshToolWindowController.getInstance(it).show() }
    }
}

abstract class SendSelectionToDshAction(private val mode: DshMode?) : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
    override fun update(e: AnActionEvent) {
        val selection = e.getData(CommonDataKeys.EDITOR)?.selectionModel
        val size = if (selection?.hasSelection() == true) selection.selectionEnd - selection.selectionStart else 0
        e.presentation.isEnabled = e.project != null && size in 1..DshCodeContext.MAX_CONTEXT_CHARS
        e.presentation.description = if (size > DshCodeContext.MAX_CONTEXT_CHARS)
            "选区超过 200,000 字符，请缩小范围后发送。" else "发送当前编辑器选区，包含尚未保存的修改。"
    }
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val context = DshCodeContext.capture(project, editor) ?: return
        DshToolWindowController.getInstance(project).show(context, mode)
    }
}

class SendSelectionToDshAgentAction : SendSelectionToDshAction(null)
class SendSelectionToDshTutorAction : SendSelectionToDshAction(DshMode.TUTOR)
