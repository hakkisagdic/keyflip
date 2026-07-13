package dev.keyflip.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import dev.keyflip.KeyflipActions
import dev.keyflip.KeyflipModels
import dev.keyflip.KeyflipSettings
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

/**
 * "Open Dashboard" — runs `keyflip panel --open` in an integrated terminal. `keyflip panel` is a
 * FOREGROUND loopback server, so it belongs in a terminal (Ctrl-C stops it), not a spawned child.
 * Mirrors extension.js openDashboard.
 */
class OpenDashboardAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val command = KeyflipModels.shellQuote(KeyflipSettings.getInstance().path) + " panel --open"
        try {
            val manager = TerminalToolWindowManager.getInstance(project)
            val widget = manager.createLocalShellWidget(project.basePath, "keyflip dashboard")
            widget.executeCommand(command)
        } catch (ex: Throwable) {
            KeyflipActions.notifyError(
                project,
                "Could not open a terminal for the dashboard: ${ex.message}. Run '$command' manually.",
            )
        }
    }
}
