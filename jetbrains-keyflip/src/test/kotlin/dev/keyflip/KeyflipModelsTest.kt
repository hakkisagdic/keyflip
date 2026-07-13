package dev.keyflip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for the pure core (KeyflipModels) — parsing + view-model shaping. Mirrors the cases in the
 * VS Code companion's test/vscode-lib.test.js. No IntelliJ Platform is needed to run these.
 */
class KeyflipModelsTest {

    // ---- parseJson ----------------------------------------------------------------------------

    @Test
    fun parseJson_readsCleanSingleObjectBody() {
        val parsed = KeyflipModels.parseJson("{\"cli\":{\"email\":\"a@x.com\"}}\n")
        assertNotNull(parsed)
        assertEquals("a", KeyflipModels.shortLabel(parsed))
    }

    @Test
    fun parseJson_fallsBackToLastJsonLineWhenNoiseLeaksIn() {
        val parsed = KeyflipModels.parseJson("some human line\n{\"ok\":1}\n")
        assertNotNull(parsed)
        val map = parsed as Map<*, *>
        assertEquals(1, (map["ok"] as Number).toInt())
    }

    @Test
    fun parseJson_multiLinePrettyObjectParsesAsAWhole() {
        val parsed = KeyflipModels.parseJson("{\n  \"cli\": {\n    \"email\": \"b@x.com\"\n  }\n}")
        assertEquals("b", KeyflipModels.shortLabel(parsed))
    }

    @Test
    fun parseJson_nullOnEmptyOrUnparseableOrNull() {
        assertNull(KeyflipModels.parseJson(""))
        assertNull(KeyflipModels.parseJson("   "))
        assertNull(KeyflipModels.parseJson("not json at all"))
        assertNull(KeyflipModels.parseJson(null))
    }

    // ---- quotaLabel ---------------------------------------------------------------------------

    @Test
    fun quotaLabel_showsFiveHourWhenOkHidesWhenNotOk() {
        assertEquals("5h 42%", KeyflipModels.quotaLabel(mapOf("fiveHour" to mapOf("pct" to 42.4)), "ok"))
        assertEquals("7d 10%", KeyflipModels.quotaLabel(mapOf("sevenDay" to mapOf("pct" to 10)), "ok"))
        assertEquals("", KeyflipModels.quotaLabel(mapOf("fiveHour" to mapOf("pct" to 42)), "expired"))
        assertEquals("", KeyflipModels.quotaLabel(null, "ok"))
        assertEquals("", KeyflipModels.quotaLabel(emptyMap<String, Any?>(), "ok"))
    }

    @Test
    fun quotaLabel_prefersFiveHourOverSevenDay() {
        val usage = mapOf("fiveHour" to mapOf("pct" to 20), "sevenDay" to mapOf("pct" to 90))
        assertEquals("5h 20%", KeyflipModels.quotaLabel(usage, "ok"))
    }

    // ---- statusView / statusText / shortLabel -------------------------------------------------

    @Test
    fun statusView_buildsShortLabelTooltipAndNoMismatch() {
        val st = KeyflipModels.parseJson(
            "{\"cli\":{\"email\":\"alice@example.com\"},\"app\":{\"email\":\"alice@example.com\"},\"provider\":\"relay\"}",
        )
        val v = KeyflipModels.statusView(st)
        assertEquals("alice", v.shortLabel)
        assertFalse(v.mismatch)
        assertTrue(v.tooltip.contains("CLI: alice@example.com"))
        assertTrue(v.tooltip.contains("Desktop app: alice@example.com"))
        assertTrue(v.tooltip.contains("Provider: relay"))
        assertTrue(v.tooltip.contains("Click to switch"))
    }

    @Test
    fun statusView_notLoggedInState() {
        val st = KeyflipModels.parseJson("{\"cli\":null,\"app\":null,\"provider\":null}")
        val v = KeyflipModels.statusView(st)
        assertEquals("not logged in", v.shortLabel)
        assertTrue(v.tooltip.contains("CLI: —"))
        assertFalse("no provider line when none active", v.tooltip.contains("Provider"))
    }

    @Test
    fun statusText_mirrorsShowStatusBlock() {
        val st = KeyflipModels.parseJson(
            "{\"cli\":{\"email\":\"alice@example.com\"},\"app\":{\"email\":\"bob@x.com\"},\"provider\":\"relay\"}",
        )
        val txt = KeyflipModels.statusText(st)
        assertTrue(txt.contains("Claude Code (CLI): alice@example.com"))
        assertTrue(txt.contains("Desktop app:       bob@x.com"))
        assertTrue(txt.contains("Active provider:   relay"))
    }

    @Test
    fun statusText_defaultsWhenFieldsMissing() {
        val txt = KeyflipModels.statusText(KeyflipModels.parseJson("{}"))
        assertTrue(txt.contains("Claude Code (CLI): not logged in"))
        assertFalse(txt.contains("Desktop app:"))
        assertTrue(txt.contains("Active provider:   (none — using the account)"))
    }

    // ---- mismatch -----------------------------------------------------------------------------

    @Test
    fun mismatch_trueOnlyWhenAppAndCliAreOnDifferentKnownAccounts() {
        assertTrue(KeyflipModels.mismatch(KeyflipModels.parseJson("{\"cli\":{\"email\":\"a@x.com\"},\"app\":{\"email\":\"b@x.com\"}}")))
        assertFalse(KeyflipModels.mismatch(KeyflipModels.parseJson("{\"cli\":{\"email\":\"a@x.com\"},\"app\":{\"email\":\"a@x.com\"}}")))
        assertFalse(KeyflipModels.mismatch(KeyflipModels.parseJson("{\"cli\":{\"email\":\"a@x.com\"}}")))
        assertFalse(KeyflipModels.mismatch(KeyflipModels.parseJson("{\"app\":{\"email\":\"b@x.com\"}}")))
        assertFalse(KeyflipModels.mismatch(null))
    }

    // ---- accountItems -------------------------------------------------------------------------

    @Test
    fun accountItems_marksActiveShowsCaptureAndQuota() {
        val list = KeyflipModels.parseJson(
            "{\"accounts\":[" +
                "{\"name\":\"work\",\"email\":\"w@x.com\",\"cliCaptured\":true,\"appCaptured\":false," +
                "\"activeCli\":true,\"usage\":{\"fiveHour\":{\"pct\":30}},\"usageStatus\":\"ok\"}," +
                "{\"name\":\"personal\",\"email\":\"p@x.com\",\"cliCaptured\":true,\"appCaptured\":true," +
                "\"activeCli\":false,\"usageStatus\":\"expired\"}]}",
        )
        val items = KeyflipModels.accountItems(list)
        assertEquals(2, items.size)
        assertTrue(items[0].active)
        assertEquals("work", items[0].name)
        assertTrue(items[0].description.contains("cli ✓"))
        assertTrue(items[0].description.contains("app —"))
        assertTrue(items[0].description.contains("5h 30%"))
        assertTrue(items[0].description.contains("(active)"))
        assertFalse("expired account shows no quota number", items[1].description.contains("5h"))
    }

    @Test
    fun accountItems_emptyList() {
        assertTrue(KeyflipModels.accountItems(KeyflipModels.parseJson("{}")).isEmpty())
        assertTrue(KeyflipModels.accountItems(KeyflipModels.parseJson("{\"accounts\":[]}")).isEmpty())
        assertTrue(KeyflipModels.accountItems(null).isEmpty())
    }

    // ---- accountRows --------------------------------------------------------------------------

    @Test
    fun accountRows_onePerAccountActiveFlaggedQuotaInDescription() {
        val rows = KeyflipModels.accountRows(
            KeyflipModels.parseJson(
                "{\"accounts\":[" +
                    "{\"name\":\"work\",\"email\":\"w@x.com\",\"activeCli\":true,\"cliCaptured\":true," +
                    "\"appCaptured\":true,\"usage\":{\"fiveHour\":{\"pct\":40}},\"usageStatus\":\"ok\"}," +
                    "{\"name\":\"home\",\"email\":\"h@x.com\",\"activeCli\":false,\"cliCaptured\":true,\"appCaptured\":false}]}",
            ),
        )
        assertEquals(2, rows.size)
        assertEquals("w@x.com", rows[0].label)
        assertTrue(rows[0].active)
        assertTrue(rows[0].description.contains("active"))
        assertTrue(rows[0].description.contains("5h 40%"))
        assertTrue(rows[0].tooltip.contains("cli ✓"))
        assertTrue(rows[0].tooltip.contains("app ✓"))
        assertFalse(rows[1].active)
        assertTrue(KeyflipModels.accountRows(null).isEmpty())
    }

    // ---- rebindMoved --------------------------------------------------------------------------

    @Test
    fun rebindMoved_extractsMovedCountOrNull() {
        assertEquals(3, KeyflipModels.rebindMoved(KeyflipModels.parseJson("{\"rebind\":{\"moved\":3}}")))
        assertNull(KeyflipModels.rebindMoved(KeyflipModels.parseJson("{\"ok\":1}")))
        assertNull(KeyflipModels.rebindMoved(null))
    }

    // ---- shellQuote ---------------------------------------------------------------------------

    @Test
    fun shellQuote_quotesOnlyWhenTheBinaryPathHasWhitespace() {
        assertEquals("keyflip", KeyflipModels.shellQuote("keyflip"))
        assertEquals("/usr/local/bin/keyflip", KeyflipModels.shellQuote("/usr/local/bin/keyflip"))
        assertEquals("\"/my path/keyflip\"", KeyflipModels.shellQuote("/my path/keyflip"))
        assertEquals("\"C:\\Program Files\\keyflip.exe\"", KeyflipModels.shellQuote("C:\\Program Files\\keyflip.exe"))
    }
}
