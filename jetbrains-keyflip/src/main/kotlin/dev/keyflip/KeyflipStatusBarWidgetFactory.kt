package dev.keyflip

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory

class KeyflipStatusBarWidgetFactory : StatusBarWidgetFactory {

    override fun getId(): String = KeyflipStatusBarWidget.WIDGET_ID

    override fun getDisplayName(): String = "keyflip: Claude Account"

    override fun isAvailable(project: Project): Boolean = true

    override fun createWidget(project: Project): StatusBarWidget = KeyflipStatusBarWidget(project)

    override fun disposeWidget(widget: StatusBarWidget) {
        Disposer.dispose(widget)
    }

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}
