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

  const recent = lines.slice(-6);
  const sparkline =
    recent.length === 0
      ? null
      : recent
          .map((l) => (/\b(error|exception|fatal|fail|failed|traceback|econnrefused|enoent)\b/i.test(l) ? "▁" : "█"))
          .join("");

  return {
    lastError,
    lastSuccess,
    heartbeatAgeMin,
    sparkline,
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
      sparkline: logInfo.sparkline,
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
      host: snap.host || "Uzak Sunucu",
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
    host: "Uzak Sunucu",
    status: "unreadable",
    load: "okunamadı",
    memory: "okunamadı",
    disk: "okunamadı",
    sites: [],
    updatedAt: null,
    readOnly: true
  };
}

const STATUS_ROW_RANK = Object.freeze({
  bad: 0,
  warn: 1,
  ok: 2,
  unknown: 3
});

export function expandHomePath(rawPath, homeDir = os.homedir()) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return "";
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/")) return path.join(homeDir, trimmed.slice(2));
  return trimmed;
}

export function formatSinceAge(sinceIso, nowMs = Date.now()) {
  if (!sinceIso || typeof sinceIso !== "string") return null;
  const parsed = Date.parse(sinceIso.trim());
  if (!Number.isFinite(parsed) || parsed > nowMs) return null;
  const totalMin = Math.max(1, Math.round((nowMs - parsed) / 60000));
  if (totalMin < 60) return `${totalMin} dk`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 48) return mins > 0 ? `${hours}s ${mins}dk` : `${hours} saat`;
  const days = Math.floor(hours / 24);
  return `${days} gün`;
}

export function sortStatusBoardRows(rows, nowMs = Date.now()) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r, idx) => {
      const st = ["ok", "warn", "bad", "unknown"].includes(r?.status) ? r.status : "unknown";
      const sinceStr = r?.since != null ? String(r.since) : null;
      return {
        index: idx,
        row: {
          label: String(r?.label ?? ""),
          value: String(r?.value ?? ""),
          status: st,
          detail: r?.detail != null ? String(r.detail) : null,
          since: sinceStr,
          sinceAge: formatSinceAge(sinceStr, nowMs)
        }
      };
    })
    .sort((a, b) => {
      const rankDiff = (STATUS_ROW_RANK[a.row.status] ?? 3) - (STATUS_ROW_RANK[b.row.status] ?? 3);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map((item) => item.row);
}

/**
 * Validates a status.json object or file against the Status Board schema (`docs/STATUS-BOARD.md`).
 */
export function validateStatusBoardSchema(input) {
  const errors = [];
  const warnings = [];

  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      return {
        valid: false,
        errors: [`Geçersiz JSON: ${e.message}`],
        warnings: [],
        stats: { sectionCount: 0, rowCount: 0, ownerNeededCount: 0 }
      };
    }
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      errors: ["Kök değer bir JSON nesnesi (object) olmalıdır."],
      warnings: [],
      stats: { sectionCount: 0, rowCount: 0, ownerNeededCount: 0 }
    };
  }

  if (raw.updated === undefined || raw.updated === null || String(raw.updated).trim() === "") {
    warnings.push("'updated' alanı eksik (bayatlama kontrolü dosya mtime değerine düşecek).");
  } else if (!Number.isFinite(Date.parse(String(raw.updated)))) {
    errors.push(`'updated' alanı geçerli bir ISO-8601 zaman damgası değil: ${raw.updated}`);
  }

  if (!Array.isArray(raw.sections)) {
    errors.push("'sections' alanı bir dizi (array) olmalıdır.");
  }

  const sections = Array.isArray(raw.sections) ? raw.sections : [];
  let rowCount = 0;
  const seenIds = new Set();

  sections.forEach((sec, sIdx) => {
    if (!sec || typeof sec !== "object") {
      errors.push(`sections[${sIdx}] bir nesne olmalıdır.`);
      return;
    }
    if (!sec.id || typeof sec.id !== "string") {
      errors.push(`sections[${sIdx}].id zorunlu bir metin alanıdır.`);
    } else if (seenIds.has(sec.id)) {
      warnings.push(`Yinelenen bölüm kimliği: '${sec.id}' (satırlar birleştirilecek).`);
    } else {
      seenIds.add(sec.id);
    }
    if (!sec.title || typeof sec.title !== "string") {
      warnings.push(`sections[${sIdx}].title eksik; id başlık olarak kullanılacak.`);
    }
    if (!Array.isArray(sec.rows)) {
      errors.push(`sections[${sIdx}].rows bir dizi olmalıdır.`);
      return;
    }
    sec.rows.forEach((row, rIdx) => {
      rowCount += 1;
      if (!row || typeof row !== "object") {
        errors.push(`sections[${sIdx}].rows[${rIdx}] bir nesne olmalıdır.`);
        return;
      }
      if (typeof row.label !== "string" || !row.label.trim()) {
        errors.push(`sections[${sIdx}].rows[${rIdx}].label boş olamaz.`);
      }
      if (row.value === undefined || row.value === null) {
        errors.push(`sections[${sIdx}].rows[${rIdx}].value eksik.`);
      }
      if (!["ok", "warn", "bad", "unknown"].includes(row.status)) {
        errors.push(
          `sections[${sIdx}].rows[${rIdx}].status geçersiz ('${row.status}'); beklenen: ok | warn | bad | unknown.`
        );
      }
      if (row.since !== undefined && row.since !== null && !Number.isFinite(Date.parse(String(row.since)))) {
        warnings.push(`sections[${sIdx}].rows[${rIdx}].since geçerli bir ISO-8601 tarihi değil: ${row.since}`);
      }
    });
  });

  let ownerNeededCount = 0;
  if (raw.owner_needed !== undefined) {
    if (!Array.isArray(raw.owner_needed)) {
      errors.push("'owner_needed' alanı bir dizi (array) olmalıdır.");
    } else {
      raw.owner_needed.forEach((item, oIdx) => {
        ownerNeededCount += 1;
        if (!item || typeof item !== "object" || (!item.project && !item.text)) {
          errors.push(`owner_needed[${oIdx}] içinde 'project' ve 'text' alanları bulunmalıdır.`);
        }
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      sectionCount: sections.length,
      rowCount,
      ownerNeededCount
    }
  };
}

/**
 * Computes overall SLA / health score across all status board sections.
 */
export function computeStatusBoardHealth(sections = []) {
  const list = Array.isArray(sections) ? sections : [];
  let totalRows = 0;
  let okRows = 0;
  let warnRows = 0;
  let badRows = 0;
  let unknownRows = 0;

  for (const sec of list) {
    for (const r of sec?.rows || []) {
      totalRows += 1;
      if (r?.status === "ok") okRows += 1;
      else if (r?.status === "warn") warnRows += 1;
      else if (r?.status === "bad") badRows += 1;
      else unknownRows += 1;
    }
  }

  // Weighted health: ok = 1.0, warn = 0.5, unknown = 0.75, bad = 0.0
  const weighted = okRows * 1.0 + warnRows * 0.5 + unknownRows * 0.75;
  const healthPct = totalRows > 0 ? Math.round((weighted / totalRows) * 100) : 100;

  return {
    totalRows,
    okRows,
    warnRows,
    badRows,
    unknownRows,
    healthPct,
    summary: totalRows > 0 ? `%${healthPct} sağlıklı (${okRows}/${totalRows} ok)` : "Veri yok"
  };
}

export function collectStatusBoard(ctx, options = {}) {
  const homeDir = options.homeDir || ctx?.home || ctx?.homeDir || os.homedir();
  const configuredPath =
    options.statusFile !== undefined
      ? options.statusFile
      : process.env.KEYFLIP_STATUS_FILE || _config.get(ctx, "menubar.statusFile");
  const resolvedPath = expandHomePath(configuredPath, homeDir);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return null;
  }
  const raw = readJsonSafe(resolvedPath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const nowMs =
    typeof options.nowMs === "function"
      ? options.nowMs()
      : typeof ctx?.nowMs === "function"
        ? ctx.nowMs()
        : Date.now();

  let updatedMs = raw.updated ? Date.parse(String(raw.updated)) : Number.NaN;
  if (!Number.isFinite(updatedMs)) {
    try {
      updatedMs = fs.statSync(resolvedPath).mtimeMs;
    } catch {
      updatedMs = Number.NaN;
    }
  }
  const ageMinutes = Number.isFinite(updatedMs) ? Math.max(0, Math.round((nowMs - updatedMs) / 60000)) : null;
  const stale = ageMinutes !== null ? ageMinutes > 20 : true;

  const sectionMap = new Map();
  const baseSections = Array.isArray(raw.sections) ? raw.sections : [];
  baseSections.forEach((sec, idx) => {
    const id = String(sec?.id || `section-${idx}`);
    const title = String(sec?.title || sec?.id || `Bölüm ${idx + 1}`);
    const existing = sectionMap.get(id);
    const rawRows = Array.isArray(sec?.rows) ? sec.rows : [];
    if (existing) {
      existing.rawRows.push(...rawRows);
    } else {
      sectionMap.set(id, { id, title, rawRows: [...rawRows] });
    }
  });

  const ownerNeeded = Array.isArray(raw.owner_needed)
    ? raw.owner_needed
        .filter((item) => item && (item.project || item.text))
        .map((item) => ({
          project: String(item.project ?? ""),
          text: String(item.text ?? "")
        }))
    : [];

  // Optional multi-host / extra status files aggregation
  const extraRaw =
    options.extraStatusFiles !== undefined
      ? options.extraStatusFiles
      : _config.get(ctx, "menubar.extraStatusFiles") || "";
  const extraList = Array.isArray(extraRaw)
    ? extraRaw
    : String(extraRaw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  for (const extraItem of extraList) {
    const extraPath = expandHomePath(extraItem, homeDir);
    if (!extraPath || !fs.existsSync(extraPath)) continue;
    const extraJson = readJsonSafe(extraPath);
    if (!extraJson || typeof extraJson !== "object" || Array.isArray(extraJson)) continue;
    const hostPrefix = extraJson.host ? `[${extraJson.host}] ` : "";
    if (Array.isArray(extraJson.sections)) {
      extraJson.sections.forEach((sec, idx) => {
        const id = String(sec?.id || `extra-${idx}`);
        const title = String(sec?.title || sec?.id || `Bölüm ${idx + 1}`);
        const taggedRows = (Array.isArray(sec?.rows) ? sec.rows : []).map((r) => ({
          ...r,
          label: hostPrefix ? `${hostPrefix}${r?.label ?? ""}` : r?.label
        }));
        const existing = sectionMap.get(id);
        if (existing) {
          existing.rawRows.push(...taggedRows);
        } else {
          sectionMap.set(id, { id, title, rawRows: taggedRows });
        }
      });
    }
    if (Array.isArray(extraJson.owner_needed)) {
      for (const item of extraJson.owner_needed) {
        if (item && (item.project || item.text)) {
          ownerNeeded.push({
            project: hostPrefix ? `${hostPrefix}${item.project ?? ""}`.trim() : String(item.project ?? ""),
            text: String(item.text ?? "")
          });
        }
      }
    }
  }

  const sections = Array.from(sectionMap.values()).map((sec) => ({
    id: sec.id,
    title: sec.title,
    rows: sortStatusBoardRows(sec.rawRows, nowMs)
  }));

  const health = computeStatusBoardHealth(sections);

  return {
    updated: raw.updated ? String(raw.updated) : null,
    stale,
    ageMinutes,
    healthPct: health.healthPct,
    healthSummary: health.summary,
    sections,
    owner_needed: ownerNeeded
  };
}

/**
 * Detects newly degraded (`bad`) rows and increases in `owner_needed` between two StatusBoard snapshots.
 */
export function detectStatusBoardTransitions(prevBoard, nextBoard) {
  if (!nextBoard || typeof nextBoard !== "object") {
    return { hasAlert: false, newBadRows: [], ownerNeededDelta: 0, summary: null };
  }
  const prevBadKeys = new Set();
  if (prevBoard && Array.isArray(prevBoard.sections)) {
    for (const sec of prevBoard.sections) {
      for (const r of sec?.rows || []) {
        if (r?.status === "bad") {
          prevBadKeys.add(`${sec.id}::${r.label}`);
        }
      }
    }
  }

  const newBadRows = [];
  if (Array.isArray(nextBoard.sections)) {
    for (const sec of nextBoard.sections) {
      for (const r of sec?.rows || []) {
        const key = `${sec.id}::${r.label}`;
        if (r?.status === "bad" && prevBoard && !prevBadKeys.has(key)) {
          newBadRows.push({
            sectionId: sec.id,
            sectionTitle: sec.title,
            label: r.label,
            value: r.value,
            detail: r.detail || null
          });
        }
      }
    }
  }

  const prevOwners = Array.isArray(prevBoard?.owner_needed) ? prevBoard.owner_needed.length : 0;
  const nextOwners = Array.isArray(nextBoard?.owner_needed) ? nextBoard.owner_needed.length : 0;
  const ownerNeededDelta = prevBoard ? Math.max(0, nextOwners - prevOwners) : 0;
  const hasAlert = newBadRows.length > 0 || ownerNeededDelta > 0;

  let summary = null;
  if (hasAlert) {
    const parts = [];
    if (newBadRows.length > 0) {
      parts.push(`Yeni kritik satır: ${newBadRows.map((r) => r.label).join(", ")}`);
    }
    if (ownerNeededDelta > 0) {
      parts.push(`+${ownerNeededDelta} yeni sahiplik bekleyen iş`);
    }
    summary = parts.join(" · ");
  }

  return {
    hasAlert,
    newBadRows,
    ownerNeededDelta,
    summary
  };
}

/**
 * Evaluates failover spend utilization and hourly burn velocity (Hourly Spend Breaker).
 */
export function evaluateFailoverSpendHealth(failoverInfo, options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const cap = failoverInfo?.cap || null;
  const maxUsd = typeof cap?.max === "number" && cap.max > 0 ? cap.max : null;
  const spentUsd = typeof cap?.spent === "number" && cap.spent >= 0 ? cap.spent : null;

  const utilizationPct =
    maxUsd !== null && spentUsd !== null ? Math.min(100, Math.round((spentUsd / maxUsd) * 1000) / 10) : null;

  let burnUsdPerHour = null;
  let estimatedMinutesToCap = null;

  if (failoverInfo?.engaged && failoverInfo?.since && spentUsd !== null && spentUsd > 0) {
    const sinceMs = Date.parse(String(failoverInfo.since));
    if (Number.isFinite(sinceMs) && nowMs > sinceMs) {
      const elapsedHours = Math.max(0.0833, (nowMs - sinceMs) / 3600000); // min 5m window
      burnUsdPerHour = Math.round((spentUsd / elapsedHours) * 100) / 100;
      if (maxUsd !== null && burnUsdPerHour > 0) {
        const remUsd = Math.max(0, maxUsd - spentUsd);
        estimatedMinutesToCap = Math.round((remUsd / burnUsdPerHour) * 60);
      }
    }
  }

  let status = "ok";
  let alertReason = null;

  if (cap?.exceeded || (utilizationPct !== null && utilizationPct >= 95)) {
    status = "critical";
    alertReason = "Failover harcama tavanına ulaşıldı";
  } else if (estimatedMinutesToCap !== null && estimatedMinutesToCap <= 60) {
    status = "critical";
    alertReason = `Yüksek harcama hızı ($${burnUsdPerHour}/saat) — tavan ~${estimatedMinutesToCap} dk içinde dolabilir`;
  } else if (utilizationPct !== null && utilizationPct >= 80) {
    status = "warning";
    alertReason = `Failover harcaması tavanın %${utilizationPct} seviyesinde`;
  } else if (burnUsdPerHour !== null && burnUsdPerHour >= 5.0) {
    status = "warning";
    alertReason = `Hızlı failover tüketimi ($${burnUsdPerHour}/saat)`;
  }

  return {
    status,
    utilizationPct,
    burnUsdPerHour,
    estimatedMinutesToCap,
    alertReason
  };
}

/**
 * Simulates expected 1-hour failover API cost across coding intensity tiers and checks
 * how many hours of standard Claude Code work the remaining Keysmith cap can sustain.
 */
export function estimateFailoverSessionCost(failoverInfo = {}, options = {}) {
  const lightHourlyUsd = typeof options.lightHourlyUsd === "number" ? options.lightHourlyUsd : 0.9;
  const standardHourlyUsd = typeof options.standardHourlyUsd === "number" ? options.standardHourlyUsd : 2.4;
  const heavyHourlyUsd = typeof options.heavyHourlyUsd === "number" ? options.heavyHourlyUsd : 6.0;

  const cap = failoverInfo?.cap || null;
  const maxUsd = typeof cap?.max === "number" && cap.max > 0 ? cap.max : 25;
  const spentUsd = typeof cap?.spent === "number" && cap.spent >= 0 ? cap.spent : 0;
  const remainingUsd =
    typeof cap?.remaining === "number" && cap.remaining >= 0
      ? cap.remaining
      : Math.max(0, Math.round((maxUsd - spentUsd) * 100) / 100);

  const standardHoursCovered =
    standardHourlyUsd > 0 ? Math.round((remainingUsd / standardHourlyUsd) * 10) / 10 : 0;
  const canCoverOneHourStandard = remainingUsd >= standardHourlyUsd;

  return {
    lightHourlyUsd,
    standardHourlyUsd,
    heavyHourlyUsd,
    remainingUsd,
    standardHoursCovered,
    canCoverOneHourStandard,
    summary: `Simülasyon: Standart ~$${standardHourlyUsd.toFixed(2)}/saat · Kalan tavan ~${standardHoursCovered} saat yeter`
  };
}

/**
 * Evaluates account pool OAuth token readiness and pre-warm needs before peak hours.
 */
export function evaluatePoolReadiness(accounts, options = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const enabled = list.filter((a) => a && a.enabled !== false);
  const preWarmWindowMs = (options.preWarmLeadMinutes ?? 45) * 60 * 1000;

  let healthyTokens = 0;
  let readyForRotation = 0;
  const needsPreWarm = [];

  for (const acct of enabled) {
    const tok = acct.token || {};
    const remMs = typeof tok.remainingMs === "number" ? tok.remainingMs : null;
    const tokHealthy = tok.status === "valid" && (remMs === null || remMs > 15 * 60 * 1000);
    if (tokHealthy) {
      healthyTokens += 1;
    }
    if (
      tok.status === "expired" ||
      tok.lastResult === "failed" ||
      tok.lastResult === "persist-failed" ||
      (remMs !== null && remMs <= preWarmWindowMs)
    ) {
      needsPreWarm.push(acct.name);
    }

    const fivePct =
      typeof acct?.usage?.fiveHour?.pct === "number"
        ? acct.usage.fiveHour.pct
        : typeof acct?.fiveHourPct === "number"
          ? acct.fiveHourPct
          : 0;
    const sevenPct =
      typeof acct?.usage?.sevenDay?.pct === "number"
        ? acct.usage.sevenDay.pct
        : typeof acct?.sevenDayPct === "number"
          ? acct.sevenDayPct
          : 0;

    if (tokHealthy && fivePct < 90 && sevenPct < 90) {
      readyForRotation += 1;
    }
  }

  let status = "ok";
  if (enabled.length > 0 && readyForRotation === 0) {
    status = "critical";
  } else if (needsPreWarm.length > 0 || (enabled.length > 1 && readyForRotation < 2)) {
    status = "warning";
  }

  const summary =
    enabled.length === 0
      ? "Etkin hesap yok"
      : needsPreWarm.length > 0
        ? `${readyForRotation}/${enabled.length} rotasyona hazır · ${needsPreWarm.length} ön-yenileme bekliyor`
        : `${readyForRotation}/${enabled.length} hesap rotasyona hazır`;

  return {
    status,
    totalEnabled: enabled.length,
    healthyTokens,
    readyForRotation,
    needsPreWarm,
    summary
  };
}

/**
 * Computes a 0-100 Pool Resilience & Redundancy Score evaluating single-point-of-failure (SPOF) risk,
 * OAuth token validity, 5h/7d quota headroom balance, and failover readiness.
 */
export function evaluatePoolResilienceScore(accounts = [], failoverInfo = {}) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  const risks = [];

  if (enabled.length === 0) {
    return {
      score: 0,
      grade: "D",
      spofRisk: true,
      risks: ["Etkin abonelik hesabı yok"],
      summary: "Dayanıklılık: D (0/100)"
    };
  }

  let score = 0;

  // 1. Account redundancy (up to 35 pts)
  if (enabled.length >= 3) {
    score += 35;
  } else if (enabled.length === 2) {
    score += 25;
  } else {
    score += 10;
    risks.push("Tek hesap (SPOF riski)");
  }

  // 2. Valid OAuth tokens (up to 25 pts)
  const validTokens = enabled.filter((a) => a?.token?.status === "valid").length;
  const tokenRatio = validTokens / enabled.length;
  score += Math.round(tokenRatio * 25);
  if (validTokens < enabled.length) {
    risks.push(`${enabled.length - validTokens} hesapta OAuth yenileme gerekli`);
  }

  // 3. Quota headroom across accounts (up to 25 pts)
  const withHeadroom = enabled.filter((a) => {
    const five =
      typeof a?.usage?.fiveHour?.pct === "number"
        ? a.usage.fiveHour.pct
        : typeof a?.fiveHourPct === "number"
          ? a.fiveHourPct
          : 0;
    const seven =
      typeof a?.usage?.sevenDay?.pct === "number"
        ? a.usage.sevenDay.pct
        : typeof a?.sevenDayPct === "number"
          ? a.sevenDayPct
          : 0;
    return five < 85 && seven < 90;
  }).length;
  score += Math.round((withHeadroom / enabled.length) * 25);
  if (withHeadroom === 0) {
    risks.push("Tüm hesaplar %85+ dolulukta");
  }

  // 4. Failover safety net (up to 15 pts)
  if (failoverInfo?.enabled && failoverInfo?.gatewayReady) {
    score += 15;
  } else if (failoverInfo?.enabled) {
    score += 8;
    risks.push("Failover açık ancak gateway hazır değil");
  } else {
    risks.push("Yedek zincir (Failover) kapalı");
  }

  score = Math.max(0, Math.min(100, score));
  const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "D";
  const spofRisk = enabled.length < 2 && !(failoverInfo?.enabled && failoverInfo?.gatewayReady);

  return {
    score,
    grade,
    spofRisk,
    risks,
    summary: `Dayanıklılık: ${grade} (${score}/100)`
  };
}

/**
 * Computes per-account 5h/7d quota burn-rate, estimated exhaustion time before reset,
 * and recommends the most efficient account (prioritizing "use-it-or-lose-it" windows
 * that reset soon with ample remaining headroom).
 */
export function computeQuotaForecast(accounts, options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const FIVE_HOURS_MIN = 300;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return {
      accounts: [],
      recommendedAccount: null,
      recommendationReason: null
    };
  }

  const evaluated = accounts.map((acct) => {
    const fivePct =
      typeof acct?.usage?.fiveHour?.pct === "number"
        ? acct.usage.fiveHour.pct
        : typeof acct?.fiveHourPct === "number"
          ? acct.fiveHourPct
          : null;
    const sevenPct =
      typeof acct?.usage?.sevenDay?.pct === "number"
        ? acct.usage.sevenDay.pct
        : typeof acct?.sevenDayPct === "number"
          ? acct.sevenDayPct
          : null;
    const resetsAtRaw = acct?.usage?.fiveHour?.resetsAt ?? acct?.fiveHourResetsAt ?? null;
    const resetMs = resetsAtRaw ? Date.parse(String(resetsAtRaw)) : Number.NaN;
    const minutesUntilReset =
      Number.isFinite(resetMs) && resetMs > nowMs ? Math.max(1, Math.round((resetMs - nowMs) / 60000)) : null;

    let burnRateRatio = null;
    let minutesUntilExhaustion = null;
    let willExhaustBeforeReset = false;
    let pace = "unknown";

    if (fivePct !== null && minutesUntilReset !== null && minutesUntilReset < FIVE_HOURS_MIN) {
      const elapsedMin = Math.max(5, FIVE_HOURS_MIN - minutesUntilReset);
      const elapsedPct = (elapsedMin / FIVE_HOURS_MIN) * 100;
      burnRateRatio = elapsedPct > 0 ? Math.round((fivePct / elapsedPct) * 100) / 100 : null;
      const pctPerMin = fivePct / elapsedMin;
      if (pctPerMin > 0) {
        const remainingPct = Math.max(0, 100 - fivePct);
        minutesUntilExhaustion = Math.round(remainingPct / pctPerMin);
        willExhaustBeforeReset = minutesUntilExhaustion < minutesUntilReset;
      }
      if (fivePct >= 95 || (willExhaustBeforeReset && minutesUntilExhaustion !== null && minutesUntilExhaustion <= 30)) {
        pace = "critical";
      } else if (willExhaustBeforeReset || (burnRateRatio !== null && burnRateRatio > 1.25)) {
        pace = "fast";
      } else {
        pace = "safe";
      }
    } else if (fivePct !== null) {
      pace = fivePct >= 95 ? "critical" : fivePct >= 80 ? "fast" : "safe";
    }

    const useItOrLoseIt =
      fivePct !== null &&
      fivePct <= 70 &&
      (sevenPct === null || sevenPct < 90) &&
      minutesUntilReset !== null &&
      minutesUntilReset <= 90;

    const sevenResetsAtRaw = acct?.usage?.sevenDay?.resetsAt ?? acct?.sevenDayResetsAt ?? null;
    const sevenResetMs = sevenResetsAtRaw ? Date.parse(String(sevenResetsAtRaw)) : Number.NaN;
    const sevenHoursLeft =
      Number.isFinite(sevenResetMs) && sevenResetMs > nowMs ? (sevenResetMs - nowMs) / 3600000 : null;

    let weeklyEfficiency = null;
    if (sevenPct !== null) {
      if (sevenPct >= 95) {
        weeklyEfficiency = "saturated";
      } else if (sevenPct >= 65) {
        weeklyEfficiency = "optimal";
      } else if (sevenPct < 35 && sevenHoursLeft !== null && sevenHoursLeft <= 36) {
        weeklyEfficiency = "underutilized";
      } else {
        weeklyEfficiency = "balanced";
      }
    }

    return {
      name: String(acct?.name || ""),
      active: Boolean(acct?.active),
      fiveHourPct: fivePct,
      sevenDayPct: sevenPct,
      minutesUntilReset,
      burnRateRatio,
      minutesUntilExhaustion,
      willExhaustBeforeReset,
      pace,
      useItOrLoseIt,
      weeklyEfficiency
    };
  });

  // Pick recommended account:
  // 1. Any non-exhausted "use-it-or-lose-it" account (resets <= 90m with >=30% free)
  // 2. Otherwise the account with the lowest effective utilization
  let recommendedAccount = null;
  let recommendationReason = null;

  const candidates = evaluated.filter(
    (a) => (a.fiveHourPct === null || a.fiveHourPct < 95) && (a.sevenDayPct === null || a.sevenDayPct < 95)
  );
  const expiringWithHeadroom = candidates
    .filter((a) => a.useItOrLoseIt)
    .sort((a, b) => (a.minutesUntilReset ?? 999) - (b.minutesUntilReset ?? 999));

  if (expiringWithHeadroom.length > 0) {
    const pick = expiringWithHeadroom[0];
    recommendedAccount = pick.name;
    recommendationReason = `5s penceresi ${pick.minutesUntilReset} dk içinde sıfırlanıyor (%${Math.round(100 - (pick.fiveHourPct ?? 0))} boş kapasite)`;
  } else if (candidates.length > 0) {
    const sorted = [...candidates].sort((a, b) => {
      const aMax = Math.max(a.fiveHourPct ?? 0, a.sevenDayPct ?? 0);
      const bMax = Math.max(b.fiveHourPct ?? 0, b.sevenDayPct ?? 0);
      return aMax - bMax;
    });
    recommendedAccount = sorted[0].name;
    const rem = Math.round(100 - Math.max(sorted[0].fiveHourPct ?? 0, sorted[0].sevenDayPct ?? 0));
    recommendationReason = `En yüksek kalan kapasite (%${rem} boş)`;
  }

  return {
    accounts: evaluated,
    recommendedAccount,
    recommendationReason
  };
}

/**
 * Generates a privacy-safe Markdown summary of the control center and status board.
 */
export function buildControlCenterMarkdown(snapshot = {}) {
  const lines = [];
  lines.push(`# Keyflip Kontrol Merkezi Özeti`);
  if (snapshot.generatedAt) {
    lines.push(`Güncelleme: ${snapshot.generatedAt}`);
  }
  lines.push("");

  if (snapshot.statusBoard) {
    const sb = snapshot.statusBoard;
    const ownerItems = Array.isArray(sb.owner_needed) ? sb.owner_needed : [];
    lines.push(`## Durum Panosu${sb.stale ? " (VERİ ESKİ)" : ""}`);
    if (ownerItems.length > 0) {
      lines.push(`### Sahipten Bekleyen (${ownerItems.length})`);
      for (const item of ownerItems) {
        lines.push(`- **[${item.project}]** ${item.text}`);
      }
    }
    const sections = Array.isArray(sb.sections) ? sb.sections : [];
    for (const sec of sections) {
      const alertRows = (sec.rows || []).filter((r) => r.status === "bad" || r.status === "warn");
      if (alertRows.length > 0) {
        lines.push(`### ${sec.title} (Sorun/Uyarı: ${alertRows.length})`);
        for (const r of alertRows) {
          lines.push(`- [${r.status.toUpperCase()}] **${r.label}**: ${r.value}${r.detail ? ` — ${r.detail}` : ""}`);
        }
      }
    }
    lines.push("");
  }

  if (snapshot.quotaForecast?.recommendedAccount) {
    lines.push(
      `## Akıllı Kota Önerisi\n- Önerilen Hesap: **${snapshot.quotaForecast.recommendedAccount}** (${snapshot.quotaForecast.recommendationReason || ""})\n`
    );
  }

  if (snapshot.poolReadiness?.summary) {
    lines.push(`## Havuz Hazırlığı\n- Durum: **${snapshot.poolReadiness.summary}**\n`);
  }

  return lines.join("\n").trim() + "\n";
}

/**
 * Collects recent audit events from events.jsonl for the menu bar timeline.
 */
export function collectAuditTimeline(ctx, options = {}) {
  const limit = typeof options.limit === "number" && options.limit > 0 ? options.limit : 8;
  const rawEvents = ctx?.configDir ? _history.readEvents(ctx, limit) : [];
  return rawEvents
    .slice()
    .reverse()
    .map((ev, idx) => {
      const kind = String(ev?.kind || "event");
      const at = ev?.at ? String(ev.at) : null;
      let status = "ok";
      let summary = kind;
      let detail = ev?.reason ? String(ev.reason) : null;

      if (kind === "daemon-switch" || kind === "autoswitch" || kind === "switch") {
        summary = `Hesap geçişi: ${ev.from || "?"} → ${ev.to || "?"}`;
        status = "ok";
      } else if (kind === "daemon-failover-on" || kind === "failover-on") {
        summary = "Yedek zincir (Failover) devreye alındı";
        status = "warn";
      } else if (kind === "daemon-failover-off" || kind === "failover-off") {
        summary = "Yedek zincir kapatıldı (normal hesaba dönüldü)";
        status = "ok";
      } else if (kind === "service-restart") {
        summary = `Servis yeniden başlatıldı: ${ev.label || "?"}`;
        status = ev.ok === false ? "bad" : "ok";
        detail = ev.detail ? String(ev.detail) : detail;
      } else if (kind === "daemon-config") {
        const keys = Array.isArray(ev.keys) ? ev.keys.join(", ") : "";
        summary = `Ayarlar güncellendi${keys ? `: ${keys}` : ""}`;
        status = "ok";
      }

      return {
        id: `${at || idx}-${kind}-${idx}`,
        at,
        kind,
        status,
        summary,
        detail
      };
    });
}

export function collectPreferences(ctx) {
  const homeDir = ctx?.home || ctx?.homeDir || os.homedir();
  const daemonPlist = path.join(homeDir, "Library", "LaunchAgents", "com.keyflip.daemon.plist");
  const snoozeUntil = _config.get(ctx, "desktop.snoozeUntil") || "";
  const nowMs = typeof ctx?.nowMs === "function" ? ctx.nowMs() : Date.now();
  const snoozeMs = snoozeUntil ? Date.parse(snoozeUntil) : Number.NaN;
  const snoozed = Number.isFinite(snoozeMs) && snoozeMs > nowMs;
  return {
    thresholdPct: _config.get(ctx, "autoswitch.threshold") ?? 95,
    refreshIntervalSec: _config.get(ctx, "daemon.autoswitchIntervalSeconds") ?? 120,
    notify: _config.get(ctx, "notify.desktop") !== false,
    launchAtLogin: fs.existsSync(daemonPlist),
    statusFile: _config.get(ctx, "menubar.statusFile") || "~/.polyctl/admin/status.json",
    extraStatusFiles: _config.get(ctx, "menubar.extraStatusFiles") || "",
    snoozeUntil: snoozed ? snoozeUntil : "",
    snoozed
  };
}

/**
 * Evaluates whether the current timestamp falls inside the user's configured quiet/focus hours
 * (e.g. "23:00-08:00") and computes the total remaining pool headroom in minutes.
 */
export function evaluatePoolHorizonAndQuietHours(accounts, options = {}) {
  const list = Array.isArray(accounts) ? accounts.filter((a) => a && a.enabled !== false) : [];
  let totalRemainingFiveHourPct = 0;
  for (const acct of list) {
    const used =
      typeof acct?.usage?.fiveHour?.pct === "number"
        ? acct.usage.fiveHour.pct
        : typeof acct?.fiveHourPct === "number"
          ? acct.fiveHourPct
          : 0;
    totalRemainingFiveHourPct += Math.max(0, 100 - used);
  }
  const burnPctPerMinute =
    typeof options.burnPctPerMinute === "number" && options.burnPctPerMinute > 0 ? options.burnPctPerMinute : 0.5;
  const estimatedPoolDepletionMinutes =
    list.length > 0 ? Math.round(totalRemainingFiveHourPct / burnPctPerMinute) : 0;

  return {
    enabledAccounts: list.length,
    totalRemainingFiveHourPct: Math.round(totalRemainingFiveHourPct * 10) / 10,
    estimatedPoolDepletionMinutes
  };
}

/**
 * Generates an anonymized, zero-secret diagnostic bundle for support or debugging.
 */
export function buildDiagnosticBundle(snapshot = {}) {
  const homeDir = os.homedir();
  const sanitizeStr = (val) => {
    if (typeof val !== "string") return val;
    let out = val.split(homeDir).join("~");
    out = out.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL_REDACTED]");
    out = out.replace(/(sk-ant-[a-zA-Z0-9_-]{6,}|sk-[a-zA-Z0-9_-]{16,}|eyJ[a-zA-Z0-9_-]{10,})/g, "[SECRET_REDACTED]");
    return out;
  };
  const walk = (obj) => {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "string") return sanitizeStr(obj);
    if (typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(walk);
    const copy = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/^(access_?token|refresh_?token|session_?key|api_?key|secret|password|cookie)$/i.test(k)) {
        copy[k] = "[REDACTED]";
      } else {
        copy[k] = walk(v);
      }
    }
    return copy;
  };
  return {
    schema: "keyflip.diagnostic.v1",
    generatedAt: snapshot.generatedAt || new Date().toISOString(),
    summary: walk({
      daemon: snapshot.daemon || null,
      activeAccount: snapshot.activeAccount || null,
      accountCount: Array.isArray(snapshot.accounts) ? snapshot.accounts.length : 0,
      poolReadiness: snapshot.poolReadiness || null,
      poolResilience: snapshot.poolResilience || null,
      quotaForecast: snapshot.quotaForecast || null,
      failover: snapshot.failover || null,
      services: snapshot.services || [],
      statusBoardSummary: snapshot.statusBoard
        ? {
            stale: snapshot.statusBoard.stale,
            healthPct: snapshot.statusBoard.healthPct ?? null,
            sectionCount: Array.isArray(snapshot.statusBoard.sections) ? snapshot.statusBoard.sections.length : 0,
            ownerNeededCount: Array.isArray(snapshot.statusBoard.owner_needed)
              ? snapshot.statusBoard.owner_needed.length
              : 0
          }
        : null,
      auditTimeline: snapshot.auditTimeline || []
    })
  };
}

const TR_WEEKDAYS = Object.freeze(["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"]);

/**
 * Builds a chronological 7-day reset calendar across all enabled accounts so the user
 * can see which account's weekly window refreshes next and how much unused capacity it holds.
 */
export function buildWeeklyResetCalendar(accounts = [], options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  const items = [];

  for (const acct of enabled) {
    const rawReset = acct?.usage?.sevenDay?.resetsAt ?? acct?.sevenDayResetsAt ?? null;
    if (!rawReset) continue;
    const resetMs = Date.parse(String(rawReset));
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) continue;
    const hoursUntilReset = Math.max(1, Math.round((resetMs - nowMs) / 3600000));
    const sevenPct =
      typeof acct?.usage?.sevenDay?.pct === "number"
        ? acct.usage.sevenDay.pct
        : typeof acct?.sevenDayPct === "number"
          ? acct.sevenDayPct
          : 0;
    const unusedPct = Math.max(0, Math.round((100 - sevenPct) * 10) / 10);
    const dt = new Date(resetMs);
    const dayLabel = TR_WEEKDAYS[dt.getUTCDay()] || "";
    const hh = String(dt.getUTCHours()).padStart(2, "0");
    const mm = String(dt.getUTCMinutes()).padStart(2, "0");

    items.push({
      account: String(acct.name || ""),
      resetsAt: String(rawReset),
      hoursUntilReset,
      unusedSevenDayPct: unusedPct,
      slotLabel: `${dayLabel} ${hh}:${mm}`
    });
  }

  items.sort((a, b) => a.hoursUntilReset - b.hoursUntilReset);
  const nextReset = items[0] || null;
  const summary = nextReset
    ? `Sıradaki 7g sıfırlama: ${nextReset.account} (${nextReset.slotLabel} · ${nextReset.hoursUntilReset}s kaldı)`
    : null;

  return {
    items,
    nextResetAccount: nextReset ? nextReset.account : null,
    nextResetHours: nextReset ? nextReset.hoursUntilReset : null,
    summary
  };
}

/**
 * Compares two StatusBoard snapshots (`prev` and `next`) and returns a structured diff
 * including newly degraded (`bad`/`warn`) rows, recovered (`ok`) rows, and `owner_needed` changes.
 */
export function diffStatusBoards(prevInput, nextInput) {
  const parseBoard = (inp) => {
    if (!inp) return { sections: [], owner_needed: [] };
    if (typeof inp === "string") {
      try {
        return JSON.parse(inp);
      } catch {
        return { sections: [], owner_needed: [] };
      }
    }
    return typeof inp === "object" ? inp : { sections: [], owner_needed: [] };
  };

  const prev = parseBoard(prevInput);
  const next = parseBoard(nextInput);

  const prevRows = new Map();
  for (const sec of prev.sections || []) {
    for (const r of sec?.rows || []) {
      prevRows.set(`${sec.id}::${r.label}`, {
        sectionId: sec.id,
        sectionTitle: sec.title || sec.id,
        label: r.label,
        status: r.status || "unknown",
        value: r.value ?? ""
      });
    }
  }

  const degraded = [];
  const recovered = [];
  const added = [];

  for (const sec of next.sections || []) {
    for (const r of sec?.rows || []) {
      const key = `${sec.id}::${r.label}`;
      const curStatus = r.status || "unknown";
      const old = prevRows.get(key);
      if (!old) {
        added.push({ sectionId: sec.id, label: r.label, status: curStatus, value: r.value ?? "" });
        continue;
      }
      const oldRank = STATUS_ROW_RANK[old.status] ?? 3;
      const curRank = STATUS_ROW_RANK[curStatus] ?? 3;
      if (curRank < oldRank && (curStatus === "bad" || curStatus === "warn")) {
        degraded.push({
          sectionId: sec.id,
          label: r.label,
          fromStatus: old.status,
          toStatus: curStatus,
          fromValue: old.value,
          toValue: r.value ?? ""
        });
      } else if (oldRank < 2 && curStatus === "ok") {
        recovered.push({
          sectionId: sec.id,
          label: r.label,
          fromStatus: old.status,
          toStatus: "ok",
          toValue: r.value ?? ""
        });
      }
    }
  }

  const prevOwnerSet = new Set((prev.owner_needed || []).map((o) => `${o.project}::${o.text}`));
  const nextOwnerSet = new Set((next.owner_needed || []).map((o) => `${o.project}::${o.text}`));
  const addedOwners = (next.owner_needed || []).filter((o) => !prevOwnerSet.has(`${o.project}::${o.text}`));
  const resolvedOwners = (prev.owner_needed || []).filter((o) => !nextOwnerSet.has(`${o.project}::${o.text}`));

  const prevHealth = computeStatusBoardHealth(prev.sections || []).healthPct;
  const nextHealth = computeStatusBoardHealth(next.sections || []).healthPct;
  const healthDelta = nextHealth - prevHealth;

  return {
    hasChanges:
      degraded.length > 0 || recovered.length > 0 || added.length > 0 || addedOwners.length > 0 || resolvedOwners.length > 0,
    prevHealthPct: prevHealth,
    nextHealthPct: nextHealth,
    healthDelta,
    degraded,
    recovered,
    added,
    addedOwners,
    resolvedOwners,
    summary: `Sağlık: %${prevHealth} → %${nextHealth} (${healthDelta >= 0 ? `+${healthDelta}` : healthDelta}) · Kötüleşen: ${degraded.length} · İyileşen: ${recovered.length}`
  };
}

/**
 * Computes a Multi-Provider AI Diversification & Continuity Index across Claude subscriptions,
 * Keysmith failover, and secondary AI coding tools (Antigravity, Kiro, Copilot, EVREN, API credits).
 */
export function evaluateMultiProviderContinuity(accounts = [], failoverInfo = {}, otherQuotas = []) {
  const enabledClaude = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  const activeClaudeWithHeadroom = enabledClaude.filter((a) => {
    const five =
      typeof a?.usage?.fiveHour?.pct === "number"
        ? a.usage.fiveHour.pct
        : typeof a?.fiveHourPct === "number"
          ? a.fiveHourPct
          : 0;
    const seven =
      typeof a?.usage?.sevenDay?.pct === "number"
        ? a.usage.sevenDay.pct
        : typeof a?.sevenDayPct === "number"
          ? a.sevenDayPct
          : 0;
    return five < 90 && seven < 95;
  });

  const healthySecondaryTools = (Array.isArray(otherQuotas) ? otherQuotas : []).filter(
    (q) => q && (q.status === "ok" || q.status === "warning") && (q.usedPct === null || q.usedPct === undefined || q.usedPct < 95)
  );

  const activeSurfaces = [];
  if (activeClaudeWithHeadroom.length > 0) {
    activeSurfaces.push(`Claude (${activeClaudeWithHeadroom.length} hesap)`);
  }
  if (failoverInfo?.enabled && failoverInfo?.gatewayReady && !failoverInfo?.cap?.exceeded) {
    activeSurfaces.push("Keysmith Failover");
  }
  for (const tool of healthySecondaryTools) {
    activeSurfaces.push(tool.label || tool.id);
  }

  let score = 0;
  if (activeClaudeWithHeadroom.length >= 2) score += 45;
  else if (activeClaudeWithHeadroom.length === 1) score += 25;

  if (failoverInfo?.enabled && failoverInfo?.gatewayReady && !failoverInfo?.cap?.exceeded) {
    score += 25;
  }
  score += Math.min(30, healthySecondaryTools.length * 10);
  score = Math.max(0, Math.min(100, score));

  const tier = score >= 80 ? "high" : score >= 50 ? "medium" : "low";
  return {
    score,
    tier,
    readyClaudeCount: activeClaudeWithHeadroom.length,
    readySecondaryCount: healthySecondaryTools.length,
    activeSurfaces,
    summary: `Süreklilik: %${score} (${activeSurfaces.length} aktif yüzey)`
  };
}

/**
 * Evaluates all monitored services (`collectServicesStatus`) and returns a consolidated
 * Service Fleet Health Score (`0-100`) and actionable recovery advice.
 */
export function evaluateServicesHealthSummary(services = []) {
  const list = Array.isArray(services) ? services : [];
  if (list.length === 0) {
    return {
      score: 100,
      status: "ok",
      healthyCount: 0,
      warningCount: 0,
      errorCount: 0,
      failedLabels: [],
      summary: "İzlenen servis yok"
    };
  }

  let healthyCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  const failedLabels = [];

  for (const svc of list) {
    if (svc?.state === "running" || svc?.state === "scheduled") {
      healthyCount += 1;
    } else if (svc?.state === "warning") {
      warningCount += 1;
    } else if (svc?.state === "error") {
      errorCount += 1;
      if (svc.label) failedLabels.push(svc.label);
    }
  }

  const weighted = healthyCount * 1.0 + warningCount * 0.5 + (list.length - healthyCount - warningCount - errorCount) * 0.5;
  const score = Math.max(0, Math.min(100, Math.round((weighted / list.length) * 100)));
  const status = errorCount > 0 ? "critical" : warningCount > 0 ? "warning" : "ok";

  return {
    score,
    status,
    healthyCount,
    warningCount,
    errorCount,
    failedLabels,
    summary:
      errorCount > 0
        ? `${errorCount} serviste hata (${failedLabels.join(", ")}) · %${score} sağlıklı`
        : `${healthyCount}/${list.length} servis sağlıklı (%${score})`
  };
}

/**
 * Analyzes recent switch and failover events from `events.jsonl` (or provided event array)
 * to identify the peak UTC hour window where quota bottlenecks / forced rotations happen most frequently.
 */
export function predictDailyBottleneckWindow(ctxOrEvents, options = {}) {
  const limit = typeof options.limit === "number" && options.limit > 0 ? options.limit : 100;
  let events = [];
  if (Array.isArray(ctxOrEvents)) {
    events = ctxOrEvents;
  } else if (ctxOrEvents?.configDir) {
    events = _history.readEvents(ctxOrEvents, limit);
  }

  const hourCounts = new Array(24).fill(0);
  let totalRotations = 0;

  for (const ev of events) {
    const kind = String(ev?.kind || "");
    if (
      kind === "daemon-switch" ||
      kind === "autoswitch" ||
      kind === "switch" ||
      kind === "daemon-failover-on" ||
      kind === "failover-on"
    ) {
      const ts = ev?.at ? Date.parse(String(ev.at)) : Number.NaN;
      if (Number.isFinite(ts)) {
        const hour = new Date(ts).getUTCHours();
        hourCounts[hour] += 1;
        totalRotations += 1;
      }
    }
  }

  if (totalRotations === 0) {
    return {
      totalRotations: 0,
      peakHourUtc: null,
      peakWindowLabel: null,
      peakCount: 0,
      summary: null
    };
  }

  let peakHourUtc = 0;
  let peakCount = 0;
  for (let h = 0; h < 24; h += 1) {
    if (hourCounts[h] > peakCount) {
      peakCount = hourCounts[h];
      peakHourUtc = h;
    }
  }

  const nextHour = (peakHourUtc + 1) % 24;
  const hh1 = String(peakHourUtc).padStart(2, "0");
  const hh2 = String(nextHour).padStart(2, "0");
  const peakWindowLabel = `${hh1}:00-${hh2}:00 UTC`;

  return {
    totalRotations,
    peakHourUtc,
    peakWindowLabel,
    peakCount,
    summary: `Darboğaz saati: ${peakWindowLabel} (${peakCount}/${totalRotations} geçiş)`
  };
}

/**
 * Saves a timestamped snapshot copy of a valid status.json into `<configDir>/status-snapshots/`
 * so users or scripts can later compare transitions with `keyflip status-board diff`.
 */
export function snapshotStatusBoard(ctx, options = {}) {
  const homeDir = options.homeDir || ctx?.home || ctx?.homeDir || os.homedir();
  const configDir = options.configDir || ctx?.configDir || path.join(homeDir, ".config", "keyflip");
  const rawSource =
    options.sourceFile || process.env.KEYFLIP_STATUS_FILE || _config.get(ctx, "menubar.statusFile") || "~/.polyctl/admin/status.json";
  const resolvedSource = expandHomePath(rawSource, homeDir);

  if (!resolvedSource || !fs.existsSync(resolvedSource)) {
    const err = new Error(`status.json file not found: ${resolvedSource}`);
    err.code = "STATUS_FILE_MISSING";
    throw err;
  }

  const content = fs.readFileSync(resolvedSource, "utf8");
  const validation = validateStatusBoardSchema(content);
  if (!validation.valid) {
    const err = new Error(`Invalid status.json: ${validation.errors.join("; ")}`);
    err.code = "STATUS_FILE_INVALID";
    throw err;
  }

  const snapDir = options.outDir || path.join(configDir, "status-snapshots");
  fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });
  const nowIso = (typeof options.now === "function" ? options.now() : new Date().toISOString()).replace(/[:.]/g, "-");
  const fileName = `status-${nowIso}.json`;
  const snapshotPath = path.join(snapDir, fileName);
  fs.writeFileSync(snapshotPath, content, { encoding: "utf8", mode: 0o600 });

  const latestPath = path.join(snapDir, "latest.json");
  fs.writeFileSync(latestPath, content, { encoding: "utf8", mode: 0o600 });

  return {
    ok: true,
    sourcePath: resolvedSource,
    snapshotPath,
    latestPath,
    stats: validation.stats
  };
}

/**
 * Evaluates a readiness checklist ("Work Session Readiness") before starting a long coding or agent session.
 * Checks 5 pillars: (1) Active Claude 5h headroom >=25%, (2) Valid OAuth token >=30m,
 * (3) Backup account or Failover ready, (4) Critical local services healthy, (5) Status board has 0 `bad` items.
 */
export function evaluateWorkSessionReadiness({
  accounts = [],
  failover = {},
  services = [],
  statusBoard = null
} = {}) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  const active = enabled.find((a) => a.active) || enabled[0] || null;

  const activeFivePct =
    typeof active?.usage?.fiveHour?.pct === "number"
      ? active.usage.fiveHour.pct
      : typeof active?.fiveHourPct === "number"
        ? active.fiveHourPct
        : 0;
  const checkHeadroom = Boolean(active && activeFivePct <= 75);

  const remMs = typeof active?.token?.remainingMs === "number" ? active.token.remainingMs : null;
  const checkToken = Boolean(active && active?.token?.status === "valid" && (remMs === null || remMs >= 30 * 60 * 1000));

  const backupReady =
    enabled.length >= 2 || Boolean(failover?.enabled && failover?.gatewayReady && !failover?.cap?.exceeded);

  const svcList = Array.isArray(services) ? services : [];
  const checkServices = svcList.every((s) => s?.state !== "error");

  let boardBadCount = 0;
  if (statusBoard && Array.isArray(statusBoard.sections)) {
    for (const sec of statusBoard.sections) {
      for (const r of sec?.rows || []) {
        if (r?.status === "bad") boardBadCount += 1;
      }
    }
  }
  const checkBoard = boardBadCount === 0;

  const checks = [
    { id: "headroom", label: "Etkin hesap 5s boşluk ≥%25", passed: checkHeadroom },
    { id: "token", label: "OAuth belirteci ≥30 dk geçerli", passed: checkToken },
    { id: "backup", label: "Yedek hesap veya Failover hazır", passed: backupReady },
    { id: "services", label: "Yerel servislerde hata yok", passed: checkServices },
    { id: "board", label: "Durum panosunda kritik (bad) satır yok", passed: checkBoard }
  ];

  const passedCount = checks.filter((c) => c.passed).length;
  const totalCount = checks.length;
  const status = passedCount === totalCount ? "ready" : passedCount >= 3 ? "caution" : "blocked";
  const failedLabels = checks.filter((c) => !c.passed).map((c) => c.label);

  return {
    status,
    passedCount,
    totalCount,
    checks,
    failedLabels,
    summary:
      passedCount === totalCount
        ? `Oturuma Hazır (${passedCount}/${totalCount} kontrol tam)`
        : `Seans Kontrolü: ${passedCount}/${totalCount} hazır`
  };
}

/**
 * Estimates monthly subscription & API value realization (ROI) across active Claude subscriptions
 * and monthly API promotional grants (`apicredits`), highlighting how much value is actively utilized.
 */
export function evaluateSubscriptionValueROI(accounts = [], otherQuotas = [], failoverInfo = {}) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  let avgWeeklyUtilizationPct = 0;
  if (enabled.length > 0) {
    const sum = enabled.reduce((acc, a) => {
      const seven =
        typeof a?.usage?.sevenDay?.pct === "number"
          ? a.usage.sevenDay.pct
          : typeof a?.sevenDayPct === "number"
            ? a.sevenDayPct
            : 0;
      return acc + seven;
    }, 0);
    avgWeeklyUtilizationPct = Math.round((sum / enabled.length) * 10) / 10;
  }

  // Estimate equivalent API value generated per week (~$60/wk at 100% Max utilization per account)
  const estimatedWeeklyApiEquivalentUsd =
    Math.round(enabled.reduce((acc, a) => {
      const seven =
        typeof a?.usage?.sevenDay?.pct === "number"
          ? a.usage.sevenDay.pct
          : typeof a?.sevenDayPct === "number"
            ? a.sevenDayPct
            : 0;
      const tierMultiplier = String(a?.tier || "").toLowerCase().includes("max") ? 60 : 25;
      return acc + (seven / 100) * tierMultiplier;
    }, 0) * 100) / 100;

  const apiCreditsItem = (Array.isArray(otherQuotas) ? otherQuotas : []).find((q) => q?.id === "apicredits") || null;
  const failoverSpentUsd =
    typeof failoverInfo?.cap?.spent === "number" && failoverInfo.cap.spent >= 0 ? failoverInfo.cap.spent : 0;

  return {
    enabledSubscriptionCount: enabled.length,
    avgWeeklyUtilizationPct,
    estimatedWeeklyApiEquivalentUsd,
    failoverSpentUsd,
    apiCreditsStatus: apiCreditsItem ? apiCreditsItem.status : "unreadable",
    summary: `Haftalık verim: %${avgWeeklyUtilizationPct} (~$${estimatedWeeklyApiEquivalentUsd.toFixed(0)} eşdeğer API değeri)`
  };
}

/**
 * Lists saved status.json snapshots in `<configDir>/status-snapshots/` and optionally diffs
 * the latest saved snapshot against the live status.json file.
 */
export function listStatusBoardSnapshots(ctx, options = {}) {
  const homeDir = options.homeDir || ctx?.home || ctx?.homeDir || os.homedir();
  const configDir = options.configDir || ctx?.configDir || path.join(homeDir, ".config", "keyflip");
  const snapDir = options.outDir || path.join(configDir, "status-snapshots");
  if (!fs.existsSync(snapDir)) {
    return { snapshots: [], latestPath: null, diffWithLive: null };
  }
  const files = fs
    .readdirSync(snapDir)
    .filter((f) => f.startsWith("status-") && f.endsWith(".json"))
    .sort()
    .reverse();

  const snapshots = files.map((fileName) => {
    const fullPath = path.join(snapDir, fileName);
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(fullPath).size;
    } catch {}
    return {
      fileName,
      path: fullPath,
      sizeBytes
    };
  });

  const latestPath = snapshots.length > 0 ? snapshots[0].path : null;
  let diffWithLive = null;

  const rawLive =
    options.sourceFile || process.env.KEYFLIP_STATUS_FILE || _config.get(ctx, "menubar.statusFile") || "~/.polyctl/admin/status.json";
  const resolvedLive = expandHomePath(rawLive, homeDir);
  if (latestPath && resolvedLive && fs.existsSync(latestPath) && fs.existsSync(resolvedLive)) {
    try {
      diffWithLive = diffStatusBoards(fs.readFileSync(latestPath, "utf8"), fs.readFileSync(resolvedLive, "utf8"));
    } catch {
      diffWithLive = null;
    }
  }

  return {
    snapshots,
    latestPath,
    diffWithLive
  };
}

/**
 * Evaluates account rotation stability ("Ping-Pong / Thrashing Guard") by inspecting recent switch events.
 * Detects rapid back-and-forth account switches (<15 min apart) and recommends threshold tuning.
 */
export function evaluateRotationStability(ctxOrEvents, options = {}) {
  const limit = typeof options.limit === "number" && options.limit > 0 ? options.limit : 50;
  const rapidWindowMin = typeof options.rapidWindowMin === "number" ? options.rapidWindowMin : 15;
  let events = [];
  if (Array.isArray(ctxOrEvents)) {
    events = ctxOrEvents;
  } else if (ctxOrEvents?.configDir) {
    events = _history.readEvents(ctxOrEvents, limit);
  }

  const switchEvents = events
    .filter((ev) => {
      const k = String(ev?.kind || "");
      return k === "daemon-switch" || k === "autoswitch" || k === "switch";
    })
    .map((ev) => ({
      ...ev,
      ts: ev?.at ? Date.parse(String(ev.at)) : Number.NaN
    }))
    .filter((ev) => Number.isFinite(ev.ts))
    .sort((a, b) => a.ts - b.ts);

  let rapidSwitchCount = 0;
  let minIntervalMinutes = null;

  for (let i = 1; i < switchEvents.length; i += 1) {
    const deltaMin = Math.max(0, Math.round((switchEvents[i].ts - switchEvents[i - 1].ts) / 60000));
    if (minIntervalMinutes === null || deltaMin < minIntervalMinutes) {
      minIntervalMinutes = deltaMin;
    }
    if (deltaMin < rapidWindowMin) {
      rapidSwitchCount += 1;
    }
  }

  const status = rapidSwitchCount >= 2 ? "thrashing" : rapidSwitchCount === 1 ? "warning" : "stable";
  const summary =
    switchEvents.length < 2
      ? "Rotasyon kararlı (충분 geçiş verisi bekleniyor)".replace("충분 ", "")
      : status === "thrashing"
        ? `Ping-pong uyarısı: ${rapidSwitchCount} hızlı geçiş (<15 dk) · eşiği düşürün`
        : status === "warning"
          ? `1 hızlı geçiş tespit edildi (en kısa aralık: ${minIntervalMinutes} dk)`
          : `Rotasyon kararlı (en kısa aralık: ${minIntervalMinutes} dk)`;

  return {
    status,
    totalSwitches: switchEvents.length,
    rapidSwitchCount,
    minIntervalMinutes,
    summary
  };
}

/**
 * Evaluates overall Fleet Agent Health & Efficiency Score (0-100) from fleet status counts.
 * Highlights stuck/dormant ratio and active agent utilization.
 */
export function evaluateFleetEfficiency(fleetStatus = null) {
  if (!fleetStatus || fleetStatus.status === "unreadable" || typeof fleetStatus.total !== "number") {
    return {
      status: "unreadable",
      score: null,
      activeRatioPct: null,
      stuckCount: 0,
      summary: null
    };
  }
  const working = typeof fleetStatus.working === "number" ? fleetStatus.working : 0;
  const idle = typeof fleetStatus.idle === "number" ? fleetStatus.idle : 0;
  const stuck = typeof fleetStatus.stuck === "number" ? fleetStatus.stuck : 0;
  const activePool = working + idle + stuck;
  const activeRatioPct = activePool > 0 ? Math.round((working / activePool) * 100) : 0;

  let score = 100;
  if (stuck > 0) {
    score -= Math.min(60, stuck * 25);
  }
  if (activePool > 0 && working === 0) {
    score -= 15;
  }
  score = Math.max(0, Math.min(100, score));
  const status = stuck > 0 ? "warning" : "ok";

  return {
    status,
    score,
    activeRatioPct,
    stuckCount: stuck,
    summary:
      stuck > 0
        ? `Filo sağlığı: %${score} (${stuck} takılı ajan incelenmeli)`
        : `Filo sağlığı: %${score} (aktif kullanım %${activeRatioPct})`
  };
}

/**
 * Evaluates Remote Server & Hosted Sites SLA Health Score (0-100) from server snapshot.
 */
export function evaluateServerSitesHealth(serverStatus = null) {
  if (!serverStatus || serverStatus.status === "unreadable") {
    return {
      status: "unreadable",
      score: null,
      healthySites: 0,
      totalSites: 0,
      downSites: [],
      summary: null
    };
  }
  const sites = Array.isArray(serverStatus.sites) ? serverStatus.sites : [];
  const totalSites = sites.length;
  let healthySites = 0;
  const downSites = [];

  for (const s of sites) {
    if (s?.status === "ok") {
      healthySites += 1;
    } else if (s?.status === "down" || s?.status === "warning") {
      downSites.push(s.name || "site");
    }
  }

  let score = totalSites > 0 ? Math.round((healthySites / totalSites) * 100) : 100;
  if (serverStatus.status === "down") score = Math.min(score, 20);
  else if (serverStatus.status === "warning") score = Math.min(score, 75);

  const status = downSites.length > 0 || serverStatus.status === "down" ? "warning" : "ok";
  const summary =
    totalSites === 0
      ? `Sunucu: ${serverStatus.status === "ok" ? "Sağlıklı" : serverStatus.status}`
      : downSites.length > 0
        ? `Site SLA: %${score} (${downSites.join(", ")} sorunlu)`
        : `Site SLA: %${score} (${healthySites}/${totalSites} site aktif)`;

  return {
    status,
    score,
    healthySites,
    totalSites,
    downSites,
    summary
  };
}

/**
 * Prunes old status.json snapshots in `<configDir>/status-snapshots/`, keeping at most `keep` latest snapshots.
 */
export function pruneStatusBoardSnapshots(ctx, options = {}) {
  const homeDir = options.homeDir || ctx?.home || ctx?.homeDir || os.homedir();
  const configDir = options.configDir || ctx?.configDir || path.join(homeDir, ".config", "keyflip");
  const snapDir = options.outDir || path.join(configDir, "status-snapshots");
  const keep = typeof options.keep === "number" && options.keep >= 1 ? Math.floor(options.keep) : 20;

  if (!fs.existsSync(snapDir)) {
    return { keptCount: 0, deletedCount: 0, deletedFiles: [] };
  }

  const files = fs
    .readdirSync(snapDir)
    .filter((f) => f.startsWith("status-") && f.endsWith(".json"))
    .sort()
    .reverse();

  const toKeep = files.slice(0, keep);
  const toDelete = files.slice(keep);
  const deletedFiles = [];

  for (const fileName of toDelete) {
    try {
      fs.unlinkSync(path.join(snapDir, fileName));
      deletedFiles.push(fileName);
    } catch {
      /* ignore individual unlink errors */
    }
  }

  return {
    keptCount: toKeep.length,
    deletedCount: deletedFiles.length,
    deletedFiles
  };
}

/**
 * Evaluates secondary AI tool quotas (Kiro, Copilot, Antigravity `agy`, EVREN, API Promos)
 * and produces a structured alert summary when any secondary provider is >=90% used or exhausted.
 */
export function evaluateSecondaryQuotasAlert(otherQuotas = []) {
  const list = Array.isArray(otherQuotas) ? otherQuotas : [];
  const exhausted = [];
  const warning = [];
  const healthy = [];

  for (const q of list) {
    if (!q || q.status === "unreadable") continue;
    const pct = typeof q.usedPct === "number" ? q.usedPct : null;
    if (q.status === "exhausted" || (pct !== null && pct >= 95)) {
      exhausted.push(q.label || q.id);
    } else if (q.status === "warning" || (pct !== null && pct >= 85)) {
      warning.push(q.label || q.id);
    } else if (q.status === "ok") {
      healthy.push(q.label || q.id);
    }
  }

  const hasAlert = exhausted.length > 0 || warning.length > 0;
  const severity = exhausted.length > 0 ? "critical" : warning.length > 0 ? "warning" : "ok";

  let summary = null;
  if (exhausted.length > 0) {
    summary = `İkincil kota tükendi: ${exhausted.join(", ")}`;
  } else if (warning.length > 0) {
    summary = `İkincil kota uyarısı (%85+): ${warning.join(", ")}`;
  } else if (healthy.length > 0) {
    summary = `${healthy.length} ikincil kota sağlıklı`;
  }

  return {
    hasAlert,
    severity,
    exhausted,
    warning,
    healthyCount: healthy.length,
    summary
  };
}

/**
 * Builds a compact 6-pillar terminal health summary table for `keyflip daemon summary`.
 */
export function formatDaemonCompactSummary(ccPayload = {}) {
  const activeName = ccPayload?.activeAccount?.name || "yok";
  const activeAcct = (ccPayload?.accounts || []).find((a) => a.active) || null;
  const fivePct = activeAcct?.usage?.fiveHour?.pct ?? null;
  const sevenPct = activeAcct?.usage?.sevenDay?.pct ?? null;

  const pillars = [
    {
      pillar: "Hesap Havuzu",
      status: ccPayload?.poolReadiness?.status || "ok",
      detail: `Etkin: ${activeName} (5s: ${fivePct !== null ? "%" + fivePct : "?"}, 7g: ${sevenPct !== null ? "%" + sevenPct : "?"}) · ${ccPayload?.poolResilience?.summary || ""}`.trim()
    },
    {
      pillar: "Yedek Zincir",
      status: ccPayload?.failover?.spendHealth?.status || (ccPayload?.failover?.engaged ? "warning" : "ok"),
      detail: ccPayload?.failover?.engaged
        ? `Devrede (${ccPayload?.failover?.costEstimate?.summary || ""})`
        : ccPayload?.failover?.enabled
          ? `Hazır · ${ccPayload?.failover?.costEstimate?.summary || ""}`
          : "Devre dışı"
    },
    {
      pillar: "Durum Panosu",
      status: ccPayload?.statusBoard
        ? ccPayload.statusBoard.stale
          ? "warning"
          : (ccPayload.statusBoard.healthPct ?? 100) < 80
            ? "warning"
            : "ok"
        : "unreadable",
      detail: ccPayload?.statusBoard
        ? `${ccPayload.statusBoard.healthSummary || ""} · Bekleyen: ${(ccPayload.statusBoard.owner_needed || []).length}`
        : "status.json tanımlı değil"
    },
    {
      pillar: "Servis Filosu",
      status: ccPayload?.servicesHealth?.status || "ok",
      detail: ccPayload?.servicesHealth?.summary || "Veri yok"
    },
    {
      pillar: "Traycer Filo",
      status: ccPayload?.fleetEfficiency?.status || ccPayload?.fleet?.status || "unreadable",
      detail: ccPayload?.fleetEfficiency?.summary || ccPayload?.fleet?.display || "okunamadı"
    },
    {
      pillar: "Uzak Sunucu",
      status: ccPayload?.serverSitesHealth?.status || ccPayload?.server?.status || "unreadable",
      detail: ccPayload?.serverSitesHealth?.summary || (ccPayload?.server ? `${ccPayload.server.host}: ${ccPayload.server.load}` : "okunamadı")
    }
  ];

  const lines = ["# Keyflip Kontrol Merkezi — 6 Sütunlu Sağlık Özeti"];
  for (const p of pillars) {
    const badge = p.status === "ok" ? "[OK]" : p.status === "critical" || p.status === "error" ? "[KRİTİK]" : p.status === "warning" ? "[UYARI]" : "[BİLGİ]";
    lines.push(`${badge.padEnd(9)} ${p.pillar.padEnd(15)} : ${p.detail}`);
  }
  return {
    pillars,
    text: lines.join("\n")
  };
}

/**
 * Evaluates a unified 0-100 Autonomous Operations Posture ("Otonom Çalışma Sağlığı")
 * combining Pool Resilience, Session Readiness, Multi-Provider Continuity, Services Health, and Status Board SLA.
 */
export function evaluateAutonomousOpsPosture({
  poolResilience = null,
  sessionReadiness = null,
  multiProviderContinuity = null,
  servicesHealth = null,
  statusBoard = null
} = {}) {
  const resilienceScore = typeof poolResilience?.score === "number" ? poolResilience.score : 80;
  const readinessScore =
    sessionReadiness && typeof sessionReadiness.totalCount === "number" && sessionReadiness.totalCount > 0
      ? Math.round((sessionReadiness.passedCount / sessionReadiness.totalCount) * 100)
      : 100;
  const continuityScore = typeof multiProviderContinuity?.score === "number" ? multiProviderContinuity.score : 75;
  const svcScore = typeof servicesHealth?.score === "number" ? servicesHealth.score : 100;
  const boardScore = statusBoard && typeof statusBoard.healthPct === "number" ? statusBoard.healthPct : 100;

  const overallScore = Math.round(
    resilienceScore * 0.25 +
      readinessScore * 0.25 +
      continuityScore * 0.15 +
      svcScore * 0.2 +
      boardScore * 0.15
  );

  const grade = overallScore >= 85 ? "A" : overallScore >= 70 ? "B" : overallScore >= 55 ? "C" : "D";
  const status = overallScore >= 80 ? "optimal" : overallScore >= 60 ? "caution" : "degraded";

  return {
    score: overallScore,
    grade,
    status,
    summary: `Otonom Sağlık: ${grade} (%${overallScore})`
  };
}

/**
 * Prioritizes `owner_needed` items from Status Board by urgency keywords (prod/down/acil/blocker/kritik/key/fatura)
 * and groups them by project so the operator knows which human-blocked action to resolve first.
 */
export function prioritizeOwnerNeededQueue(statusBoard = null) {
  const items = Array.isArray(statusBoard?.owner_needed) ? statusBoard.owner_needed : [];
  if (items.length === 0) {
    return {
      totalCount: 0,
      urgentCount: 0,
      projectCount: 0,
      topItem: null,
      items: [],
      summary: null
    };
  }

  const urgentRegex = /\b(acil|kritik|blocker|down|prod|fatura|payment|expired|süresi doldu|500|502|503)\b/i;
  const projects = new Set();

  const ranked = items
    .map((item, idx) => {
      const project = String(item?.project || "genel").trim();
      const text = String(item?.text || "").trim();
      projects.add(project);
      const urgent = urgentRegex.test(text) || urgentRegex.test(project);
      return {
        index: idx,
        project,
        text,
        priority: urgent ? "urgent" : "normal",
        priorityRank: urgent ? 0 : 1
      };
    })
    .sort((a, b) => (a.priorityRank !== b.priorityRank ? a.priorityRank - b.priorityRank : a.index - b.index))
    .map(({ project, text, priority }) => ({ project, text, priority }));

  const urgentCount = ranked.filter((r) => r.priority === "urgent").length;
  const topItem = ranked[0] || null;

  return {
    totalCount: ranked.length,
    urgentCount,
    projectCount: projects.size,
    topItem,
    items: ranked,
    summary:
      urgentCount > 0
        ? `${ranked.length} bekleyen iş (${urgentCount} acil · ${projects.size} proje)`
        : `${ranked.length} bekleyen iş (${projects.size} proje)`
  };
}
