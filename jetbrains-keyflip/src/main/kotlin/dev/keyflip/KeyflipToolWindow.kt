package dev.keyflip

import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.DoubleClickListener
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import java.awt.event.MouseEvent
import javax.swing.DefaultListModel
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.ListSelectionModel

/** Registers the "Claude Accounts" tool window (mirrors the VS Code Explorer accounts tree). */
class KeyflipToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = KeyflipAccountsPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }
}

/**
 * One row per saved account (active flagged, quota shown). Double-click a non-active row to switch to
 * it (confirms first). Refreshes on creation and whenever a refresh is requested on the message bus.
 */
class KeyflipAccountsPanel(private val project: Project) :
    JBPanel<KeyflipAccountsPanel>(BorderLayout()), Disposable {

    private val listModel = DefaultListModel<KeyflipModels.AccountRow>()
    private val list = JBList(listModel)

    init {
        list.selectionMode = ListSelectionModel.SINGLE_SELECTION
        list.cellRenderer = AccountCellRenderer()
        list.emptyText.text = "No saved Claude accounts — run 'keyflip add' in a terminal."

        add(buildToolbar(), BorderLayout.NORTH)
        add(JBScrollPane(list), BorderLayout.CENTER)

        object : DoubleClickListener() {
            override fun onDoubleClick(event: MouseEvent): Boolean {
                val row = list.selectedValue ?: return false
                if (!row.active) {
                    KeyflipActions.performSwitch(project, row.name, row.label)
                    return true
                }
                return false
            }
        }.installOn(list)

        ApplicationManager.getApplication().messageBus.connect(this)
            .subscribe(KeyflipTopics.REFRESH, KeyflipRefreshListener { reload() })

        reload()
    }

    private fun buildToolbar(): JComponent {
        val group = DefaultActionGroup()
        group.add(object : AnAction("Refresh", "Reload the account list", AllIcons.Actions.Refresh) {
            override fun actionPerformed(e: AnActionEvent) = KeyflipTopics.requestRefresh()
        })
        val toolbar = ActionManager.getInstance().createActionToolbar("KeyflipAccounts", group, true)
        toolbar.targetComponent = this
        return toolbar.component
    }

    private fun reload() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val rows = try {
                KeyflipModels.accountRows(KeyflipCli.listJson())
            } catch (e: Exception) {
                emptyList()
            }
            ApplicationManager.getApplication().invokeLater({
                listModel.clear()
                rows.forEach { listModel.addElement(it) }
            }, ModalityState.any())
        }
    }

    override fun dispose() {
        // message-bus connection and children are disposed via the connect(this) parenting.
    }

    private class AccountCellRenderer : ColoredListCellRenderer<KeyflipModels.AccountRow>() {
        override fun customizeCellRenderer(
            list: JList<out KeyflipModels.AccountRow>,
            value: KeyflipModels.AccountRow?,
            index: Int,
            selected: Boolean,
            hasFocus: Boolean,
        ) {
            if (value == null) return
            icon = if (value.active) AllIcons.Actions.Checked else null
            append(value.label)
            if (value.description.isNotEmpty()) {
                append("   " + value.description, SimpleTextAttributes.GRAYED_ATTRIBUTES)
            }
            toolTipText = value.tooltip
        }
    }
}
