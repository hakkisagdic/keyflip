package dev.keyflip.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import dev.keyflip.KeyflipTopics

/** "Refresh Account Status" — re-queries keyflip for the status bar and tool window. */
class RefreshAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        KeyflipTopics.requestRefresh()
    }
}
