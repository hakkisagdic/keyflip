package dev.keyflip

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.util.Alarm
import com.intellij.util.Consumer
import java.awt.event.MouseEvent

/**
 * Status-bar widget showing the active CLI account (email local-part). Turns into a warning state
 * ("⚠ …") when the desktop app is on a DIFFERENT account than the CLI. Refreshes every 60s (and on
 * demand via the refresh topic) off the EDT; click switches accounts. Mirrors extension.js.
 */
class KeyflipStatusBarWidget(private val project: Project) :
    StatusBarWidget, StatusBarWidget.TextPresentation {

    private var statusBar: StatusBar? = null

    @Volatile
    private var widgetText: String = "keyflip…"

    @Volatile
    private var widgetTooltip: String = "keyflip: Claude account"

    @Volatile
    private var disposed: Boolean = false

    // POOLED_THREAD so the blocking CLI call never touches the EDT. Parented to this widget.
    private val alarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)

    override fun ID(): String = WIDGET_ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        ApplicationManager.getApplication().messageBus.connect(this)
            .subscribe(KeyflipTopics.REFRESH, KeyflipRefreshListener { scheduleRefresh(0) })
        scheduleRefresh(0)
    }

    private fun scheduleRefresh(delayMs: Int) {
        if (disposed || alarm.isDisposed) return
        alarm.cancelAllRequests()
        alarm.addRequest({
            doRefresh()
            scheduleRefresh(REFRESH_MS)
        }, delayMs)
    }

    private fun doRefresh() {
        val (text, tooltip) = try {
            val view = KeyflipModels.statusView(KeyflipCli.statusJson())
            val t = if (view.mismatch) "⚠ " + view.shortLabel else view.shortLabel
            val tip = if (view.mismatch) {
                view.tooltip +
                    "\n\n⚠ The desktop app is on a different account than the CLI. " +
                    "Switch with --restart to align them."
            } else {
                view.tooltip
            }
            t to tip
        } catch (e: Exception) {
            "keyflip?" to ("keyflip not found or failed — set the path in Settings/Preferences › Tools › keyflip.\n" +
                (e.message ?: ""))
        }
        widgetText = text
        widgetTooltip = tooltip
        ApplicationManager.getApplication().invokeLater(
            { statusBar?.updateWidget(WIDGET_ID) },
            ModalityState.any(),
        )
    }

    // ---- TextPresentation ---------------------------------------------------------------------

    override fun getText(): String = widgetText

    override fun getAlignment(): Float = 0.5f

    override fun getTooltipText(): String = widgetTooltip

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
        if (!project.isDisposed) KeyflipActions.chooseAndSwitch(project)
    }

    override fun dispose() {
        disposed = true
        statusBar = null
    }

    companion object {
        const val WIDGET_ID: String = "dev.keyflip.statusBarWidget"
        private const val REFRESH_MS: Int = 60_000
    }
}
