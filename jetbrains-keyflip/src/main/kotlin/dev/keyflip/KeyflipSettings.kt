package dev.keyflip

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Application-level persisted settings. Only stores `keyflip.path` (the binary location). No secrets
 * are ever stored here — the plugin never sees tokens.
 */
@Service(Service.Level.APP)
@State(name = "KeyflipSettings", storages = [Storage("keyflip.xml")])
class KeyflipSettings : PersistentStateComponent<KeyflipSettings.State> {

    class State {
        @JvmField
        var path: String = DEFAULT_PATH
    }

    private var myState = State()

    override fun getState(): State = myState

    override fun loadState(state: State) {
        myState = state
    }

    /** The keyflip binary path; falls back to "keyflip" (resolve from PATH) when blank. */
    var path: String
        get() = myState.path.trim().ifBlank { DEFAULT_PATH }
        set(value) {
            myState.path = value.trim().ifBlank { DEFAULT_PATH }
        }

    companion object {
        const val DEFAULT_PATH = "keyflip"

        fun getInstance(): KeyflipSettings =
            ApplicationManager.getApplication().getService(KeyflipSettings::class.java)
    }
}
