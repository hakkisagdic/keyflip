package dev.keyflip.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import dev.keyflip.KeyflipActions

/** "Switch Claude Account" — popup of accounts, confirm, switch, offer restart. */
class SwitchAccountAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        KeyflipActions.chooseAndSwitch(project)
    }
}
