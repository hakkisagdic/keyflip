package dev.keyflip

import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep

/**
 * Shared, EDT-friendly flows used by the status bar widget, the tool window and the actions.
 * Mirrors extension.js switchAccount / performSwitch UX (confirm before switch, offer reload after).
 */
object KeyflipActions {

    private const val NOTIFICATION_GROUP = "keyflip"

    // ---- Notifications ------------------------------------------------------------------------

    fun notifyError(project: Project?, content: String) = notify(project, content, NotificationType.ERROR)
    fun notifyWarn(project: Project?, content: String) = notify(project, content, NotificationType.WARNING)
    fun notifyInfo(project: Project?, content: String) = notify(project, content, NotificationType.INFORMATION)

    private fun notify(
        project: Project?,
        content: String,
        type: NotificationType,
        configure: (Notification) -> Unit = {},
    ) {
        val n = NotificationGroupManager.getInstance()
            .getNotificationGroup(NOTIFICATION_GROUP)
            .createNotification(content, type)
        configure(n)
        n.notify(project)
    }

    // ---- Switch flow --------------------------------------------------------------------------

    /** Load accounts in the background, then show a popup to pick one to switch to. */
    fun chooseAndSwitch(project: Project) {
        object : Task.Backgroundable(project, "Loading keyflip accounts…", true) {
            private var items: List<KeyflipModels.AccountItem> = emptyList()
            private var error: String? = null

            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                try {
                    items = KeyflipModels.accountItems(KeyflipCli.listJson())
                } catch (e: Exception) {
                    error = e.message
                }
            }

            override fun onSuccess() {
                val err = error
                if (err != null) {
                    notifyError(project, "keyflip failed: $err — is keyflip installed and on PATH?")
                    return
                }
                if (items.isEmpty()) {
                    notifyWarn(project, "No saved Claude accounts yet — run 'keyflip add' in a terminal while logged in.")
                    return
                }
                showAccountPopup(project, items)
            }
        }.queue()
    }

    private fun showAccountPopup(project: Project, items: List<KeyflipModels.AccountItem>) {
        val step = object : BaseListPopupStep<KeyflipModels.AccountItem>("Switch Claude account to…", items) {
            override fun getTextFor(value: KeyflipModels.AccountItem): String {
                val prefix = if (value.active) "✓ " else ""
                return prefix + value.label + "   " + value.description
            }

            override fun isSelectable(value: KeyflipModels.AccountItem): Boolean = !value.active

            override fun onChosen(selectedValue: KeyflipModels.AccountItem, finalChoice: Boolean): PopupStep<*>? =
                doFinalStep {
                    if (!selectedValue.active) performSwitch(project, selectedValue.name, selectedValue.label)
                }
        }
        JBPopupFactory.getInstance().createListPopup(step).showCenteredInCurrentWindow(project)
    }

    /** Confirm, then switch to a specific account with a progress indicator; offer a restart on success. */
    fun performSwitch(project: Project, profileName: String, displayName: String) {
        val name = displayName.ifBlank { profileName }
        val choice = Messages.showYesNoDialog(
            project,
            "Switch Claude account to $name? If the Claude desktop app is open it will be closed and reopened.",
            "keyflip",
            "Switch",
            "Cancel",
            Messages.getQuestionIcon(),
        )
        if (choice != Messages.YES) return

        object : Task.Backgroundable(project, "Switching Claude account…", false) {
            private var error: String? = null

            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                try {
                    KeyflipCli.switch(profileName)
                } catch (e: Exception) {
                    error = e.message
                }
            }

            override fun onFinished() {
                // Repaint the status bar / tool window regardless of outcome.
                KeyflipTopics.requestRefresh()
            }

            override fun onSuccess() {
                val err = error
                if (err != null) {
                    notifyError(project, "Switch failed: $err")
                    return
                }
                notify(
                    project,
                    "Switched to $name. Restart the IDE so the Claude plugin picks up the new login.",
                    NotificationType.INFORMATION,
                ) { n ->
                    n.addAction(object : NotificationAction("Restart IDE") {
                        override fun actionPerformed(e: AnActionEvent, notification: Notification) {
                            notification.expire()
                            ApplicationManager.getApplication().restart()
                        }
                    })
                }
            }
        }.queue()
    }
}
