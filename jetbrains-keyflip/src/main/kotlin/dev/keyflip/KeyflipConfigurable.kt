package dev.keyflip

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Application-level Settings/Preferences page (under Tools) exposing the single `keyflip.path` setting.
 */
class KeyflipConfigurable : Configurable {

    private var pathField: JBTextField? = null
    private var panel: JPanel? = null

    override fun getDisplayName(): String = "keyflip"

    override fun createComponent(): JComponent {
        val field = JBTextField(KeyflipSettings.getInstance().path, 30)
        pathField = field
        val p = FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Keyflip executable path:"), field, 1, false)
            .addComponentToRightColumn(
                JBLabel("Path to the keyflip binary (default: resolve \"keyflip\" from PATH)."),
            )
            .addComponentFillVertically(JPanel(), 0)
            .panel
        panel = p
        return p
    }

    override fun isModified(): Boolean =
        (pathField?.text ?: "") != KeyflipSettings.getInstance().path

    override fun apply() {
        KeyflipSettings.getInstance().path = pathField?.text ?: ""
    }

    override fun reset() {
        pathField?.text = KeyflipSettings.getInstance().path
    }

    override fun disposeUIComponent() {
        pathField = null
        panel = null
    }
}
