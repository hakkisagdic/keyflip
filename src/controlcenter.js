import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as _config from "./config.js";
import * as _apicredits from "./apicredits.js";
import * as _history from "./history.js";
import * as _log from "./log.js";

export const ALLOWED_RESTART_SERVICES = Object.freeze([
  "com.keyflip.daemon",
  "dev.keysmith.gateway",
  "dev.keysmith.router",
  "dev.polyctl.admin-tick",
  "dev.polyctl.flowparts-backup",
  "local.yargitay.embed-ensure"
]);

export function defaultServiceDefinitions(homeDir = os.homedir()) {
  return [
    {
      id: "keysmith-gateway",
      label: "dev.keysmith.gateway",
      title: "Keysmith Gateway",
      kind: "daemon",
      logPath: path.join(homeDir, ".local", "share", "keysmith", "launchd-gateway.log"),
      restartable: true
    },
    {
      id: "keysmith-router",
      label: "dev.keysmith.router",
      title: "Keysmith Yerel Router",
      kind: "daemon",
      logPath: path.join(homeDir, ".local", "share", "keysmith", "router.log"),
      restartable: true
    },
    {
      id: "polyctl-admin-tick",
      label: "dev.polyctl.admin-tick",
      title: "Polyctl Admin Tick",
      kind: "interval",
      heartbeatPath: path.join(homeDir, ".polyctl", "admin", "heartbeat"),
      logPath: path.join(homeDir, ".polyctl", "admin", "admin-tick.log"),
      restartable: true
    },
    {
      id: "nightly-backup",
      label: "dev.polyctl.flowparts-backup",
      title: "Gece Yedekleri",
      kind: "scheduled",
      logPath: path.join(homeDir, ".polyctl", "admin", "backups", "flowparts-nightly", "nightly.log"),
      restartable: true
    },
    {
      id: "embedding-guardian",
      label: "local.yargitay.embed-ensure",
      title: "Embedding Koruyucu",
      kind: "interval",
      logPath: path.join(homeDir, "Projects", "scratchpad", "yargitay-embed", "ensure_v16.launchd.log"),
      restartable: true
    }
  ];
}

function readTailLines(filePath, maxBytes = 8192) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return [];
    const readSize = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      return buf
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Parses the latest snapshot section in ~/.polyctl/admin/quota.md
 */
export function parsePolyctlQuotaMarkdown(markdownText) {
  if (typeof markdownText !== "string" || !markdownText.trim()) {
    return {};
  }
  const sections = markdownText.split(/^##\s+/m).filter(Boolean);
  if (sections.length === 0) return {};
  const latest = sections[sections.length - 1];
  const lines = latest.split(/\r?\n/);
  const timestamp = (lines[0] || "").trim();

  const result = { timestamp, entries: {} };
  for (const line of lines.slice(1)) {
    if (!line.startsWith("|")) continue;
    const cols = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cols.length < 4) continue;
    const [tool, account, fiveH, weekly, resets = ""] = cols;
    if (!tool || tool === "tool" || tool.startsWith("---")) continue;
    const key = tool.toLowerCase();
    if (!result.entries[key]) {
      result.entries[key] = [];
    }
    result.entries[key].push({
      tool,
      account,
      fiveH,
      weekly,
      resets
    });
  }
  return result;
}

function readPluginQuotaFile(quotasDir, providerId) {
  if (!quotasDir) return null;
  const jsonFile = path.join(quotasDir, `${providerId}.json`);
  const parsed = readJsonSafe(jsonFile);
  if (!parsed || typeof parsed !== "object") return null;
  const display = typeof parsed.display === "string" && parsed.display.trim() ? parsed.display.trim() : null;
  if (!display) return null;
  return {
    id: providerId,
    label: parsed.label || providerId,
    status: ["ok", "warning", "exhausted", "unreadable"].includes(parsed.status) ? parsed.status : "ok",
    display,
    usedPct: typeof parsed.usedPct === "number" && Number.isFinite(parsed.usedPct) ? parsed.usedPct : null,
    detail: typeof parsed.detail === "string" ? parsed.detail : null,
    updatedAt: parsed.updatedAt || null,
    source: "plugin-json"
  };
}

function unreadableQuota(id, label, detail = null) {
  return {
    id,
    label,
    status: "unreadable",
    display: "okunamadı",
    usedPct: null,
    detail,
    updatedAt: null,
    source: "none"
  };
}

export function collectOtherQuotas(ctx, options = {}) {
  const homeDir = options.homeDir || ctx?.home || ctx?.homeDir || os.homedir();
  const configDir = options.configDir || ctx?.configDir || path.join(homeDir, ".config", "keyflip");
  const quotasDir = options.quotasDir || path.join(configDir, "quotas");
  const polyctlQuotaPath =
    options.polyctlQuotaPath !== undefined
      ? options.polyctlQuotaPath
      : path.join(homeDir, ".polyctl", "admin", "quota.md");

  let polyctlParsed = {};
  try {
    if (polyctlQuotaPath && fs.existsSync(polyctlQuotaPath)) {
      polyctlParsed = parsePolyctlQuotaMarkdown(fs.readFileSync(polyctlQuotaPath, "utf8"));
    }
  } catch {
    polyctlParsed = {};
  }
  const entries = polyctlParsed.entries || {};
  const snapTime = polyctlParsed.timestamp || null;

  // 1. Kiro
  let kiro = readPluginQuotaFile(quotasDir, "kiro");
  if (!kiro) {
    const kiroKey = Object.keys(entries).find((k) => k.startsWith("kiro"));
    const kiroRow = kiroKey ? entries[kiroKey]?.[0] : null;
    if (kiroRow && kiroRow.weekly && kiroRow.weekly !== "?" && !kiroRow.weekly.toLowerCase().includes("unreadable")) {
      const m = kiroRow.weekly.match(/([\d.]+)\s*\/\s*([\d.]+)/);
      const used = m ? Number.parseFloat(m[1]) : null;
      const total = m ? Number.parseFloat(m[2]) : null;
      const pct = used !== null && total && total > 0 ? Math.round((used / total) * 1000) / 10 : null;
      kiro = {
        id: "kiro",
        label: "Kiro Kredisi",
        status: pct !== null && pct >= 90 ? "warning" : "ok",
        display: `${kiroRow.weekly} kredi`,
        usedPct: pct,
        detail: kiroRow.resets ? `Sıfırlama: ${kiroRow.resets}` : kiroRow.account || null,
        updatedAt: snapTime,
        source: "polyctl-quota"
      };
    } else {
      kiro = unreadableQuota("kiro", "Kiro Kredisi");
    }
  }

  // 2. Copilot
  let copilot = readPluginQuotaFile(quotasDir, "copilot");
  if (!copilot) {
    const copilotKey = Object.keys(entries).find((k) => k.includes("copilot"));
    const copilotRow = copilotKey ? entries[copilotKey]?.[0] : null;
    if (copilotRow && copilotRow.weekly && copilotRow.weekly !== "?") {
      copilot = {
        id: "copilot",
        label: "GitHub Copilot",
        status: "ok",
        display: copilotRow.weekly,
        usedPct: null,
        detail: copilotRow.account || null,
        updatedAt: snapTime,
        source: "polyctl-quota"
      };
    } else {
      copilot = unreadableQuota("copilot", "GitHub Copilot");
    }
  }

  // 3. agy (Antigravity)
  let agy = readPluginQuotaFile(quotasDir, "agy");
  if (!agy) {
    const agyKey = Object.keys(entries).find((k) => k.includes("antigravity") || k === "agy");
    const agyRow = agyKey ? entries[agyKey]?.[0] : null;
    if (agyRow && (agyRow.fiveH !== "?" || agyRow.weekly !== "?")) {
      const fiveNum = Number.parseFloat(agyRow.fiveH);
      const weekNum = Number.parseFloat(agyRow.weekly);
      const hasFive = Number.isFinite(fiveNum);
      const hasWeek = Number.isFinite(weekNum);
      if (hasFive || hasWeek) {
        const maxPct = Math.max(hasFive ? fiveNum : 0, hasWeek ? weekNum : 0);
        agy = {
          id: "agy",
          label: "Antigravity (agy)",
          status: maxPct >= 95 ? "exhausted" : maxPct >= 80 ? "warning" : "ok",
          display: `5s: ${hasFive ? `%${fiveNum}` : "okunamadı"} · 7g: ${hasWeek ? `%${weekNum}` : "okunamadı"}`,
          usedPct: hasWeek ? weekNum : fiveNum,
          detail: agyRow.resets || agyRow.account || null,
          updatedAt: snapTime,
          source: "polyctl-quota"
        };
      } else {
        agy = unreadableQuota("agy", "Antigravity (agy)");
      }
    } else {
      agy = unreadableQuota("agy", "Antigravity (agy)");
    }
  }

  // 4. EVREN
  let evren = readPluginQuotaFile(quotasDir, "evren");
  if (!evren) {
    const evrenKey = Object.keys(entries).find((k) => k.includes("evren"));
    const evrenRow = evrenKey ? entries[evrenKey]?.[0] : null;
    if (evrenRow && evrenRow.weekly && evrenRow.weekly !== "?") {
      evren = {
        id: "evren",
        label: "EVREN",
        status: "ok",
        display: evrenRow.weekly,
        usedPct: null,
        detail: evrenRow.account || null,
        updatedAt: snapTime,
        source: "polyctl-quota"
      };
    } else {
      evren = unreadableQuota("evren", "EVREN");
    }
  }

  // 5. API Promos (apicredits)
  let apicredits = readPluginQuotaFile(quotasDir, "apicredits");
  if (!apicredits) {
    try {
      const apiCfg = _apicredits.readConfig({ configDir });
      const accounts = Array.isArray(apiCfg?.accounts) ? apiCfg.accounts : [];
      if (accounts.length > 0) {
        let totalGrant = 0;
        let totalRemaining = 0;
        let readableCount = 0;
        for (const acct of accounts) {
          const g = _apicredits.grantFor(acct);
          if (typeof g === "number" && g > 0) totalGrant += g;
          const out = {};
          if (_apicredits.manualStatus(acct, out) && typeof out.remaining === "number") {
            totalRemaining += out.remaining;
            readableCount += 1;
          }
        }
        if (readableCount > 0) {
          const usedPct =
            totalGrant > 0
              ? Math.max(0, Math.min(100, Math.round(((totalGrant - totalRemaining) / totalGrant) * 100)))
              : null;
          apicredits = {
            id: "apicredits",
            label: "API Promosyonları",
            status: totalRemaining <= 0 ? "exhausted" : totalRemaining <= 10 ? "warning" : "ok",
            display: `$${totalRemaining.toFixed(2)} kalan (${readableCount}/${accounts.length} hesap)`,
            usedPct,
            detail: totalGrant > 0 ? `Toplam aylık hibe: $${totalGrant.toFixed(2)}` : null,
            updatedAt: new Date().toISOString(),
            source: "apicredits"
          };
        } else {
          apicredits = unreadableQuota("apicredits", "API Promosyonları", `${accounts.length} hesap kayıtlı, bakiye okunamadı`);
        }
      } else {
        apicredits = unreadableQuota("apicredits", "API Promosyonları", "Kayıtlı API promosyon hesabı yok");
      }
    } catch {
      apicredits = unreadableQuota("apicredits", "API Promosyonları");
    }
  }

  return [kiro, copilot, agy, evren, apicredits];
}

function defaultLaunchctlList() {
  const res = spawnSync("launchctl", ["list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 4000
  });
  if (res.status !== 0) return {};
  const map = {};
  for (const line of (res.stdout || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || parts[0] === "PID") continue;
    const [pidRaw, exitRaw, label] = parts;
    map[label] = {
      pid: pidRaw === "-" ? null : Number.parseInt(pidRaw, 10),
      lastExitStatus: exitRaw === "-" ? null : Number.parseInt(exitRaw, 10)
    };
  }
  return map;
}

function inspectServiceLog(def) {
  const lines = readTailLines(def.logPath, 8192);
  let lastError = null;
  let lastSuccess = null;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!lastError && /\b(error|exception|fatal|fail|failed|traceback|econnrefused|enoent)\b/i.test(line)) {
      lastError = line.slice(0, 160);
    }
    if (!lastSuccess) {
      if (def.id === "nightly-backup" && /\bok:\s+/i.test(line)) {
        lastSuccess = line.slice(0, 160);
      } else if (def.id === "polyctl-admin-tick" && /\bworking=\d+/i.test(line)) {
        lastSuccess = line.slice(0, 160);
      } else if (def.id === "embedding-guardian" && /\b(ok|running|alive|checked|healthy|done)\b/i.test(line)) {
        lastSuccess = line.slice(0, 160);
      }
    }
  }

  let heartbeatAgeMin = null;
  if (def.heartbeatPath) {
    try {
      const stat = fs.statSync(def.heartbeatPath);
      heartbeatAgeMin = Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 60000));
    } catch {
      heartbeatAgeMin = null;
    }
  }

  return {
    lastError,
    lastSuccess,
    heartbeatAgeMin,
    lastLine: lines.length > 0 ? lines[lines.length - 1].slice(0, 160) : null
  };
}

export function collectServicesStatus(ctx, options = {}) {
  const homeDir = options.homeDir || ctx?.home || ctx?.homeDir || os.homedir();
  const defs = options.definitions || defaultServiceDefinitions(homeDir);
  const launchdMap = options.launchdMap || defaultLaunchctlList();

  return defs.map((def) => {
    const entry = launchdMap[def.label] || null;
    const loaded = Boolean(entry);
    const running = Boolean(entry && Number.isInteger(entry.pid) && entry.pid > 0);
    const exitCode = entry ? entry.lastExitStatus : null;
    const logInfo = inspectServiceLog(def);

    let state = "stopped";
    if (def.kind === "daemon") {
      if (running) state = "running";
      else if (loaded) state = "error";
      else state = "stopped";
    } else if (def.kind === "scheduled" || def.kind === "interval") {
      if (running) {
        state = "running";
      } else if (loaded && (exitCode === 0 || exitCode === null)) {
        state = "scheduled";
        if (def.heartbeatPath && logInfo.heartbeatAgeMin !== null && logInfo.heartbeatAgeMin > 45) {
          state = "warning";
        }
      } else if (loaded && exitCode !== 0) {
        state = "error";
      } else {
        state = "stopped";
      }
    }

    return {
      id: def.id,
      label: def.label,
      title: def.title,
      kind: def.kind,
      loaded,
      running,
      pid: entry?.pid ?? null,
      lastExitStatus: exitCode,
      state,
      lastSuccess: logInfo.lastSuccess,
      lastError: logInfo.lastError,
      heartbeatAgeMin: logInfo.heartbeatAgeMin,
      lastLine: logInfo.lastLine,
      restartable: Boolean(def.restartable && ALLOWED_RESTART_SERVICES.includes(def.label))
    };
  });
}

export function restartManagedService(ctx, { label, confirm = false, runner = null } = {}) {
  if (confirm !== true) {
    const err = new Error("Servis yeniden başlatma işlemi için kullanıcı onayı (confirm: true) gereklidir.");
    err.code = "CONFIRMATION_REQUIRED";
    throw err;
  }
  if (!label || !ALLOWED_RESTART_SERVICES.includes(label)) {
    const err = new Error(`Bu servis yeniden başlatma beyaz listesinde değil: ${label || "(boş)"}`);
    err.code = "SERVICE_NOT_ALLOWED";
    throw err;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const target = `gui/${uid}/${label}`;
  const execFn =
    runner ||
    ((cmd, args) =>
      spawnSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 8000
      }));

  const res = execFn("launchctl", ["kickstart", "-k", target]);
  const ok = res.status === 0;
  const detail = ((res.stderr || res.stdout || "").trim() || (ok ? "kickstart ok" : `exit ${res.status}`)).slice(
    0,
    240
  );

  if (ctx?.configDir) {
    _log.init(ctx.configDir, false);
  }
  _log.log(`AUDIT action=service_restart label=${label} ok=${ok} detail=${JSON.stringify(detail)}`);
  if (ctx?.configDir) {
    const safeCtx = {
      ...ctx,
      now: typeof ctx.now === "function" ? ctx.now : () => new Date().toISOString()
    };
    _history.recordEvent(safeCtx, {
      kind: "service-restart",
      label,
      target,
      ok,
      detail
    });
  }

  if (!ok) {
    const err = new Error(`launchctl kickstart başarısız (${label}): ${detail}`);
    err.code = "RESTART_FAILED";
    throw err;
  }

  return {
    ok: true,
    label,
    target,
    detail
  };
}

export function summarizeFleetSweep(agents) {
  if (!Array.isArray(agents)) {
    return {
      status: "unreadable",
      display: "okunamadı",
      working: null,
      idle: null,
      stuck: null,
      dormant: null,
      total: null,
      updatedAt: null
    };
  }

  let working = 0;
  let idle = 0;
  let stuck = 0;
  let dormant = 0;

  for (const a of agents) {
    const updatedMin = typeof a.updatedMinAgo === "number" ? a.updatedMinAgo : 999999;
    const lastTurnMin = typeof a.lastTurnAt === "number" ? a.lastTurnAt : updatedMin;
    if (updatedMin > 7 * 24 * 60 && !a.active) {
      dormant += 1;
      continue;
    }
    if (a.active === true) {
      if (lastTurnMin > 120) {
        stuck += 1;
      } else {
        working += 1;
      }
    } else {
      idle += 1;
    }
  }

  return {
    status: stuck > 0 ? "warning" : "ok",
    display: `${working} çalışıyor · ${idle} boşta · ${stuck} takılı`,
    working,
    idle,
    stuck,
    dormant,
    total: agents.length,
    updatedAt: new Date().toISOString()
  };
}

export function collectFleetStatus(ctx, options = {}) {
  const homeDir = options.homeDir || ctx?.home || ctx?.homeDir || os.homedir();
  const configDir = options.configDir || ctx?.configDir || path.join(homeDir, ".config", "keyflip");
  const cachePath = options.cachePath || path.join(configDir, "quotas", "fleet.json");

  const cached = readJsonSafe(cachePath);
  if (cached && Array.isArray(cached.agents)) {
    return summarizeFleetSweep(cached.agents);
  }
  if (cached && typeof cached.working === "number") {
    return {
      status: cached.stuck > 0 ? "warning" : "ok",
      display:
        cached.display || `${cached.working} çalışıyor · ${cached.idle || 0} boşta · ${cached.stuck || 0} takılı`,
      working: cached.working,
      idle: cached.idle ?? 0,
      stuck: cached.stuck ?? 0,
      dormant: cached.dormant ?? 0,
      total: cached.total ?? cached.working + (cached.idle || 0) + (cached.stuck || 0),
      updatedAt: cached.updatedAt || null
    };
  }

  const sweepScript =
    options.sweepScript !== undefined
      ? options.sweepScript
      : path.join(homeDir, ".polyctl", "admin", "bin", "traycer_sweep.py");

  if (!sweepScript || !fs.existsSync(sweepScript)) {
    return summarizeFleetSweep(null);
  }

  try {
    const res = spawnSync("python3", ["-I", sweepScript, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs || 5000
    });
    if (res.status !== 0 || !res.stdout) {
      return summarizeFleetSweep(null);
    }
    const parsed = JSON.parse(res.stdout);
    return summarizeFleetSweep(parsed);
  } catch {
    return summarizeFleetSweep(null);
  }
}

export function collectServerStatus(ctx, options = {}) {
  const homeDir = options.homeDir || ctx?.home || ctx?.homeDir || os.homedir();
  const configDir = options.configDir || ctx?.configDir || path.join(homeDir, ".config", "keyflip");
  const serverSnapPath =
    options.serverSnapPath !== undefined ? options.serverSnapPath : path.join(configDir, "quotas", "server.json");
  const adminServerPath =
    options.adminServerPath !== undefined
      ? options.adminServerPath
      : path.join(homeDir, ".polyctl", "admin", "server-status.json");

  const snap = readJsonSafe(serverSnapPath) || readJsonSafe(adminServerPath);
  if (snap && typeof snap === "object") {
    const sites = Array.isArray(snap.sites)
      ? snap.sites.map((s) => ({
          name: s.name || s.url || "site",
          status: ["ok", "warning", "down", "unreadable"].includes(s.status) ? s.status : "unreadable",
          code: s.code ?? null,
          detail: s.detail || (s.status === "ok" ? "200 OK" : "okunamadı")
        }))
      : [];
    return {
      host: snap.host || "Alastyr",
      status: ["ok", "warning", "down", "unreadable"].includes(snap.status) ? snap.status : "ok",
      load: typeof snap.load === "string" && snap.load.trim() ? snap.load.trim() : "okunamadı",
      memory: typeof snap.memory === "string" && snap.memory.trim() ? snap.memory.trim() : "okunamadı",
      disk: typeof snap.disk === "string" && snap.disk.trim() ? snap.disk.trim() : "okunamadı",
      sites,
      updatedAt: snap.updatedAt || null,
      readOnly: true
    };
  }

  return {
    host: "Alastyr",
    status: "unreadable",
    load: "okunamadı",
    memory: "okunamadı",
    disk: "okunamadı",
    sites: [
      { name: "partflow.hakkisagdic.dev", status: "unreadable", code: null, detail: "okunamadı" },
      { name: "gymbox.hakkisagdic.dev", status: "unreadable", code: null, detail: "okunamadı" },
      { name: "venizelos.hakkisagdic.dev", status: "unreadable", code: null, detail: "okunamadı" }
    ],
    updatedAt: null,
    readOnly: true
  };
}

export function collectPreferences(ctx) {
  const homeDir = ctx?.home || ctx?.homeDir || os.homedir();
  const daemonPlist = path.join(homeDir, "Library", "LaunchAgents", "com.keyflip.daemon.plist");
  return {
    thresholdPct: _config.get(ctx, "autoswitch.threshold") ?? 95,
    refreshIntervalSec: _config.get(ctx, "daemon.autoswitchIntervalSeconds") ?? 120,
    notify: _config.get(ctx, "notify.desktop") !== false,
    launchAtLogin: fs.existsSync(daemonPlist)
  };
}
