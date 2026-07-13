package dev.keyflip

import com.intellij.openapi.application.ApplicationManager
import com.intellij.util.messages.Topic

/** Fired to ask every keyflip UI (status bar + tool window) to re-query keyflip and repaint. */
fun interface KeyflipRefreshListener {
    fun refresh()
}

object KeyflipTopics {
    @JvmField
    val REFRESH: Topic<KeyflipRefreshListener> =
        Topic.create("keyflip account refresh", KeyflipRefreshListener::class.java)

    /** Publish a refresh request on the application message bus (any thread). */
    fun requestRefresh() {
        ApplicationManager.getApplication().messageBus.syncPublisher(REFRESH).refresh()
    }
}
