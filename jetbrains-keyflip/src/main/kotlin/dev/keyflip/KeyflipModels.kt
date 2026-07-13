@file:Suppress("MemberVisibilityCanBePrivate")

package dev.keyflip

/**
 * Pure, IntelliJ-INDEPENDENT core for the keyflip plugin: `--json` output parsing + view-model
 * shaping. This file deliberately has NO IntelliJ Platform imports (and no third-party deps) so it
 * can be unit-tested in isolation with plain JUnit. It mirrors vscode-keyflip/lib.js precisely.
 *
 * `keyflip --json` prints ONE JSON object to stdout (human text goes to stderr). We parse
 * defensively: the whole trimmed body first, then fall back to the last JSON-parseable line.
 */
object KeyflipModels {

    // ---- View-model types ---------------------------------------------------------------------

    /** A row for the "Switch account" popup. Mirrors lib.accountItems. */
    data class AccountItem(
        val name: String,
        val label: String,       // email or name
        val description: String, // "[cli ✓ | app —]  5h 30%  (active)"
        val active: Boolean,
    )

    /** A row for the tool-window accounts list. Mirrors lib.accountTreeItems. */
    data class AccountRow(
        val name: String,
        val label: String,       // email or name
        val active: Boolean,
        val description: String, // "active · 5h 40%"
        val tooltip: String,     // "email\ncli ✓ · app —"
    )

    /** Status-bar view-model. Mirrors lib.statusView, adapted for IntelliJ (no VS Code codicons). */
    data class StatusView(
        val shortLabel: String,  // email local-part, or "not logged in"
        val tooltip: String,
        val mismatch: Boolean,   // desktop app on a DIFFERENT account than the CLI
    )

    // ---- JSON parsing -------------------------------------------------------------------------

    /**
     * Parse `keyflip --json` stdout. Returns the parsed value (a Map for the objects keyflip emits),
     * or null when there is no JSON at all. Mirrors lib.parseJson: whole trimmed body first, else the
     * last JSON-parseable line (scanning upward).
     */
    fun parseJson(stdout: String?): Any? {
        val s = (stdout ?: "").trim()
        if (s.isEmpty()) return null
        try {
            return JsonReader(s).parse()
        } catch (_: Exception) { /* fall through to line scan */ }
        val lines = s.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        for (i in lines.indices.reversed()) {
            try {
                return JsonReader(lines[i]).parse()
            } catch (_: Exception) { /* keep scanning upward */ }
        }
        return null
    }

    // ---- Shaping (mirrors lib.js) -------------------------------------------------------------

    /**
     * Short quota label from a list-account's usage window (utilization %), or "" when the account is
     * expired/throttled/unknown or usage is unavailable. Mirrors lib.quotaLabel.
     */
    fun quotaLabel(usage: Any?, status: String?): String {
        if (status != null && status != "ok") return ""
        if (usage == null) return ""
        val five = usage.child("fiveHour")
        if (five != null) {
            val pct = five.numberOrNull("pct")
            if (pct != null) return "5h " + Math.round(pct) + "%"
        }
        val seven = usage.child("sevenDay")
        if (seven != null) {
            val pct = seven.numberOrNull("pct")
            if (pct != null) return "7d " + Math.round(pct) + "%"
        }
        return ""
    }

    /** Status-bar text: the CLI email local-part, or "not logged in". */
    fun shortLabel(status: Any?): String {
        val email = status.child("cli").stringOrNull("email") ?: return "not logged in"
        return email.substringBefore("@")
    }

    /** Multi-line status-bar tooltip (network-free — CLI email + app + provider). Mirrors lib.statusView. */
    fun statusTooltip(status: Any?): String {
        val cli = status.child("cli").stringOrNull("email")
        val lines = mutableListOf("Claude account (keyflip)", "CLI: " + (cli ?: "—"))
        val app = status.child("app")
        if (app != null) lines.add("Desktop app: " + (app.stringOrNull("email") ?: app.stringOrNull("name") ?: "unknown"))
        val provider = status.stringOrNull("provider")
        if (provider != null) lines.add("Provider: $provider (overrides the account for API calls)")
        lines.add("")
        lines.add("Click to switch")
        return lines.joinToString("\n")
    }

    /** Combined status-bar view-model. */
    fun statusView(status: Any?): StatusView =
        StatusView(shortLabel(status), statusTooltip(status), mismatch(status))

    /**
     * Full status block for the "Show status" action (CLI email + desktop app + active provider).
     * Mirrors extension.js showStatus output.
     */
    fun statusText(status: Any?): String {
        val sb = StringBuilder()
        sb.append("Claude Code (CLI): ").append(status.child("cli").stringOrNull("email") ?: "not logged in")
        val app = status.child("app")
        if (app != null) {
            sb.append('\n').append("Desktop app:       ")
                .append(app.stringOrNull("email") ?: app.stringOrNull("name") ?: "unknown")
        }
        sb.append('\n').append("Active provider:   ").append(status.stringOrNull("provider") ?: "(none — using the account)")
        return sb.toString()
    }

    /** Popup items from `keyflip list --json`. Mirrors lib.accountItems (minus VS Code codicons). */
    fun accountItems(list: Any?): List<AccountItem> =
        list.listOrEmpty("accounts").map { a ->
            val q = quotaLabel(a.child("usage"), a.stringOrNull("usageStatus"))
            val active = a.boolFlag("activeCli")
            AccountItem(
                name = a.stringOrNull("name") ?: "",
                label = a.stringOrNull("email") ?: a.stringOrNull("name") ?: "",
                description = "[cli " + (if (a.boolFlag("cliCaptured")) "✓" else "—") +
                    " | app " + (if (a.boolFlag("appCaptured")) "✓" else "—") + "]" +
                    (if (q.isNotEmpty()) "  $q" else "") +
                    (if (active) "  (active)" else ""),
                active = active,
            )
        }

    /** Tool-window rows from `keyflip list --json`. Mirrors lib.accountTreeItems. */
    fun accountRows(list: Any?): List<AccountRow> =
        list.listOrEmpty("accounts").map { a ->
            val q = quotaLabel(a.child("usage"), a.stringOrNull("usageStatus"))
            val active = a.boolFlag("activeCli")
            val label = a.stringOrNull("email") ?: a.stringOrNull("name") ?: ""
            AccountRow(
                name = a.stringOrNull("name") ?: "",
                label = label,
                active = active,
                description = (if (active) "active" else "") + (if (q.isNotEmpty()) (if (active) " · " else "") + q else ""),
                tooltip = label + "\ncli " + (if (a.boolFlag("cliCaptured")) "✓" else "—") +
                    " · app " + (if (a.boolFlag("appCaptured")) "✓" else "—"),
            )
        }

    /**
     * True when the desktop app and the CLI are on DIFFERENT accounts (both known) — the "user
     * mismatch" the status bar warns about. Mirrors lib.mismatch.
     */
    fun mismatch(status: Any?): Boolean {
        val cli = status.child("cli").stringOrNull("email")
        val app = status.child("app").stringOrNull("email")
        return cli != null && app != null && cli != app
    }

    /** Number of transcripts moved from `keyflip sessions rebind --json` ({ rebind: { moved } }), or null. */
    fun rebindMoved(result: Any?): Int? =
        (result.child("rebind").child("moved") as? Number)?.toInt()

    /** Shell-quote a binary path for a terminal command line. Mirrors extension.js keyflipBinShell. */
    fun shellQuote(bin: String): String =
        if (bin.any { it.isWhitespace() }) "\"" + bin.replace("\"", "\\\"") + "\"" else bin
}

// ---- Star-projected navigation helpers (null/type-safe, no unchecked casts) -------------------

private fun Any?.child(key: String): Any? = (this as? Map<*, *>)?.get(key)
private fun Any?.stringOrNull(key: String): String? = child(key) as? String
private fun Any?.numberOrNull(key: String): Double? = (child(key) as? Number)?.toDouble()
private fun Any?.boolFlag(key: String): Boolean = child(key) == true
private fun Any?.listOrEmpty(key: String): List<Any?> = (child(key) as? List<*>) ?: emptyList()

// ---- Minimal, dependency-free JSON reader -----------------------------------------------------
// Produces LinkedHashMap / ArrayList / String / Double / Boolean / null. Throws on invalid input so
// parseJson can fall back to line-scanning. Kept small and self-contained on purpose.
private class JsonReader(private val s: String) {
    private var i = 0

    fun parse(): Any? {
        skipWs()
        val v = readValue()
        skipWs()
        if (i < s.length) fail("unexpected trailing characters")
        return v
    }

    private fun fail(msg: String): Nothing = throw IllegalArgumentException("JSON: $msg at $i")

    private fun skipWs() {
        while (i < s.length) {
            val c = s[i]
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++ else break
        }
    }

    private fun readValue(): Any? {
        if (i >= s.length) fail("unexpected end")
        return when (s[i]) {
            '{' -> readObject()
            '[' -> readArray()
            '"' -> readString()
            't', 'f' -> readBool()
            'n' -> readNull()
            else -> readNumber()
        }
    }

    private fun readObject(): Map<String, Any?> {
        val map = LinkedHashMap<String, Any?>()
        i++ // consume '{'
        skipWs()
        if (i < s.length && s[i] == '}') { i++; return map }
        while (true) {
            skipWs()
            if (i >= s.length || s[i] != '"') fail("expected string key")
            val key = readString()
            skipWs()
            if (i >= s.length || s[i] != ':') fail("expected ':'")
            i++
            skipWs()
            map[key] = readValue()
            skipWs()
            if (i >= s.length) fail("unterminated object")
            when (s[i]) {
                ',' -> i++
                '}' -> { i++; return map }
                else -> fail("expected ',' or '}'")
            }
        }
    }

    private fun readArray(): List<Any?> {
        val list = ArrayList<Any?>()
        i++ // consume '['
        skipWs()
        if (i < s.length && s[i] == ']') { i++; return list }
        while (true) {
            skipWs()
            list.add(readValue())
            skipWs()
            if (i >= s.length) fail("unterminated array")
            when (s[i]) {
                ',' -> i++
                ']' -> { i++; return list }
                else -> fail("expected ',' or ']'")
            }
        }
    }

    private fun readString(): String {
        val sb = StringBuilder()
        i++ // consume opening quote
        while (i < s.length) {
            val c = s[i++]
            when (c) {
                '"' -> return sb.toString()
                '\\' -> {
                    if (i >= s.length) fail("bad escape")
                    when (val e = s[i++]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            if (i + 4 > s.length) fail("bad unicode escape")
                            val hex = s.substring(i, i + 4)
                            i += 4
                            sb.append(hex.toInt(16).toChar())
                        }
                        else -> fail("bad escape '\\$e'")
                    }
                }
                else -> sb.append(c)
            }
        }
        fail("unterminated string")
    }

    private fun readBool(): Boolean {
        if (s.startsWith("true", i)) { i += 4; return true }
        if (s.startsWith("false", i)) { i += 5; return false }
        fail("invalid literal")
    }

    private fun readNull(): Any? {
        if (s.startsWith("null", i)) { i += 4; return null }
        fail("invalid literal")
    }

    private fun readNumber(): Double {
        val start = i
        if (i < s.length && s[i] == '-') i++
        while (i < s.length && s[i].isDigit()) i++
        if (i < s.length && s[i] == '.') { i++; while (i < s.length && s[i].isDigit()) i++ }
        if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
            i++
            if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
            while (i < s.length && s[i].isDigit()) i++
        }
        val tok = s.substring(start, i)
        if (tok.isEmpty() || tok == "-") fail("invalid number")
        return tok.toDoubleOrNull() ?: fail("invalid number")
    }
}
