package com.puhui.commenttranslator.agent

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** Ensures sending from an editor is a stable source snapshot, not a later disk read. */
class DshCodeContextPlatformTest : BasePlatformTestCase() {
    override fun runInDispatchThread(): Boolean = true

    fun testCapturesUnsavedSelectionAndVersionWithoutSavingOrFollowingLaterEdits() {
        val file = myFixture.addFileToProject("src/demo.txt", "alpha\nbeta\ngamma\n")
        myFixture.configureFromExistingVirtualFile(file.virtualFile)
        val editor = myFixture.editor
        val document = editor.document
        FileDocumentManager.getInstance().saveDocument(document)
        WriteCommandAction.runWriteCommandAction(project) { document.replaceString(6, 10, "changed") }
        editor.selectionModel.setSelection(6, 13)
        val snapshot = DshCodeContext.capture(project, editor)!!

        assertEquals("changed", snapshot.text)
        assertEquals(file.virtualFile.path, snapshot.filePath)
        assertEquals("txt", snapshot.language)
        assertEquals(2, snapshot.startLine)
        assertEquals(2, snapshot.endLine)
        assertEquals(DshCodeRange(2, 1, 2, 8, 6, 13), snapshot.range)
        assertEquals(document.modificationStamp.toString(), snapshot.documentVersion)
        assertTrue(snapshot.unsaved)
        assertTrue(FileDocumentManager.getInstance().isDocumentUnsaved(document))

        WriteCommandAction.runWriteCommandAction(project) { document.replaceString(6, 13, "next") }
        editor.selectionModel.removeSelection()
        assertEquals("changed", snapshot.text)
        assertFalse(snapshot.documentVersion == document.modificationStamp.toString())
    }

    fun testLineCoverageDoesNotIncludeNextLineWhenSelectionEndsAtItsStart() {
        myFixture.configureByText("demo.txt", "alpha\nbeta\ngamma\n")
        val editor = myFixture.editor
        editor.selectionModel.setSelection(0, 11)
        val snapshot = DshCodeContext.capture(project, editor)!!
        assertEquals("alpha\nbeta\n", snapshot.text)
        assertEquals(1, snapshot.startLine)
        assertEquals(2, snapshot.endLine)
        // Exact positions retain standard half-open semantics independently of line coverage.
        assertEquals(DshCodeRange(1, 1, 3, 1, 0, 11), snapshot.range)
    }

    fun testNoSelectionWhitespaceAndOversizeSelectionsDoNotSend() {
        myFixture.configureByText("demo.txt", "  \nhello")
        val editor = myFixture.editor
        assertNull(DshCodeContext.capture(project, editor))
        editor.selectionModel.setSelection(0, 3)
        assertNull(DshCodeContext.capture(project, editor))
        WriteCommandAction.runWriteCommandAction(project) {
            editor.document.setText("a".repeat(DshCodeContext.MAX_CONTEXT_CHARS + 1))
        }
        editor.selectionModel.setSelection(0, editor.document.textLength)
        assertNull(DshCodeContext.capture(project, editor))
        editor.selectionModel.setSelection(0, DshCodeContext.MAX_CONTEXT_CHARS)
        assertEquals(DshCodeContext.MAX_CONTEXT_CHARS, DshCodeContext.capture(project, editor)!!.text.length)
    }
}
