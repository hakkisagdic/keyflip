package dev.keyflip

import java.util.concurrent.TimeUnit

/** Thrown when the keyflip binary is missing, times out, exits non-zero, or emits no JSON. */
class KeyflipException(message: String) : Exception(message)

/**
 * Runs the keyflip binary via ProcessBuilder (no shell — args are passed verbatim, so a configured
 * path with spaces is fine and there is no injection surface). NEVER logs stdout/stderr, so no
 * account data or secrets are written to logs. The plugin only ever reads `--json` and runs the
 * documented switch / rebind commands.
 */
object KeyflipCli {

    private fun bin(): String = KeyflipSettings.getInstance().path

    /** `keyflip status --json` → parsed object. Throws KeyflipException on failure. */
    fun statusJson(): Any = runJson("status")

    /** `keyflip list --json` → parsed object. Throws KeyflipException on failure. */
    fun listJson(): Any = runJson("list")

    /** `keyflip <profileName> --restart --json` — closes/reopens the desktop app (60s timeout). */
    fun switch(profileName: String) {
        val r = exec(listOf(bin(), profileName, "--restart", "--json"), 60_000)
        if (r.code != 0) throw KeyflipException(r.stderr.trim().ifBlank { "keyflip exited with code ${r.code}" })
    }

    /** `keyflip sessions rebind <old> <new> --json` → number of transcripts moved (or null). */
    fun rebind(oldPath: String, newPath: String): Int? {
        val r = exec(listOf(bin(), "sessions", "rebind", oldPath, newPath, "--json"), 30_000)
        if (r.code != 0) throw KeyflipException(r.stderr.trim().ifBlank { "rebind failed (exit ${r.code})" })
        return KeyflipModels.rebindMoved(KeyflipModels.parseJson(r.stdout))
    }

    // Mirrors lib runJson: resolve on any parseable JSON, else surface stderr as the error.
    private fun runJson(vararg args: String): Any {
        val cmd = ArrayList<String>(args.size + 2)
        cmd.add(bin())
        cmd.addAll(args)
        cmd.add("--json")
        val r = exec(cmd, 20_000)
        val parsed = KeyflipModels.parseJson(r.stdout)
        if (parsed != null) return parsed
        throw KeyflipException(r.stderr.trim().ifBlank { "keyflip returned no JSON (exit ${r.code})" })
    }

    private data class ExecResult(val code: Int, val stdout: String, val stderr: String)

    private fun exec(cmd: List<String>, timeoutMs: Long): ExecResult {
        val proc = try {
            ProcessBuilder(cmd).start()
        } catch (e: Exception) {
            throw KeyflipException(
                "Could not run '${cmd.firstOrNull() ?: "keyflip"}': ${e.message ?: e} — is keyflip installed and " +
                    "on PATH? Set the path in Settings/Preferences › Tools › keyflip."
            )
        }
        // Drain stdout and stderr concurrently to avoid a full-pipe deadlock.
        val out = StringBuilder()
        val err = StringBuilder()
        val outThread = Thread { proc.inputStream.bufferedReader(Charsets.UTF_8).use { out.append(it.readText()) } }
        val errThread = Thread { proc.errorStream.bufferedReader(Charsets.UTF_8).use { err.append(it.readText()) } }
        outThread.isDaemon = true
        errThread.isDaemon = true
        outThread.start()
        errThread.start()
        val finished = proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!finished) {
            proc.destroyForcibly()
            throw KeyflipException("keyflip timed out after $timeoutMs ms")
        }
        outThread.join(2000)
        errThread.join(2000)
        return ExecResult(proc.exitValue(), out.toString(), err.toString())
    }
}
