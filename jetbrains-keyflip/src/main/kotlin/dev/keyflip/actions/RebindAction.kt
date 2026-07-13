package dev.keyflip.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.Messages
import dev.keyflip.KeyflipActions
import dev.keyflip.KeyflipCli

/**
 * "Re-link Chat History (moved folder)" — after a project folder is moved/renamed, re-link its Claude
 * chat history to the new path. Defaults the NEW path to the project base dir; asks for the OLD path.
 * Mirrors extension.js rebindSession.
 */
class RebindAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return

        val oldCwd = Messages.showInputDialog(
            project,
            "OLD absolute path this project used to live at (its chats are keyed by it):",
            "keyflip: Re-link Chat History",
            null,
            "",
            null,
        )
        if (oldCwd.isNullOrBlank()) return

        val target = project.basePath ?: Messages.showInputDialog(
            project,
            "NEW absolute path (this project now):",
            "keyflip: Re-link Chat History",
            null,
        )
        if (target.isNullOrBlank()) return

        object : Task.Backgroundable(project, "Re-linking chat history…", true) {
            private var moved: Int? = null
            private var error: String? = null

            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                try {
                    moved = KeyflipCli.rebind(oldCwd, target)
                } catch (ex: Exception) {
                    error = ex.message
                }
            }

            override fun onSuccess() {
                val err = error
                if (err != null) {
                    KeyflipActions.notifyError(project, "Rebind failed: $err")
                    return
                }
                val m = moved
                val movedText = if (m != null) "$m transcript(s)" else "chat history"
                KeyflipActions.notifyInfo(project, "Re-linked $movedText to $target. Reopen Claude to see them.")
            }
        }.queue()
    }
}
