package dev.keyflip.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.Messages
import dev.keyflip.KeyflipActions
import dev.keyflip.KeyflipCli
import dev.keyflip.KeyflipModels

/** "Show Account Status" — CLI email + desktop app + active provider, in a console-style dialog. */
class ShowStatusAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        object : Task.Backgroundable(project, "Loading keyflip status…", true) {
            private var text: String? = null
            private var error: String? = null

            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                try {
                    text = KeyflipModels.statusText(KeyflipCli.statusJson())
                } catch (ex: Exception) {
                    error = ex.message
                }
            }

            override fun onSuccess() {
                val err = error
                if (err != null) {
                    KeyflipActions.notifyError(project, "keyflip status failed: $err")
                    return
                }
                Messages.showMessageDialog(
                    project,
                    text ?: "",
                    "keyflip — Account Status",
                    Messages.getInformationIcon(),
                )
            }
        }.queue()
    }
}
