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

/**
 * Evaluates OAuth token refresh reliability across enabled accounts by inspecting token status,
 * refreshable flags, remainingMs, and lastResult ("failed" / "persist-failed" / "dead").
 */
export function evaluateOAuthRefreshReliability(accounts = []) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  if (enabled.length === 0) {
    return {
      score: 100,
      status: "ok",
      healthyCount: 0,
      failedAccounts: [],
      expiringSoonAccounts: [],
      summary: "Etkin hesap yok"
    };
  }

  let scoreSum = 0;
  const failedAccounts = [];
  const expiringSoonAccounts = [];

  for (const a of enabled) {
    const tok = a?.token || {};
    const remMs = typeof tok.remainingMs === "number" ? tok.remainingMs : null;
    if (
      tok.status === "expired" ||
      tok.lastResult === "failed" ||
      tok.lastResult === "persist-failed" ||
      tok.lastResult === "dead"
    ) {
      failedAccounts.push(a.name);
      scoreSum += 0;
    } else if (remMs !== null && remMs <= 45 * 60 * 1000) {
      expiringSoonAccounts.push(a.name);
      scoreSum += 65;
    } else if (tok.status === "valid") {
      scoreSum += 100;
    } else {
      scoreSum += 50;
    }
  }

  const score = Math.round(scoreSum / enabled.length);
  const status = failedAccounts.length > 0 ? "critical" : expiringSoonAccounts.length > 0 ? "warning" : "ok";
  const healthyCount = enabled.length - failedAccounts.length - expiringSoonAccounts.length;

  let summary = `OAuth güvenilirliği: %${score} (${healthyCount}/${enabled.length} sağlıklı)`;
  if (failedAccounts.length > 0) {
    summary = `OAuth hatası: ${failedAccounts.join(", ")} · %${score} güvenilirlik`;
  } else if (expiringSoonAccounts.length > 0) {
    summary = `OAuth yakında doluyor: ${expiringSoonAccounts.join(", ")} (%${score})`;
  }

  return {
    score,
    status,
    healthyCount,
    failedAccounts,
    expiringSoonAccounts,
    summary
  };
}

/**
 * Recommends an adaptive autoswitch threshold (%) based on active burn-rate velocity,
 * pool size, and whether the current UTC hour falls inside the historical bottleneck window.
 */
export function recommendAdaptiveAutoswitchThreshold({
  currentThreshold = 95,
  accounts = [],
  quotaForecast = null,
  bottleneckWindow = null,
  nowMs = Date.now()
} = {}) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  const currentUtcHour = new Date(typeof nowMs === "function" ? nowMs() : nowMs).getUTCHours();
  const inBottleneckHour =
    bottleneckWindow && typeof bottleneckWindow.peakHourUtc === "number" && bottleneckWindow.peakHourUtc === currentUtcHour;

  const activeForecast = (quotaForecast?.accounts || []).find((a) => a.active) || null;
  const highBurn = activeForecast && typeof activeForecast.burnRateRatio === "number" && activeForecast.burnRateRatio >= 1.4;

  let recommendedThreshold = currentThreshold;
  let reason = "Mevcut eşik dengeli";

  if (enabled.length >= 2 && (highBurn || inBottleneckHour)) {
    recommendedThreshold = 85;
    reason = highBurn
      ? "Yüksek tüketim hızı nedeniyle erken rotasyon (%85) önerilir"
      : "Darboğaz saat diliminde erken rotasyon (%85) önerilir";
  } else if (enabled.length >= 2 && currentThreshold > 90) {
    recommendedThreshold = 90;
    reason = "Çoklu hesap havuzunda %90 eşiği daha yumuşak geçiş sağlar";
  } else if (enabled.length === 1) {
    recommendedThreshold = 95;
    reason = "Tek hesapta son kapasiteye kadar (%95) kullanım önerilir";
  }

  return {
    currentThreshold,
    recommendedThreshold,
    inBottleneckHour: Boolean(inBottleneckHour),
    highBurn: Boolean(highBurn),
    needsAdjustment: recommendedThreshold !== currentThreshold,
    reason,
    summary:
      recommendedThreshold !== currentThreshold
        ? `Önerilen eşik: %${recommendedThreshold} (mevcut %${currentThreshold})`
        : `Eşik optimal (%${currentThreshold})`
  };
}

/**
 * Computes per-section SLA health breakdown and oldest active issue age for the Status Board.
 */
export function summarizeSectionHealthBreakdown(statusBoard = null, nowMs = Date.now()) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  const breakdown = sections.map((sec) => {
    const rows = Array.isArray(sec?.rows) ? sec.rows : [];
    const h = computeStatusBoardHealth([sec]);
    let oldestIssueMinutes = null;
    for (const r of rows) {
      if (r?.status === "bad" || r?.status === "warn") {
        const ts = r?.since ? Date.parse(String(r.since)) : Number.NaN;
        if (Number.isFinite(ts) && ts <= nowMs) {
          const mins = Math.max(1, Math.round((nowMs - ts) / 60000));
          if (oldestIssueMinutes === null || mins > oldestIssueMinutes) {
            oldestIssueMinutes = mins;
          }
        }
      }
    }
    return {
      id: sec.id,
      title: sec.title,
      healthPct: h.healthPct,
      badCount: h.badRows,
      warnCount: h.warnRows,
      totalRows: h.totalRows,
      oldestIssueMinutes
    };
  });

  const weakestSection =
    breakdown.length > 0
      ? [...breakdown].sort((a, b) => a.healthPct - b.healthPct || b.badCount - a.badCount)[0]
      : null;

  return {
    sections: breakdown,
    weakestSectionId: weakestSection ? weakestSection.id : null,
    weakestSectionHealthPct: weakestSection ? weakestSection.healthPct : 100,
    summary:
      weakestSection && weakestSection.healthPct < 100
        ? `En düşük bölüm: ${weakestSection.title} (%${weakestSection.healthPct})`
        : "Tüm bölümler %100 sağlıklı"
  };
}

/**
 * Computes a prioritized 1-to-3 step Incident Triage & Remediation Playbook ("Eylem Planı")
 * whenever any degraded condition is detected across accounts, OAuth tokens, failover, services, or status board.
 */
export function buildRemediationPlaybook({
  accounts = [],
  failover = {},
  services = [],
  statusBoard = null
} = {}) {
  const steps = [];

  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (a?.enabled !== false && (a?.token?.status === "expired" || a?.token?.lastResult === "failed")) {
      steps.push({
        priority: 1,
        target: a.name,
        title: `${a.name} OAuth belirtecini yenile`,
        command: `keyflip refresh ${a.name}`
      });
    }
  }

  if (failover?.cap?.exceeded || failover?.spendHealth?.status === "critical") {
    steps.push({
      priority: 1,
      target: "failover",
      title: "Failover harcama tavanını kontrol et veya yedek zinciri kapat",
      command: "keyflip failover status"
    });
  }

  for (const s of Array.isArray(services) ? services : []) {
    if (s?.state === "error" && s?.restartable) {
      steps.push({
        priority: 2,
        target: s.label,
        title: `${s.title} servisini yeniden başlat`,
        command: `launchctl kickstart -k gui/$UID/${s.label}`
      });
    }
  }

  if (statusBoard && Array.isArray(statusBoard.sections)) {
    for (const sec of statusBoard.sections) {
      for (const r of sec?.rows || []) {
        if (r?.status === "bad") {
          steps.push({
            priority: 2,
            target: `${sec.id}::${r.label}`,
            title: `Durum panosu kritik satırı incele: ${r.label} (${r.value})`,
            command: "keyflip status-board validate"
          });
        }
      }
    }
  }

  steps.sort((a, b) => a.priority - b.priority);
  const topSteps = steps.slice(0, 3);

  return {
    hasActions: topSteps.length > 0,
    actionCount: steps.length,
    topSteps,
    summary:
      topSteps.length > 0
        ? `Önerilen eylem (${steps.length}): ${topSteps[0].title}`
        : "Müdahale gerektiren açık sorun yok"
  };
}

/**
 * Evaluates Cross-Account Load Balance & Fairness Index (0-100) across enabled Claude accounts
 * to detect lopsided 7-day quota consumption (e.g. one account at 95% while another sits at 10%).
 */
export function evaluatePoolLoadBalance(accounts = []) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  if (enabled.length < 2) {
    return {
      balanced: true,
      spreadPct: 0,
      score: 100,
      underutilizedAccount: null,
      overloadedAccount: null,
      summary: "Tek etkin hesap (yük dengeleme uygulanamaz)"
    };
  }

  const withPct = enabled.map((a) => {
    const seven =
      typeof a?.usage?.sevenDay?.pct === "number"
        ? a.usage.sevenDay.pct
        : typeof a?.sevenDayPct === "number"
          ? a.sevenDayPct
          : 0;
    return { name: a.name, sevenPct: seven };
  });

  withPct.sort((a, b) => a.sevenPct - b.sevenPct);
  const minAcct = withPct[0];
  const maxAcct = withPct[withPct.length - 1];
  const spreadPct = Math.round((maxAcct.sevenPct - minAcct.sevenPct) * 10) / 10;
  const score = Math.max(0, Math.min(100, Math.round(100 - spreadPct)));
  const balanced = spreadPct <= 35;

  return {
    balanced,
    spreadPct,
    score,
    underutilizedAccount: !balanced ? minAcct.name : null,
    overloadedAccount: !balanced ? maxAcct.name : null,
    summary: balanced
      ? `Havuz yük dengesi: %${score} (fark %${spreadPct})`
      : `Dengesiz yük (%${spreadPct} fark): ${minAcct.name} (%${minAcct.sevenPct}) hesabına geçiş önerilir`
  };
}


/**
 * Lists all degraded (`bad` / `warn`) rows across status board sections sorted chronologically
 * from oldest to newest by `since` timestamp to highlight chronic issues.
 */
export function listAgingStatusBoardIssues(statusBoard, options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const chronicThresholdMin = typeof options.chronicThresholdMin === "number" ? options.chronicThresholdMin : 120;
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];

  const items = [];
  for (const sec of sections) {
    const secId = sec?.id || "section";
    const secTitle = sec?.title || secId;
    for (const r of sec?.rows || []) {
      if (r?.status !== "bad" && r?.status !== "warn") continue;
      const sinceMs = r?.since ? Date.parse(String(r.since)) : Number.NaN;
      const ageMinutes =
        Number.isFinite(sinceMs) && nowMs >= sinceMs ? Math.max(1, Math.round((nowMs - sinceMs) / 60000)) : null;
      items.push({
        sectionId: secId,
        sectionTitle: secTitle,
        label: String(r?.label ?? ""),
        value: String(r?.value ?? ""),
        status: r.status,
        since: r?.since != null ? String(r.since) : null,
        ageMinutes,
        sinceAge: r?.sinceAge || formatSinceAge(r?.since, nowMs),
        isChronic: ageMinutes !== null && ageMinutes >= chronicThresholdMin
      });
    }
  }

  items.sort((a, b) => {
    if (a.ageMinutes !== null && b.ageMinutes !== null && b.ageMinutes !== a.ageMinutes) {
      return b.ageMinutes - a.ageMinutes;
    }
    if (a.ageMinutes !== null && b.ageMinutes === null) return -1;
    if (a.ageMinutes === null && b.ageMinutes !== null) return 1;
    const rankA = a.status === "bad" ? 0 : 1;
    const rankB = b.status === "bad" ? 0 : 1;
    return rankA - rankB;
  });

  const chronicCount = items.filter((i) => i.isChronic).length;
  const oldest = items.find((i) => i.ageMinutes !== null) || null;
  const oldestIssueMinutes = oldest ? oldest.ageMinutes : null;

  let summary = "Açık sorun yok";
  if (items.length > 0) {
    if (chronicCount > 0 && oldest) {
      summary = `Kronik sorun: ${chronicCount} adet (en eski ${oldest.sinceAge || oldest.ageMinutes + " dk"} — ${oldest.label})`;
    } else if (oldest) {
      summary = `Açık sorun: ${items.length} adet (en eski ${oldest.sinceAge || oldest.ageMinutes + " dk"} — ${oldest.label})`;
    } else {
      summary = `Açık sorun: ${items.length} adet`;
    }
  }

  return {
    totalIssues: items.length,
    chronicCount,
    oldestIssueMinutes,
    items,
    summary
  };
}

/**
 * Computes the remaining countdown in minutes until failover automatically recovers
 * or the earliest enabled Claude account resets its 5-hour quota window.
 */
export function evaluateFailoverRecoveryCountdown(failoverInfo = {}, accounts = [], options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();

  if (!failoverInfo?.engaged) {
    return {
      engaged: false,
      remainingMinutes: null,
      recoverTarget: null,
      summary: "Failover beklemede"
    };
  }

  const candidates = [];

  if (failoverInfo.recoverAt) {
    const recMs =
      typeof failoverInfo.recoverAt === "number"
        ? failoverInfo.recoverAt
        : Date.parse(String(failoverInfo.recoverAt));
    if (Number.isFinite(recMs) && recMs > nowMs) {
      candidates.push({
        target: failoverInfo.fromAccount || "recoverAt",
        ms: recMs
      });
    }
  }

  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  for (const acct of enabled) {
    const rawReset = acct?.usage?.fiveHour?.resetsAt || acct?.fiveHourResetsAt || null;
    if (!rawReset) continue;
    const rMs = Date.parse(String(rawReset));
    if (Number.isFinite(rMs) && rMs > nowMs) {
      candidates.push({
        target: acct.name,
        ms: rMs
      });
    }
  }

  if (candidates.length === 0) {
    return {
      engaged: true,
      remainingMinutes: null,
      recoverTarget: null,
      summary: "Failover devrede (otomatik dönüş zamanı belirsiz)"
    };
  }

  candidates.sort((a, b) => a.ms - b.ms);
  const earliest = candidates[0];
  const remainingMinutes = Math.max(1, Math.round((earliest.ms - nowMs) / 60000));

  return {
    engaged: true,
    remainingMinutes,
    recoverTarget: earliest.target,
    summary: `Havuz dönüşüne ~${remainingMinutes} dk kaldı (${earliest.target} sıfırlanması)`
  };
}

/**
 * Summarizes 24-hour audit event counts (switches, failover toggles, service restarts, config updates)
 * from events.jsonl.
 */
export function summarizeDailyAuditActivity(ctx, options = {}) {
  const nowMs =
    typeof options.nowMs === "function"
      ? options.nowMs()
      : typeof options.nowMs === "number"
        ? options.nowMs
        : typeof ctx?.nowMs === "function"
          ? ctx.nowMs()
          : Date.now();
  const windowHours = typeof options.windowHours === "number" && options.windowHours > 0 ? options.windowHours : 24;
  const cutoffMs = nowMs - windowHours * 3600000;

  let rawEvents = Array.isArray(options.events) ? options.events : null;
  if (!rawEvents) {
    const configDir = options.configDir || ctx?.configDir || path.join(os.homedir(), ".config", "keyflip");
    const eventsPath = options.eventsPath || path.join(configDir, "events.jsonl");
    const lines = readTailLines(eventsPath, 65536);
    rawEvents = [];
    for (const line of lines) {
      try {
        rawEvents.push(JSON.parse(line));
      } catch {
        /* ignore malformed line */
      }
    }
  }

  let switchCount = 0;
  let failoverCount = 0;
  let serviceRestartCount = 0;
  let configChangeCount = 0;

  for (const ev of rawEvents) {
    if (!ev || typeof ev !== "object") continue;
    const tsMs = ev.ts ? Date.parse(String(ev.ts)) : typeof ev.at === "number" ? ev.at : Number.NaN;
    if (Number.isFinite(tsMs) && tsMs < cutoffMs) continue;
    const kind = String(ev.kind || "").toLowerCase();
    if (kind.includes("switch")) {
      switchCount += 1;
    } else if (kind.includes("failover")) {
      failoverCount += 1;
    } else if (kind === "service-restart") {
      serviceRestartCount += 1;
    } else if (kind === "daemon-config") {
      configChangeCount += 1;
    }
  }

  const totalEvents24h = switchCount + failoverCount + serviceRestartCount + configChangeCount;
  const parts = [];
  if (switchCount > 0) parts.push(`${switchCount} geçiş`);
  if (failoverCount > 0) parts.push(`${failoverCount} failover`);
  if (serviceRestartCount > 0) parts.push(`${serviceRestartCount} servis`);
  if (configChangeCount > 0) parts.push(`${configChangeCount} ayar`);

  return {
    windowHours,
    totalEvents24h,
    switchCount,
    failoverCount,
    serviceRestartCount,
    configChangeCount,
    summary:
      parts.length > 0
        ? `Son ${windowHours}s aktivite: ${parts.join(" · ")}`
        : `Son ${windowHours} saatte denetim olayı yok`
  };
}

/**
 * Evaluates the health, timeliness, and execution latency of the daemon internal job scheduler.
 */
export function evaluateDaemonSchedulerHealth(jobs = {}, options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const entries = Object.entries(jobs && typeof jobs === "object" ? jobs : {});

  if (entries.length === 0) {
    return {
      score: 100,
      status: "healthy",
      totalJobs: 0,
      healthyJobs: 0,
      failingJobs: [],
      overdueJobs: [],
      slowJobs: [],
      summary: "Zamanlayıcı verisi yok"
    };
  }

  const failingJobs = [];
  const overdueJobs = [];
  const slowJobs = [];
  let healthyJobs = 0;

  for (const [name, meta] of entries) {
    if (!meta || typeof meta !== "object") continue;
    let isHealthy = true;

    if (meta.lastResult === "error" || meta.lastResult === "partial-error" || meta.lastError) {
      failingJobs.push(name);
      isHealthy = false;
    }

    const ivSec = typeof meta.intervalSeconds === "number" ? meta.intervalSeconds : 0;
    if (ivSec > 0 && meta.lastRunAt && name !== "usage") {
      const lastMs = Date.parse(String(meta.lastRunAt));
      if (Number.isFinite(lastMs) && nowMs - lastMs > ivSec * 2.5 * 1000) {
        overdueJobs.push(name);
        isHealthy = false;
      }
    }

    if (typeof meta.lastDurationMs === "number" && meta.lastDurationMs > 15000) {
      slowJobs.push(name);
    }

    if (isHealthy) {
      healthyJobs += 1;
    }
  }

  const totalJobs = entries.length;
  let score = totalJobs > 0 ? Math.round((healthyJobs / totalJobs) * 100) : 100;
  if (slowJobs.length > 0) {
    score = Math.max(0, score - slowJobs.length * 5);
  }
  const status = failingJobs.length > 0 ? "critical" : overdueJobs.length > 0 || slowJobs.length > 0 ? "degraded" : "healthy";

  const issues = [];
  if (failingJobs.length > 0) issues.push(`${failingJobs.join(", ")} hatalı`);
  if (overdueJobs.length > 0) issues.push(`${overdueJobs.join(", ")} gecikti`);
  if (slowJobs.length > 0) issues.push(`${slowJobs.join(", ")} yavaş`);

  const summary =
    issues.length > 0
      ? `Zamanlayıcı uyarısı: ${issues.join(" · ")}`
      : `Zamanlayıcı sağlıklı (${healthyJobs}/${totalJobs} iş zamanında)`;

  return {
    score,
    status,
    totalJobs,
    healthyJobs,
    failingJobs,
    overdueJobs,
    slowJobs,
    summary
  };
}

/**
 * Detects enabled Claude accounts whose 7-day quota window resets within 48 hours
 * while still having substantial unused weekly quota ("Use-Before-Weekly-Reset" Advisor).
 */
export function evaluateWeeklyUnclaimedQuota(accounts = [], options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const windowHours = typeof options.windowHours === "number" && options.windowHours > 0 ? options.windowHours : 48;
  const maxUsedPct = typeof options.maxUsedPct === "number" ? options.maxUsedPct : 65;

  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  const candidates = [];

  for (const acct of enabled) {
    const seven = acct?.usage?.sevenDay;
    if (!seven || typeof seven.pct !== "number" || !seven.resetsAt) continue;
    const resetMs = Date.parse(String(seven.resetsAt));
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) continue;
    const hoursUntilReset = Math.round(((resetMs - nowMs) / 3600000) * 10) / 10;
    if (hoursUntilReset <= windowHours && seven.pct <= maxUsedPct) {
      const unclaimedPct = Math.round((100 - seven.pct) * 10) / 10;
      const estimatedUnclaimedUsd = Math.round((unclaimedPct / 100) * 15 * 100) / 100;
      candidates.push({
        name: acct.name,
        usedPct: seven.pct,
        unclaimedPct,
        hoursUntilReset,
        estimatedUnclaimedUsd
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.hoursUntilReset !== b.hoursUntilReset) return a.hoursUntilReset - b.hoursUntilReset;
    return b.unclaimedPct - a.unclaimedPct;
  });

  const totalUnclaimedPct = Math.round(candidates.reduce((acc, c) => acc + c.unclaimedPct, 0) * 10) / 10;
  const estimatedUnclaimedUsd = Math.round(candidates.reduce((acc, c) => acc + c.estimatedUnclaimedUsd, 0) * 100) / 100;
  const top = candidates[0] || null;

  return {
    hasUnclaimed: candidates.length > 0,
    candidateCount: candidates.length,
    priorityAccount: top ? top.name : null,
    totalUnclaimedPct,
    estimatedUnclaimedUsd,
    candidates,
    summary: top
      ? `Haftalık sıfırlanmadan kullan: ${top.name} (%${top.unclaimedPct} boş, ~${Math.round(top.hoursUntilReset)} saat kaldı)`
      : "Sıfırlanma öncesi atıl haftalık kota yok"
  };
}


/**
 * Groups `owner_needed` items from the Status Board by project name, counting total and urgent items per project.
 */
export function groupOwnerNeededByProject(statusBoard) {
  const raw = Array.isArray(statusBoard?.owner_needed) ? statusBoard.owner_needed : [];
  if (raw.length === 0) {
    return {
      projectCount: 0,
      totalItems: 0,
      topProject: null,
      groups: [],
      summary: "Proje bazlı bekleyen iş yok"
    };
  }

  const urgentRe = /\b(acil|urgent|kritik|blocker|prod|down|çöktü|kırık|deploy|onay|expired|tükendi)\b/i;
  const map = new Map();

  for (const item of raw) {
    if (!item || (!item.project && !item.text)) continue;
    const project = String(item.project || "genel").trim() || "genel";
    const text = String(item.text || "").trim();
    const isUrgent = urgentRe.test(`${project} ${text}`);
    const existing = map.get(project) || { project, count: 0, urgentCount: 0, items: [] };
    existing.count += 1;
    if (isUrgent) existing.urgentCount += 1;
    existing.items.push({ text, isUrgent });
    map.set(project, existing);
  }

  const groups = Array.from(map.values()).sort((a, b) => {
    if (b.urgentCount !== a.urgentCount) return b.urgentCount - a.urgentCount;
    if (b.count !== a.count) return b.count - a.count;
    return a.project.localeCompare(b.project);
  });

  const totalItems = groups.reduce((acc, g) => acc + g.count, 0);
  const top = groups[0] || null;

  return {
    projectCount: groups.length,
    totalItems,
    topProject: top ? top.project : null,
    groups,
    summary: top
      ? `${groups.length} projede ${totalItems} iş (en yoğun: ${top.project} [${top.count}])`
      : "Proje bazlı bekleyen iş yok"
  };
}

/**
 * Parses numeric CPU load, RAM percentage, and Disk percentage from the read-only server status snapshot
 * to surface early resource pressure alerts.
 */
export function evaluateServerResourcePressure(server = {}) {
  if (!server || server.status === "unreadable") {
    return {
      status: "unreadable",
      score: 0,
      loadAvg1m: null,
      memoryPct: null,
      diskPct: null,
      pressures: [],
      summary: "Sunucu kaynak verisi okunamadı"
    };
  }

  const parsePct = (str) => {
    if (typeof str !== "string") return null;
    const pctMatch = str.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pctMatch) return Number.parseFloat(pctMatch[1]);
    const ratioMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:GB|GiB|MB|MiB)?\s*\/\s*(\d+(?:\.\d+)?)/i);
    if (ratioMatch) {
      const used = Number.parseFloat(ratioMatch[1]);
      const total = Number.parseFloat(ratioMatch[2]);
      if (total > 0) return Math.round((used / total) * 1000) / 10;
    }
    return null;
  };

  let loadAvg1m = null;
  if (typeof server.load === "string") {
    const m = server.load.match(/(\d+(?:\.\d+)?)/);
    if (m) loadAvg1m = Number.parseFloat(m[1]);
  }

  const memoryPct = parsePct(server.memory);
  const diskPct = parsePct(server.disk);

  const pressures = [];
  let status = "ok";
  let score = 100;

  if (diskPct !== null) {
    if (diskPct >= 90) {
      status = "critical";
      score -= 45;
      pressures.push(`Disk kritik (%${diskPct})`);
    } else if (diskPct >= 80) {
      if (status === "ok") status = "warning";
      score -= 20;
      pressures.push(`Disk yüksek (%${diskPct})`);
    }
  }

  if (memoryPct !== null) {
    if (memoryPct >= 90) {
      status = "critical";
      score -= 35;
      pressures.push(`RAM kritik (%${memoryPct})`);
    } else if (memoryPct >= 80) {
      if (status === "ok") status = "warning";
      score -= 15;
      pressures.push(`RAM yüksek (%${memoryPct})`);
    }
  }

  if (loadAvg1m !== null) {
    if (loadAvg1m >= 4.0) {
      status = "critical";
      score -= 30;
      pressures.push(`Yük kritik (${loadAvg1m})`);
    } else if (loadAvg1m >= 2.0) {
      if (status === "ok") status = "warning";
      score -= 15;
      pressures.push(`Yük yüksek (${loadAvg1m})`);
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    status,
    score,
    loadAvg1m,
    memoryPct,
    diskPct,
    pressures,
    summary:
      pressures.length > 0
        ? `Kaynak baskısı: ${pressures.join(" · ")}`
        : `Kaynaklar dengeli (% ${score} sağlık)`
  };
}

/**
 * Evaluates pending Claude Desktop restart state and Focus/Snooze window remaining minutes.
 */
export function evaluateDesktopRestartSafety(desktopRestart = {}, config = {}, options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const autoRestart = Boolean(config?.["desktop.autoRestart"]);
  const snoozeRaw = config?.["desktop.snoozeUntil"] || "";
  const snoozeMs = snoozeRaw ? Date.parse(String(snoozeRaw)) : Number.NaN;
  const snoozed = Number.isFinite(snoozeMs) && snoozeMs > nowMs;
  const snoozeRemainingMin = snoozed ? Math.max(1, Math.round((snoozeMs - nowMs) / 60000)) : 0;

  const pending = Boolean(desktopRestart?.pending);
  const actionCount = Array.isArray(desktopRestart?.actions) ? desktopRestart.actions.length : 0;

  let status = "idle";
  let summary = "Bekleyen masaüstü yeniden başlatması yok";

  if (pending && snoozed) {
    status = "snoozed";
    summary = `Yeniden başlatma ertelendi (Odak modu: ${snoozeRemainingMin} dk kaldı)`;
  } else if (pending) {
    status = "pending-idle";
    summary = `Masaüstü yeniden başlatma sırada (${actionCount || 1} eylem boşta kalmayı bekliyor)`;
  } else if (snoozed) {
    status = "snoozed";
    summary = `Odak modu aktif (${snoozeRemainingMin} dk boyunca yeniden başlatma kapalı)`;
  } else if (!autoRestart) {
    status = "disabled";
    summary = "Otomatik masaüstü yeniden başlatma kapalı";
  }

  return {
    pending,
    autoRestart,
    snoozed,
    snoozeRemainingMin,
    actionCount,
    status,
    summary
  };
}

/**
 * Evaluates Claude Sonnet 7-day sub-quota divergence vs overall 7-day quota across enabled accounts
 * ("Sonnet Bottleneck & Model Split Advisor").
 */
export function evaluateSonnetModelSplitHealth(accounts = []) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  const constrainedAccounts = [];
  let maxDivergencePct = 0;

  for (const acct of enabled) {
    const sevenPct =
      typeof acct?.usage?.sevenDay?.pct === "number" ? acct.usage.sevenDay.pct : null;
    const sonnetPct =
      typeof acct?.usage?.sevenDaySonnet?.pct === "number" ? acct.usage.sevenDaySonnet.pct : null;
    if (sonnetPct === null) continue;
    const div = sevenPct !== null ? Math.round((sonnetPct - sevenPct) * 10) / 10 : 0;
    if (div > maxDivergencePct) maxDivergencePct = div;
    if (sonnetPct >= 80 || div >= 20) {
      constrainedAccounts.push({
        name: acct.name,
        sonnetPct,
        sevenDayPct: sevenPct,
        divergencePct: div
      });
    }
  }

  constrainedAccounts.sort((a, b) => b.sonnetPct - a.sonnetPct);
  const top = constrainedAccounts[0] || null;
  const hasBottleneck = constrainedAccounts.length > 0;

  return {
    hasBottleneck,
    constrainedCount: constrainedAccounts.length,
    maxDivergencePct,
    topConstrainedAccount: top ? top.name : null,
    constrainedAccounts,
    summary: top
      ? `Sonnet alt-kota darboğazı: ${top.name} (Sonnet %${top.sonnetPct}${top.sevenDayPct !== null ? `, genel %${top.sevenDayPct}` : ""})`
      : "Sonnet 7g alt-kotaları dengeli"
  };
}

/**
 * Evaluates Local Service Log Hygiene & Error Density across monitored launchd services.
 */
export function evaluateServiceLogHygiene(services = []) {
  const list = Array.isArray(services) ? services : [];
  if (list.length === 0) {
    return {
      score: 100,
      status: "clean",
      noisyServiceCount: 0,
      noisyServices: [],
      summary: "Log kirliliği yok"
    };
  }

  const noisyServices = [];
  for (const svc of list) {
    if (!svc || typeof svc !== "object") continue;
    const spark = typeof svc.sparkline === "string" ? svc.sparkline : "";
    const errBars = (spark.match(/▁/g) || []).length;
    const hasRecentError = Boolean(svc.lastError);
    if (errBars >= 2 || (hasRecentError && svc.state !== "running" && svc.state !== "scheduled")) {
      noisyServices.push({
        id: svc.id || svc.label || "service",
        title: svc.title || svc.label || "Servis",
        errorBars: errBars,
        lastError: svc.lastError || null
      });
    }
  }

  const noisyServiceCount = noisyServices.length;
  const score = Math.max(0, Math.min(100, Math.round(((list.length - noisyServiceCount) / list.length) * 100)));
  const status = noisyServiceCount >= 2 ? "degraded" : noisyServiceCount === 1 ? "warning" : "clean";

  return {
    score,
    status,
    noisyServiceCount,
    noisyServices,
    summary:
      noisyServiceCount > 0
        ? `Log uyarısı (${noisyServiceCount} servis): ${noisyServices.map((s) => s.title).join(", ")}`
        : `Servis logları temiz (%${score})`
  };
}


/**
 * Summarizes Status Board health breakdown by host tag (`[host]`) when `menubar.extraStatusFiles`
 * aggregates multiple machines into the Status Board.
 */
export function summarizeMultiHostStatusBreakdown(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  if (sections.length === 0) {
    return {
      hostCount: 0,
      unhealthyHostCount: 0,
      hosts: [],
      summary: "Çoklu makine verisi yok"
    };
  }

  const hostMap = new Map();
  const hostRe = /^\[([^\]]+)\]\s*(.*)$/;

  for (const sec of sections) {
    for (const r of sec?.rows || []) {
      const rawLabel = String(r?.label ?? "");
      const m = rawLabel.match(hostRe);
      const host = m ? m[1].trim() : "local";
      const entry = hostMap.get(host) || { host, totalRows: 0, okRows: 0, warnRows: 0, badRows: 0 };
      entry.totalRows += 1;
      if (r?.status === "ok") entry.okRows += 1;
      else if (r?.status === "warn") entry.warnRows += 1;
      else if (r?.status === "bad") entry.badRows += 1;
      hostMap.set(host, entry);
    }
  }

  const hosts = Array.from(hostMap.values())
    .map((h) => {
      const weighted = h.okRows * 1.0 + h.warnRows * 0.5;
      const healthPct = h.totalRows > 0 ? Math.round((weighted / h.totalRows) * 100) : 100;
      const status = h.badRows > 0 ? "bad" : h.warnRows > 0 ? "warn" : "ok";
      return { ...h, healthPct, status };
    })
    .sort((a, b) => a.healthPct - b.healthPct);

  const unhealthyHostCount = hosts.filter((h) => h.status !== "ok").length;

  return {
    hostCount: hosts.length,
    unhealthyHostCount,
    hosts,
    summary:
      unhealthyHostCount > 0
        ? `${hosts.length} makineden ${unhealthyHostCount} tanesinde sorun var (en düşük: ${hosts[0].host} %${hosts[0].healthPct})`
        : `Tüm makineler sağlıklı (${hosts.length} host)`
  };
}

/**
 * Evaluates the Usage Endpoint Retry-After quiet window (`usageThrottle`) and computes remaining cooldown minutes.
 */
export function evaluateUsageThrottleRecovery(usageThrottle = {}, options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const throttled = Boolean(usageThrottle?.throttled);
  const strike = typeof usageThrottle?.strike === "number" ? usageThrottle.strike : 0;

  if (!throttled) {
    return {
      throttled: false,
      remainingMinutes: 0,
      remainingSeconds: 0,
      strike: 0,
      severity: "ok",
      summary: "Kullanım uç noktası açık (hız sınırı yok)"
    };
  }

  const retryMs = usageThrottle?.retryAt ? Date.parse(String(usageThrottle.retryAt)) : Number.NaN;
  const diffMs = Number.isFinite(retryMs) && retryMs > nowMs ? retryMs - nowMs : 0;
  const remainingSeconds = Math.max(1, Math.round(diffMs / 1000));
  const remainingMinutes = Math.max(1, Math.round(diffMs / 60000));
  const severity = strike >= 3 || remainingMinutes >= 15 ? "critical" : "warning";

  return {
    throttled: true,
    remainingMinutes,
    remainingSeconds,
    strike,
    severity,
    summary: `Retry-After sessiz penceresi: ~${remainingMinutes} dk kaldı (strike ${strike || 1})`
  };
}

/**
 * Aggregates `extraUsage` credits (`usedCredits` / `monthlyLimit`) across enabled Claude accounts.
 */
export function summarizeExtraUsageCreditsPool(accounts = []) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  let enabledCount = 0;
  let totalLimitUsd = 0;
  let totalUsedUsd = 0;

  for (const acct of enabled) {
    const ex = acct?.usage?.extraUsage;
    if (!ex || !ex.isEnabled) continue;
    enabledCount += 1;
    if (typeof ex.monthlyLimit === "number" && ex.monthlyLimit > 0) {
      totalLimitUsd += ex.monthlyLimit;
    }
    if (typeof ex.usedCredits === "number" && ex.usedCredits >= 0) {
      totalUsedUsd += ex.usedCredits;
    }
  }

  totalLimitUsd = Math.round(totalLimitUsd * 100) / 100;
  totalUsedUsd = Math.round(totalUsedUsd * 100) / 100;
  const totalRemainingUsd = Math.max(0, Math.round((totalLimitUsd - totalUsedUsd) * 100) / 100);
  const utilizationPct =
    totalLimitUsd > 0 ? Math.min(100, Math.round((totalUsedUsd / totalLimitUsd) * 1000) / 10) : 0;

  return {
    hasExtraUsage: enabledCount > 0,
    enabledAccountCount: enabledCount,
    totalLimitUsd,
    totalUsedUsd,
    totalRemainingUsd,
    utilizationPct,
    summary:
      enabledCount > 0
        ? `Ek kullanım kredisi: $${totalRemainingUsd.toFixed(2)} kalan / $${totalLimitUsd.toFixed(2)} limit (${enabledCount} hesap)`
        : "Etkin ek kullanım kredisi (extraUsage) yok"
  };
}

/**
 * Evaluates Claude Usage Cache Freshness & Sync Health across enabled accounts.
 */
export function evaluateUsageCacheFreshness(accounts = [], options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);

  if (enabled.length === 0) {
    return {
      score: 100,
      status: "fresh",
      freshCount: 0,
      staleCount: 0,
      missingCount: 0,
      maxAgeMinutes: null,
      staleAccounts: [],
      summary: "Etkin hesap yok"
    };
  }

  let freshCount = 0;
  let staleCount = 0;
  let missingCount = 0;
  let maxAgeMinutes = null;
  const staleAccounts = [];

  for (const acct of enabled) {
    const u = acct?.usage;
    if (!u || !u.fetchedAt) {
      missingCount += 1;
      staleAccounts.push(acct.name);
      continue;
    }
    const fMs = Date.parse(String(u.fetchedAt));
    const ageMin = Number.isFinite(fMs) && nowMs >= fMs ? Math.max(0, Math.round((nowMs - fMs) / 60000)) : null;
    if (ageMin !== null && (maxAgeMinutes === null || ageMin > maxAgeMinutes)) {
      maxAgeMinutes = ageMin;
    }
    if (u.stale === true || (ageMin !== null && ageMin > 25)) {
      staleCount += 1;
      staleAccounts.push(acct.name);
    } else {
      freshCount += 1;
    }
  }

  const score = Math.round((freshCount / enabled.length) * 100);
  const status = freshCount === 0 ? "critical" : staleAccounts.length > 0 ? "stale" : "fresh";

  return {
    score,
    status,
    freshCount,
    staleCount,
    missingCount,
    maxAgeMinutes,
    staleAccounts,
    summary:
      staleAccounts.length > 0
        ? `Kota verisi bayat (${staleAccounts.length}/${enabled.length} hesap): ${staleAccounts.join(", ")}`
        : `Kota önbelleği güncel (${freshCount}/${enabled.length} hesap)`
  };
}

/**
 * Evaluates Backup & Embedding Guardian Continuity across scheduled local maintenance jobs.
 */
export function evaluateBackupAndGuardianContinuity(services = []) {
  const list = Array.isArray(services) ? services : [];
  const targetIds = new Set(["nightly-backup", "embedding-guardian", "polyctl-admin-tick"]);
  const targets = list.filter((s) => s && (targetIds.has(s.id) || s.kind === "scheduled" || s.kind === "interval"));

  if (targets.length === 0) {
    return {
      score: 100,
      status: "ok",
      checkedCount: 0,
      healthyCount: 0,
      degradedJobs: [],
      summary: "Zamanlanmış koruyucu servis tanımlı değil"
    };
  }

  const degradedJobs = [];
  let healthyCount = 0;

  for (const svc of targets) {
    const isOk =
      (svc.state === "running" || svc.state === "scheduled") &&
      (svc.lastExitStatus === 0 || svc.lastExitStatus === null || svc.lastExitStatus === undefined);
    if (isOk) {
      healthyCount += 1;
    } else {
      degradedJobs.push(svc.title || svc.id || svc.label || "Servis");
    }
  }

  const score = Math.round((healthyCount / targets.length) * 100);
  const status = degradedJobs.length >= 2 ? "critical" : degradedJobs.length === 1 ? "warning" : "ok";

  return {
    score,
    status,
    checkedCount: targets.length,
    healthyCount,
    degradedJobs,
    summary:
      degradedJobs.length > 0
        ? `Koruyucu servis uyarısı: ${degradedJobs.join(", ")}`
        : `Yedekleme ve koruyucu işler sağlıklı (${healthyCount}/${targets.length})`
  };
}


/**
 * Evaluates whether legacy launchd plist files remain on disk based on daemon warnings.
 */
export function evaluateLegacyLaunchdCleanliness(warnings = []) {
  const list = Array.isArray(warnings) ? warnings : [];
  const legacyWarn = list.find((w) => w && w.id === "legacy-launchd") || null;

  if (!legacyWarn) {
    return {
      clean: true,
      lingeringCount: 0,
      lingeringLabels: [],
      fixCommand: null,
      summary: "Eski launchd plist kalıntısı yok"
    };
  }

  const rawDetail = String(legacyWarn.detail || "");
  const lingeringLabels = rawDetail
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lingeringCount = lingeringLabels.length || 1;
  const fixCommand = legacyWarn.fix || "keyflip daemon install -y";

  return {
    clean: false,
    lingeringCount,
    lingeringLabels,
    fixCommand,
    summary: `${lingeringCount} eski launchd plist kalıntısı mevcut (${fixCommand})`
  };
}

/**
 * Evaluates telemetry readability and timestamp freshness across secondary AI quotas (`otherQuotas`).
 */
export function evaluateOtherQuotasFreshness(otherQuotas = [], options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const maxAgeMin = typeof options.maxAgeMinutes === "number" ? options.maxAgeMinutes : 180;
  const list = Array.isArray(otherQuotas) ? otherQuotas : [];

  if (list.length === 0) {
    return {
      totalCount: 0,
      readableCount: 0,
      freshCount: 0,
      staleProviders: [],
      unreadableProviders: [],
      status: "empty",
      summary: "İkincil kota kaynağı yok"
    };
  }

  let readableCount = 0;
  let freshCount = 0;
  const staleProviders = [];
  const unreadableProviders = [];

  for (const q of list) {
    if (!q || typeof q !== "object") continue;
    const label = q.label || q.id || "Sağlayıcı";
    if (q.status === "unreadable" || q.source === "none") {
      unreadableProviders.push(label);
      continue;
    }
    readableCount += 1;
    if (q.updatedAt) {
      const ts = Date.parse(String(q.updatedAt));
      if (Number.isFinite(ts) && nowMs >= ts && (nowMs - ts) / 60000 > maxAgeMin) {
        staleProviders.push(label);
        continue;
      }
    }
    freshCount += 1;
  }

  const status =
    readableCount === 0
      ? "unreadable"
      : staleProviders.length > 0 || unreadableProviders.length > 0
        ? "partial"
        : "fresh";

  return {
    totalCount: list.length,
    readableCount,
    freshCount,
    staleProviders,
    unreadableProviders,
    status,
    summary:
      staleProviders.length > 0
        ? `İkincil kotalar: ${freshCount}/${list.length} güncel (${staleProviders.join(", ")} eski)`
        : `İkincil kotalar: ${readableCount}/${list.length} okunabilir`
  };
}

/**
 * Evaluates reclaimable agent slots from stuck or dormant Traycer fleet agents.
 */
export function evaluateFleetCapacityReclaim(fleet = {}) {
  if (!fleet || fleet.status === "unreadable" || typeof fleet.total !== "number") {
    return {
      reclaimableCount: 0,
      stuckCount: 0,
      dormantCount: 0,
      hasReclaimable: false,
      summary: "Filo kapasite verisi okunamadı"
    };
  }

  const stuckCount = typeof fleet.stuck === "number" ? fleet.stuck : 0;
  const dormantCount = typeof fleet.dormant === "number" ? fleet.dormant : 0;
  const reclaimableCount = stuckCount + dormantCount;
  const hasReclaimable = reclaimableCount > 0;

  const parts = [];
  if (stuckCount > 0) parts.push(`${stuckCount} takılı`);
  if (dormantCount > 0) parts.push(`${dormantCount} uyuyan`);

  return {
    reclaimableCount,
    stuckCount,
    dormantCount,
    hasReclaimable,
    summary: hasReclaimable
      ? `Geri kazanılabilir ajan: ${reclaimableCount} (${parts.join(", ")})`
      : "Tüm ajan yuvaları verimli (takılı/uyuyan yok)"
  };
}

/**
 * Evaluates Claude Account Tier & Priority Alignment (checking whether a higher-capacity Max/Team
 * subscription sits idle with ample headroom while a lower tier account is active).
 */
export function evaluateAccountTierAlignment(accounts = []) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  const rankForTier = (tierRaw) => {
    const t = String(tierRaw || "").toLowerCase();
    if (t.includes("max") || t.includes("20x") || t.includes("5x") || t.includes("enterprise")) return 3;
    if (t.includes("team")) return 2;
    if (t.includes("pro")) return 1;
    return 1;
  };

  const active = enabled.find((a) => a.active) || null;
  if (!active || enabled.length < 2) {
    return {
      aligned: true,
      activeTier: active?.tier || "pro",
      recommendedHigherTierAccount: null,
      summary: "Hesap katman hizalaması uygun"
    };
  }

  const activeRank = rankForTier(active.tier);
  const activeFivePct =
    typeof active?.usage?.fiveHour?.pct === "number" ? active.usage.fiveHour.pct : 0;

  let betterCandidate = null;
  for (const acct of enabled) {
    if (acct.name === active.name) continue;
    const r = rankForTier(acct.tier);
    const five = typeof acct?.usage?.fiveHour?.pct === "number" ? acct.usage.fiveHour.pct : 0;
    const seven = typeof acct?.usage?.sevenDay?.pct === "number" ? acct.usage.sevenDay.pct : 0;
    const tokOk = !acct.token || acct.token.status === "valid";
    if (tokOk && r > activeRank && five <= 60 && seven <= 75) {
      betterCandidate = acct;
      break;
    }
    if (tokOk && r === activeRank && activeFivePct >= 75 && five <= 35 && seven <= 75) {
      betterCandidate = acct;
    }
  }

  const aligned = !betterCandidate;
  return {
    aligned,
    activeTier: active.tier || "pro",
    recommendedHigherTierAccount: betterCandidate ? betterCandidate.name : null,
    summary: betterCandidate
      ? `Katman optimizasyonu: ${betterCandidate.name} (${betterCandidate.tier || "yüksek kapasite"}) hesabına geçiş önerilir`
      : `Hesap katman hizalaması uygun (${active.name})`
  };
}

/**
 * Evaluates Failover Chain Leg Diversity & Gateway Readiness (checking how many backup provider legs
 * are configured in the Keysmith failover chain).
 */
export function evaluateFailoverChainRedundancy(failoverInfo = {}) {
  if (!failoverInfo || !failoverInfo.enabled) {
    return {
      enabled: false,
      legCount: 0,
      gatewayReady: false,
      score: 0,
      status: "disabled",
      summary: "Failover zinciri kapalı"
    };
  }

  const rawLegs = failoverInfo.legs;
  const legList = Array.isArray(rawLegs)
    ? rawLegs.filter(Boolean)
    : typeof rawLegs === "string" && rawLegs.trim()
      ? rawLegs.split(/[,+>→]/).map((s) => s.trim()).filter(Boolean)
      : [];
  const legCount = legList.length;
  const gatewayReady = Boolean(failoverInfo.gatewayReady);

  let score = 0;
  if (gatewayReady) score += 50;
  if (legCount >= 2) score += 50;
  else if (legCount === 1) score += 30;
  else score += 15;

  const status = !gatewayReady ? "degraded" : legCount >= 2 ? "redundant" : "single-leg";

  return {
    enabled: true,
    legCount,
    gatewayReady,
    score,
    status,
    summary: !gatewayReady
      ? "Failover gateway hazır değil"
      : legCount >= 2
        ? `Failover zinciri yedekli (${legCount} ayak hazır)`
        : "Failover tek ayaklı (ikincil sağlayıcı ayağı önerilir)"
  };
}


/**
 * Evaluates daemon uptime stability and socket readiness based on `daemon` metadata.
 */
export function evaluateDaemonUptimeStability(daemonMeta = {}) {
  const uptimeSeconds = typeof daemonMeta?.uptimeSeconds === "number" ? Math.max(0, daemonMeta.uptimeSeconds) : 0;
  const hasSocket = Boolean(daemonMeta?.socketPath);
  const uptimeHours = Math.round((uptimeSeconds / 3600) * 10) / 10;

  let status = "healthy";
  if (!hasSocket) {
    status = "offline";
  } else if (uptimeSeconds > 0 && uptimeSeconds < 120) {
    status = "just-restarted";
  }

  let humanUptime = `${uptimeSeconds} sn`;
  if (uptimeSeconds >= 86400) {
    const days = Math.floor(uptimeSeconds / 86400);
    const remHours = Math.round((uptimeSeconds % 86400) / 3600);
    humanUptime = remHours > 0 ? `${days}g ${remHours}s` : `${days} gün`;
  } else if (uptimeSeconds >= 3600) {
    humanUptime = `${uptimeHours} saat`;
  } else if (uptimeSeconds >= 60) {
    humanUptime = `${Math.round(uptimeSeconds / 60)} dk`;
  }

  return {
    status,
    uptimeSeconds,
    uptimeHours,
    humanUptime,
    hasSocket,
    summary:
      status === "offline"
        ? "Daemon soketi bağlı değil"
        : status === "just-restarted"
          ? `Daemon yeni başlatıldı (${humanUptime})`
          : `Daemon kararlı (çalışma süresi: ${humanUptime})`
  };
}

/**
 * Detects whether two or more enabled Claude accounts have their 5-hour quota reset times
 * within `collisionWindowMin` (default 20 minutes) of each other.
 */
export function detectFiveHourResetCollision(accounts = [], options = {}) {
  const collisionWindowMin = typeof options.collisionWindowMin === "number" ? options.collisionWindowMin : 20;
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);

  const withResets = [];
  for (const acct of enabled) {
    const raw = acct?.usage?.fiveHour?.resetsAt || acct?.fiveHourResetsAt || null;
    if (!raw) continue;
    const ms = Date.parse(String(raw));
    if (Number.isFinite(ms)) {
      withResets.push({ name: acct.name, ms });
    }
  }

  withResets.sort((a, b) => a.ms - b.ms);
  const collidingPairs = [];
  let minGapMinutes = null;

  for (let i = 1; i < withResets.length; i += 1) {
    const prev = withResets[i - 1];
    const cur = withResets[i];
    const gapMin = Math.round((cur.ms - prev.ms) / 60000);
    if (minGapMinutes === null || gapMin < minGapMinutes) {
      minGapMinutes = gapMin;
    }
    if (gapMin <= collisionWindowMin) {
      collidingPairs.push({
        first: prev.name,
        second: cur.name,
        gapMinutes: gapMin
      });
    }
  }

  const hasCollision = collidingPairs.length > 0;
  return {
    hasCollision,
    collisionCount: collidingPairs.length,
    minGapMinutes,
    collidingPairs,
    summary: hasCollision
      ? `5s sıfırlanma çakışması: ${collidingPairs[0].first} & ${collidingPairs[0].second} (${collidingPairs[0].gapMinutes} dk ara)`
      : "5s sıfırlanma zamanları ayrık"
  };
}

/**
 * Evaluates the proportion of `unknown` rows in the Status Board to identify telemetry blind spots.
 */
export function evaluateStatusBoardUnknownNoise(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  let totalRows = 0;
  let unknownRows = 0;
  const affectedSections = [];

  for (const sec of sections) {
    let secUnknown = 0;
    for (const r of sec?.rows || []) {
      totalRows += 1;
      if (!["ok", "warn", "bad"].includes(r?.status)) {
        unknownRows += 1;
        secUnknown += 1;
      }
    }
    if (secUnknown > 0) {
      affectedSections.push(sec?.title || sec?.id || "Bölüm");
    }
  }

  const unknownPct = totalRows > 0 ? Math.round((unknownRows / totalRows) * 100) : 0;
  const hasBlindSpots = unknownRows > 0;

  return {
    hasBlindSpots,
    totalRows,
    unknownRows,
    unknownPct,
    affectedSections,
    summary: hasBlindSpots
      ? `Belirsiz telemetri: ${unknownRows}/${totalRows} satır (% ${unknownPct} — ${affectedSections.join(", ")})`
      : "Tüm durum panosu satırları net"
  };
}

/**
 * Evaluates 5-Hour Quota Window Staggering Quality across enabled Claude accounts,
 * scoring how well staggered the 5-hour reset windows are.
 */
export function evaluateFiveHourWindowStaggering(accounts = [], options = {}) {
  const idealGapMin = typeof options.idealGapMin === "number" ? options.idealGapMin : 45;
  const col = detectFiveHourResetCollision(accounts, { collisionWindowMin: 20 });

  if (col.minGapMinutes === null) {
    return {
      staggered: true,
      minGapMinutes: null,
      score: 100,
      summary: "Tek aktif 5s penceresi"
    };
  }

  const minGapMinutes = col.minGapMinutes;
  const score = Math.max(0, Math.min(100, Math.round((minGapMinutes / idealGapMin) * 100)));
  const staggered = minGapMinutes >= 25;

  return {
    staggered,
    minGapMinutes,
    score,
    summary: staggered
      ? `5s pencere kademelenmesi iyi (en yakın fark ${minGapMinutes} dk)`
      : `5s pencereleri çakışıyor (${minGapMinutes} dk fark) — erken rotasyon önerilir`
  };
}

/**
 * Identifies the most degraded section ("Hotspot") in the Status Board based on weighted `bad` and `warn` counts.
 */
export function evaluateStatusBoardHotspot(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  let hotspot = null;

  for (const sec of sections) {
    let badCount = 0;
    let warnCount = 0;
    for (const r of sec?.rows || []) {
      if (r?.status === "bad") badCount += 1;
      else if (r?.status === "warn") warnCount += 1;
    }
    const severityScore = badCount * 3 + warnCount * 1;
    if (severityScore > 0 && (!hotspot || severityScore > hotspot.severityScore)) {
      hotspot = {
        sectionId: sec?.id || "section",
        sectionTitle: sec?.title || sec?.id || "Bölüm",
        badCount,
        warnCount,
        severityScore
      };
    }
  }

  return {
    hasHotspot: Boolean(hotspot),
    sectionId: hotspot ? hotspot.sectionId : null,
    sectionTitle: hotspot ? hotspot.sectionTitle : null,
    badCount: hotspot ? hotspot.badCount : 0,
    warnCount: hotspot ? hotspot.warnCount : 0,
    summary: hotspot
      ? `Odak darboğazı: ${hotspot.sectionTitle} (${hotspot.badCount} kritik, ${hotspot.warnCount} uyarı)`
      : "Durum panosunda darboğaz bölüm yok"
  };
}


/**
 * Evaluates the safety margin ratio between `refresh.leadMinutes` and `daemon.refreshIntervalSeconds`
 * so OAuth tokens get at least 2 renewal ticks before expiry.
 */
export function evaluateRefreshLeadTimeMargin(config = {}) {
  const leadMinutes =
    typeof config?.["refresh.leadMinutes"] === "number" && config["refresh.leadMinutes"] > 0
      ? config["refresh.leadMinutes"]
      : 45;
  const intervalSeconds =
    typeof config?.["daemon.refreshIntervalSeconds"] === "number" && config["daemon.refreshIntervalSeconds"] > 0
      ? config["daemon.refreshIntervalSeconds"]
      : 900;
  const intervalMinutes = Math.round((intervalSeconds / 60) * 10) / 10;
  const ticksBeforeExpiry = intervalMinutes > 0 ? Math.round((leadMinutes / intervalMinutes) * 10) / 10 : 0;
  const safe = ticksBeforeExpiry >= 2;

  return {
    safe,
    leadMinutes,
    intervalMinutes,
    ticksBeforeExpiry,
    summary: safe
      ? `OAuth yenileme marjı güvenli (${ticksBeforeExpiry}x döngü payı)`
      : `Dar OAuth yenileme marjı (${leadMinutes} dk ön-süre / ${intervalMinutes} dk döngü)`
  };
}

/**
 * Summarizes monitored local launchd services grouped by kind (`daemon`, `interval`, `scheduled`).
 */
export function summarizeServicesByKind(services = []) {
  const list = Array.isArray(services) ? services : [];
  const counts = {
    daemon: { total: 0, healthy: 0 },
    interval: { total: 0, healthy: 0 },
    scheduled: { total: 0, healthy: 0 }
  };

  for (const svc of list) {
    if (!svc || typeof svc !== "object") continue;
    const k = ["daemon", "interval", "scheduled"].includes(svc.kind) ? svc.kind : "daemon";
    counts[k].total += 1;
    if (svc.state === "running" || svc.state === "scheduled") {
      counts[k].healthy += 1;
    }
  }

  return {
    daemonTotal: counts.daemon.total,
    daemonHealthy: counts.daemon.healthy,
    intervalTotal: counts.interval.total,
    intervalHealthy: counts.interval.healthy,
    scheduledTotal: counts.scheduled.total,
    scheduledHealthy: counts.scheduled.healthy,
    summary: `Daemon ${counts.daemon.healthy}/${counts.daemon.total} · Periyodik ${counts.interval.healthy}/${counts.interval.total} · Zamanlı ${counts.scheduled.healthy}/${counts.scheduled.total}`
  };
}

/**
 * Evaluates API Promo Grant (`apicredits`) balance and utilization from `otherQuotas`.
 */
export function evaluateApiPromoGrantHealth(otherQuotas = []) {
  const list = Array.isArray(otherQuotas) ? otherQuotas : [];
  const item = list.find((q) => q && q.id === "apicredits") || null;

  if (!item || item.status === "unreadable") {
    return {
      available: false,
      status: "unreadable",
      usedPct: null,
      remainingUsd: null,
      summary: "API promosyon hibesi okunamadı"
    };
  }

  const m = typeof item.display === "string" ? item.display.match(/\$(\d+(?:\.\d+)?)/) : null;
  const remainingUsd = m ? Number.parseFloat(m[1]) : null;
  const usedPct = typeof item.usedPct === "number" ? item.usedPct : null;

  return {
    available: true,
    status: item.status || "ok",
    usedPct,
    remainingUsd,
    summary:
      remainingUsd !== null
        ? `API Promosyon hibesi: $${remainingUsd.toFixed(2)} kalan${usedPct !== null ? ` (% ${usedPct} kullanıldı)` : ""}`
        : `API Promosyon hibesi: ${item.display}`
  };
}

/**
 * Computes the active Claude account remaining percentage cushion before hitting `autoswitch.threshold`.
 */
export function evaluateActiveAccountSafetyCushion(accounts = [], config = {}) {
  const threshold =
    typeof config?.["autoswitch.threshold"] === "number" && config["autoswitch.threshold"] > 0
      ? config["autoswitch.threshold"]
      : 90;
  const list = Array.isArray(accounts) ? accounts : [];
  const active = list.find((a) => a && a.active) || null;

  if (!active) {
    return {
      hasActive: false,
      activeAccount: null,
      usedFiveHourPct: null,
      thresholdPct: threshold,
      cushionPct: null,
      status: "no-active",
      summary: "Etkin aktif hesap yok"
    };
  }

  const usedFiveHourPct =
    typeof active?.usage?.fiveHour?.pct === "number"
      ? active.usage.fiveHour.pct
      : typeof active?.fiveHourPct === "number"
        ? active.fiveHourPct
        : 0;
  const cushionPct = Math.max(0, Math.round((threshold - usedFiveHourPct) * 10) / 10);
  const status = cushionPct <= 0 ? "breached" : cushionPct <= 10 ? "imminent" : "comfortable";

  return {
    hasActive: true,
    activeAccount: active.name,
    usedFiveHourPct,
    thresholdPct: threshold,
    cushionPct,
    status,
    summary:
      status === "breached"
        ? `Otomatik geçiş eşiği aşıldı (${active.name}: %${usedFiveHourPct} / eşik %${threshold})`
        : status === "imminent"
          ? `Otomatik geçişe %${cushionPct} kaldı (${active.name}: %${usedFiveHourPct} / eşik %${threshold})`
          : `Aktif hesap güvenlik payı: %${cushionPct} (eşik %${threshold})`
  };
}

/**
 * Computes the active working utilization percentage across non-dormant Traycer fleet agents.
 */
export function evaluateFleetWorkingUtilization(fleet = {}) {
  if (!fleet || fleet.status === "unreadable" || typeof fleet.working !== "number") {
    return {
      status: "unreadable",
      utilizationPct: null,
      activePoolSize: 0,
      workingCount: 0,
      summary: "Filo kullanım oranı okunamadı"
    };
  }

  const working = Math.max(0, fleet.working || 0);
  const idle = Math.max(0, fleet.idle || 0);
  const stuck = Math.max(0, fleet.stuck || 0);
  const activePoolSize = working + idle + stuck;
  const utilizationPct = activePoolSize > 0 ? Math.round((working / activePoolSize) * 100) : 0;

  let status = "balanced";
  if (stuck > 0 && working === 0) {
    status = "stalled";
  } else if (utilizationPct >= 70) {
    status = "high-throughput";
  } else if (utilizationPct <= 25 && activePoolSize > 0) {
    status = "underutilized";
  }

  return {
    status,
    utilizationPct,
    activePoolSize,
    workingCount: working,
    summary: `Aktif filo kullanımı: %${utilizationPct} (${working}/${activePoolSize} ajan çalışıyor)`
  };
}


/**
 * Evaluates the cadence and health of the `conv-index` conversation indexing and embedding job.
 */
export function evaluateConvIndexCadenceHealth(jobs = {}, config = {}, options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const meta = jobs?.["conv-index"] || null;
  const intervalSeconds =
    typeof meta?.intervalSeconds === "number"
      ? meta.intervalSeconds
      : typeof config?.["daemon.convIndexIntervalSeconds"] === "number"
        ? config["daemon.convIndexIntervalSeconds"]
        : 1800;

  if (!meta || !meta.lastRunAt) {
    return {
      status: "pending",
      intervalMinutes: Math.round(intervalSeconds / 60),
      ageMinutes: null,
      runCount: meta?.runCount || 0,
      summary: "Konuşma indeksleme (conv-index) henüz çalışmadı"
    };
  }

  const lastMs = Date.parse(String(meta.lastRunAt));
  const ageMinutes = Number.isFinite(lastMs) && nowMs >= lastMs ? Math.max(0, Math.round((nowMs - lastMs) / 60000)) : null;
  const intervalMinutes = Math.max(1, Math.round(intervalSeconds / 60));

  let status = "healthy";
  if (meta.lastResult === "error" || meta.lastError) {
    status = "error";
  } else if (ageMinutes !== null && ageMinutes > intervalMinutes * 2.5) {
    status = "overdue";
  }

  return {
    status,
    intervalMinutes,
    ageMinutes,
    runCount: meta.runCount || 0,
    summary:
      status === "error"
        ? `Konuşma indeksleme hatası: ${meta.lastError || "bilinmeyen hata"}`
        : status === "overdue"
          ? `Konuşma indeksleme gecikti (${ageMinutes} dk önce / döngü ${intervalMinutes} dk)`
          : `Konuşma indeksleme güncel (${ageMinutes ?? 0} dk önce)`
  };
}

/**
 * Evaluates coordination between the `surface-refresh` job and secondary quotas readability.
 */
export function evaluateSurfaceRefreshCoordHealth(jobs = {}, otherQuotas = []) {
  const meta = jobs?.["surface-refresh"] || null;
  const list = Array.isArray(otherQuotas) ? otherQuotas : [];
  const readableCount = list.filter((q) => q && q.status !== "unreadable" && q.source !== "none").length;
  const jobOk = !meta || (meta.lastResult !== "error" && !meta.lastError);

  let status = "ok";
  if (!jobOk) {
    status = "job-error";
  } else if (list.length > 0 && readableCount === 0) {
    status = "unreadable-surfaces";
  }

  return {
    status,
    jobOk,
    readableSurfaces: readableCount,
    totalSurfaces: list.length,
    summary:
      status === "job-error"
        ? "Yüzey yenileme (surface-refresh) hata verdi"
        : `Yüzey eşgüdümü: ${readableCount}/${list.length} ikincil yüzey okunabilir`
  };
}

/**
 * Summarizes daemon warnings by severity (`error` vs `warn`) and extracts the highest-priority CLI fix command.
 */
export function summarizeDaemonWarningsBySeverity(warnings = []) {
  const list = Array.isArray(warnings) ? warnings : [];
  let errorCount = 0;
  let warnCount = 0;
  let topFixCommand = null;
  let topWarningTitle = null;

  for (const w of list) {
    if (!w || typeof w !== "object") continue;
    if (w.severity === "error") {
      errorCount += 1;
      if (!topFixCommand && w.fix) {
        topFixCommand = w.fix;
        topWarningTitle = w.title || w.id;
      }
    } else {
      warnCount += 1;
    }
  }

  if (!topFixCommand) {
    const firstWithFix = list.find((w) => w && w.fix) || null;
    if (firstWithFix) {
      topFixCommand = firstWithFix.fix;
      topWarningTitle = firstWithFix.title || firstWithFix.id;
    }
  }

  const totalCount = errorCount + warnCount;
  return {
    totalCount,
    errorCount,
    warnCount,
    topFixCommand,
    topWarningTitle,
    summary:
      totalCount > 0
        ? `Daemon uyarıları: ${errorCount} kritik, ${warnCount} uyarı${topFixCommand ? ` (Öneri: ${topFixCommand})` : ""}`
        : "Aktif daemon uyarısı yok"
  };
}

/**
 * Evaluates Combined 5-Hour + 7-Day Dual-Window Bottleneck & Effective Headroom across enabled accounts.
 */
export function evaluateDualWindowBottleneck(accounts = []) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  if (enabled.length === 0) {
    return {
      status: "empty",
      dominantConstraint: "none",
      sevenDayConstrainedCount: 0,
      fiveHourConstrainedCount: 0,
      bestEffectiveAccount: null,
      bestEffectiveHeadroomPct: 0,
      summary: "Etkin hesap yok"
    };
  }

  let sevenDayConstrainedCount = 0;
  let fiveHourConstrainedCount = 0;
  let bestAcct = null;
  let bestHeadroom = -1;

  for (const acct of enabled) {
    const five =
      typeof acct?.usage?.fiveHour?.pct === "number"
        ? acct.usage.fiveHour.pct
        : typeof acct?.fiveHourPct === "number"
          ? acct.fiveHourPct
          : 0;
    const seven =
      typeof acct?.usage?.sevenDay?.pct === "number"
        ? acct.usage.sevenDay.pct
        : typeof acct?.sevenDayPct === "number"
          ? acct.sevenDayPct
          : 0;
    if (seven > five && seven >= 70) {
      sevenDayConstrainedCount += 1;
    } else if (five >= 70) {
      fiveHourConstrainedCount += 1;
    }

    const effHeadroom =
      typeof acct?.usage?.effectiveHeadroom === "number"
        ? acct.usage.effectiveHeadroom
        : Math.max(0, 100 - Math.max(five, seven));
    if (effHeadroom > bestHeadroom) {
      bestHeadroom = effHeadroom;
      bestAcct = acct.name;
    }
  }

  const dominantConstraint =
    sevenDayConstrainedCount > 0
      ? "seven-day"
      : fiveHourConstrainedCount > 0
        ? "five-hour"
        : "none";
  const status = dominantConstraint === "none" ? "unconstrained" : "constrained";
  const bestEffectiveHeadroomPct = Math.max(0, Math.round(bestHeadroom * 10) / 10);

  return {
    status,
    dominantConstraint,
    sevenDayConstrainedCount,
    fiveHourConstrainedCount,
    bestEffectiveAccount: bestAcct,
    bestEffectiveHeadroomPct,
    summary:
      dominantConstraint === "seven-day"
        ? `Çift pencere daralması: ${sevenDayConstrainedCount} hesapta 7g limit baskın (en geniş: ${bestAcct} %${bestEffectiveHeadroomPct} boş)`
        : dominantConstraint === "five-hour"
          ? `Çift pencere daralması: ${fiveHourConstrainedCount} hesapta 5s limit baskın (en geniş: ${bestAcct} %${bestEffectiveHeadroomPct} boş)`
          : `Çift pencere dengeli (en geniş: ${bestAcct} %${bestEffectiveHeadroomPct} efektif boşluk)`
  };
}

/**
 * Evaluates Remote Server Combined Host + Sites Operational Readiness Score (0-100).
 */
export function evaluateServerOverallReadiness(server = {}) {
  if (!server || server.status === "unreadable") {
    return {
      score: 0,
      grade: "D",
      status: "unreadable",
      summary: "Uzak sunucu verisi okunamadı"
    };
  }

  const pressure = evaluateServerResourcePressure(server);
  const sitesHealth = evaluateServerSitesHealth(server);

  const hostScore = typeof pressure.score === "number" ? pressure.score : 100;
  const siteScore = typeof sitesHealth.score === "number" ? sitesHealth.score : 100;
  const score = Math.max(0, Math.min(100, Math.round(hostScore * 0.5 + siteScore * 0.5)));
  const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "D";
  const status = score >= 85 ? "healthy" : score >= 60 ? "warning" : "critical";

  return {
    score,
    grade,
    status,
    summary: `Sunucu genel hazırlık: ${grade} (% ${score})`
  };
}

/**
 * Evaluates how many degraded (`error`, `warning`, `stopped`) local services are whitelisted
 * (`restartable: true`) for one-click recovery from the menu bar.
 */
export function evaluateServiceRestartCoverage(services = []) {
  const list = Array.isArray(services) ? services : [];
  const degraded = list.filter(
    (s) => s && typeof s === "object" && s.state !== "running" && s.state !== "scheduled"
  );
  const totalDegraded = degraded.length;

  if (totalDegraded === 0) {
    return {
      totalDegraded: 0,
      restartableDegraded: 0,
      coveragePct: 100,
      nonRestartableLabels: [],
      status: "all-healthy",
      summary: "Tüm servisler çalışıyor (kurtarma gerekmiyor)"
    };
  }

  let restartableDegraded = 0;
  const nonRestartableLabels = [];
  for (const svc of degraded) {
    if (svc.restartable) {
      restartableDegraded += 1;
    } else {
      nonRestartableLabels.push(svc.title || svc.label || svc.id || "Servis");
    }
  }

  const coveragePct = Math.round((restartableDegraded / totalDegraded) * 100);
  const status =
    restartableDegraded === totalDegraded
      ? "full-coverage"
      : restartableDegraded > 0
        ? "partial-coverage"
        : "manual-only";

  return {
    totalDegraded,
    restartableDegraded,
    coveragePct,
    nonRestartableLabels,
    status,
    summary:
      restartableDegraded === totalDegraded
        ? `Kurtarma kapsamı: ${restartableDegraded}/${totalDegraded} sorunlu servis tek tıkla yeniden başlatılabilir`
        : `Kurtarma kapsamı: ${restartableDegraded}/${totalDegraded} tek tıkla (${nonRestartableLabels.join(", ")} manuel)`
  };
}

/**
 * Computes the ratio of `owner_needed` items to Status Board sections and rows to classify admin intervention load.
 */
export function evaluateOwnerToSectionRatio(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  const owners = Array.isArray(statusBoard?.owner_needed) ? statusBoard.owner_needed : [];
  const ownerNeededCount = owners.length;
  const sectionCount = sections.length;
  const rowCount = sections.reduce((acc, s) => acc + (Array.isArray(s?.rows) ? s.rows.length : 0), 0);

  if (ownerNeededCount === 0) {
    return {
      ownerNeededCount: 0,
      sectionCount,
      rowCount,
      itemsPerSection: 0,
      loadTier: "idle",
      summary: "Yönetici müdahalesi bekleyen iş yok"
    };
  }

  const itemsPerSection =
    sectionCount > 0 ? Math.round((ownerNeededCount / sectionCount) * 10) / 10 : ownerNeededCount;
  const loadTier =
    ownerNeededCount >= 5 || itemsPerSection >= 2.0
      ? "heavy"
      : ownerNeededCount >= 2 || itemsPerSection >= 1.0
        ? "moderate"
        : "light";

  return {
    ownerNeededCount,
    sectionCount,
    rowCount,
    itemsPerSection,
    loadTier,
    summary: `Müdahale yoğunluğu: ${ownerNeededCount} iş / ${sectionCount} bölüm (bölüm başına ${itemsPerSection})`
  };
}

/**
 * Summarizes `autoswitch.strategy`, `autoswitch.threshold`, `failover.enabled`, and `failover.capUsd`
 * into a concise human-readable policy summary.
 */
export function summarizeAutoswitchPolicy(config = {}) {
  const strategy = String(config?.["autoswitch.strategy"] || "best").trim() || "best";
  const thresholdPct =
    typeof config?.["autoswitch.threshold"] === "number" && config["autoswitch.threshold"] > 0
      ? config["autoswitch.threshold"]
      : 90;
  const failoverEnabled = Boolean(config?.["failover.enabled"]);
  const capUsd =
    typeof config?.["failover.capUsd"] === "number" && config["failover.capUsd"] > 0
      ? config["failover.capUsd"]
      : null;

  const failoverText = failoverEnabled
    ? `Failover açık${capUsd !== null ? ` ($${capUsd} tavan)` : ""}`
    : "Failover kapalı";

  return {
    strategy,
    thresholdPct,
    failoverEnabled,
    capUsd,
    summary: `Politika: ${strategy} stratejisi · %${thresholdPct} eşik · ${failoverText}`
  };
}

/**
 * Evaluates average remaining headroom percentage across readable secondary AI quotas (`otherQuotas`)
 * and identifies the healthiest fallback surface.
 */
export function evaluateSecondaryPoolHeadroom(otherQuotas = []) {
  const list = Array.isArray(otherQuotas) ? otherQuotas : [];
  const readable = list.filter((q) => q && q.status !== "unreadable" && q.source !== "none");

  if (readable.length === 0) {
    return {
      status: "unreadable",
      readableCount: 0,
      avgRemainingPct: null,
      bestFallbackId: null,
      bestFallbackLabel: null,
      summary: "İkincil AI kota havuzu okunamadı"
    };
  }

  let sumRem = 0;
  let best = null;
  let bestRem = -1;

  for (const q of readable) {
    let rem = 100;
    if (typeof q.usedPct === "number" && Number.isFinite(q.usedPct)) {
      rem = Math.max(0, Math.min(100, 100 - q.usedPct));
    } else if (q.status === "exhausted") {
      rem = 0;
    } else if (q.status === "warning") {
      rem = 20;
    } else {
      rem = 85;
    }
    sumRem += rem;
    if (rem > bestRem) {
      bestRem = rem;
      best = q;
    }
  }

  const avgRemainingPct = Math.round((sumRem / readable.length) * 10) / 10;
  const status = avgRemainingPct >= 50 ? "ample" : avgRemainingPct >= 20 ? "tight" : "critical";

  return {
    status,
    readableCount: readable.length,
    avgRemainingPct,
    bestFallbackId: best ? best.id : null,
    bestFallbackLabel: best ? best.label || best.id : null,
    summary: `İkincil havuz boşluğu: ort. %${avgRemainingPct} (${readable.length} yüzey · en geniş: ${best ? best.label || best.id : "-"}) `
      .trim()
  };
}

/**
 * Evaluates heartbeat freshness across local services that emit a heartbeat file (`heartbeatAgeMin`).
 */
export function evaluateServiceHeartbeatFreshness(services = []) {
  const list = Array.isArray(services) ? services : [];
  const monitored = list.filter(
    (s) => s && typeof s === "object" && typeof s.heartbeatAgeMin === "number" && Number.isFinite(s.heartbeatAgeMin)
  );

  if (monitored.length === 0) {
    return {
      status: "none",
      monitoredCount: 0,
      freshCount: 0,
      maxHeartbeatAgeMin: null,
      staleServices: [],
      summary: "Kalp atışı (heartbeat) izlenen servis yok"
    };
  }

  let freshCount = 0;
  let maxHeartbeatAgeMin = 0;
  const staleServices = [];

  for (const svc of monitored) {
    const age = Math.max(0, Math.round(svc.heartbeatAgeMin));
    if (age > maxHeartbeatAgeMin) maxHeartbeatAgeMin = age;
    if (age <= 30) {
      freshCount += 1;
    } else {
      staleServices.push(svc.title || svc.label || svc.id || "Servis");
    }
  }

  const status =
    staleServices.length === 0
      ? "fresh"
      : maxHeartbeatAgeMin > 45
        ? "critical"
        : "stale";

  return {
    status,
    monitoredCount: monitored.length,
    freshCount,
    maxHeartbeatAgeMin,
    staleServices,
    summary:
      staleServices.length > 0
        ? `Kalp atışı gecikmesi: ${staleServices.join(", ")} (${maxHeartbeatAgeMin} dk önce)`
        : `Servis kalp atışları güncel (en yaşlı ${maxHeartbeatAgeMin} dk)`
  };
}

/**
 * Checks whether failover is manually forced on (`engaged && manual`) while at least one enabled
 * primary Claude account has ample quota headroom (<50% 5h and <75% 7d) and a valid token.
 */
export function evaluateFailoverManualOverrideState(failoverInfo = {}, accounts = []) {
  const engaged = Boolean(failoverInfo?.engaged);
  const manual = Boolean(failoverInfo?.manual);
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);

  const readyAccounts = enabled.filter((a) => {
    const tokOk = !a.token || a.token.status === "valid";
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
    return tokOk && five < 50 && seven < 75;
  });

  const canReleaseManual = engaged && manual && readyAccounts.length > 0;
  const recommendedAccount = readyAccounts[0]?.name || null;

  return {
    engaged,
    manual,
    canReleaseManual,
    readyPrimaryCount: readyAccounts.length,
    recommendedAccount,
    summary: canReleaseManual
      ? `Manuel failover açık ancak birincil havuz müsait (${recommendedAccount}) — kapatılabilir (keyflip failover off)`
      : engaged && manual
        ? "Manuel failover devrede (birincil hesaplar henüz yoğun)"
        : "Manuel failover zorlaması yok"
  };
}

/**
 * Summarizes email provider domains across enabled accounts without exposing full PII email addresses.
 */
export function summarizeAccountEmailDomains(accounts = []) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  const counts = new Map();

  for (const acct of enabled) {
    const raw = String(acct?.email || "").trim().toLowerCase();
    const atIdx = raw.lastIndexOf("@");
    const domain = atIdx > 0 && atIdx < raw.length - 1 ? raw.slice(atIdx + 1) : "belirsiz";
    counts.set(domain, (counts.get(domain) || 0) + 1);
  }

  const domains = Array.from(counts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  return {
    totalEnabled: enabled.length,
    domainCount: domains.length,
    domains,
    summary:
      domains.length > 0
        ? `E-posta dağılımı: ${domains.map((d) => `${d.domain} (${d.count})`).join(", ")}`
        : "Etkin hesap e-posta verisi yok"
  };
}

/**
 * Evaluates average and maximum execution duration (`lastDurationMs`) across scheduled daemon jobs.
 */
export function evaluateDaemonJobDurationHealth(jobs = {}, options = {}) {
  const slowThresholdMs = typeof options.slowThresholdMs === "number" ? options.slowThresholdMs : 3000;
  const entries = Object.entries(jobs || {}).filter(([, meta]) => meta && typeof meta === "object");

  let measuredCount = 0;
  let sumMs = 0;
  let maxDurationMs = 0;
  const slowJobs = [];

  for (const [name, meta] of entries) {
    if (typeof meta.lastDurationMs === "number" && Number.isFinite(meta.lastDurationMs) && meta.lastDurationMs >= 0) {
      measuredCount += 1;
      sumMs += meta.lastDurationMs;
      if (meta.lastDurationMs > maxDurationMs) maxDurationMs = meta.lastDurationMs;
      if (meta.lastDurationMs >= slowThresholdMs) {
        slowJobs.push(name);
      }
    }
  }

  const avgDurationMs = measuredCount > 0 ? Math.round(sumMs / measuredCount) : 0;
  const status = slowJobs.length > 0 ? "slow" : "fast";

  return {
    status,
    measuredCount,
    avgDurationMs,
    maxDurationMs,
    slowJobs,
    summary:
      slowJobs.length > 0
        ? `Yavaş daemon işi: ${slowJobs.join(", ")} (maks ${maxDurationMs} ms)`
        : `Daemon iş gecikmesi düşük (ort. ${avgDurationMs} ms)`
  };
}

/**
 * Computes the ratio of 100% issue-free Status Board sections vs total sections.
 */
export function evaluateStatusBoardCleanSectionRatio(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  const totalSections = sections.length;

  if (totalSections === 0) {
    return {
      totalSections: 0,
      cleanSections: 0,
      degradedSections: 0,
      cleanRatioPct: 100,
      status: "empty",
      summary: "Durum panosu bölümü yok"
    };
  }

  let cleanSections = 0;
  for (const sec of sections) {
    const rows = Array.isArray(sec?.rows) ? sec.rows : [];
    const hasIssue = rows.some((r) => r?.status === "bad" || r?.status === "warn");
    if (!hasIssue) cleanSections += 1;
  }

  const degradedSections = totalSections - cleanSections;
  const cleanRatioPct = Math.round((cleanSections / totalSections) * 100);
  const status = degradedSections === 0 ? "all-clean" : cleanSections === 0 ? "all-degraded" : "mixed";

  return {
    totalSections,
    cleanSections,
    degradedSections,
    cleanRatioPct,
    status,
    summary: `Temiz bölümler: ${cleanSections}/${totalSections} (%${cleanRatioPct} sorunsuz)`
  };
}

/**
 * Computes the tier-weighted capacity multiplier of the enabled Claude account pool
 * (e.g., pro = 1x, team = 2x, max-5x = 5x, max-20x = 20x) and remaining effective multiplier.
 */
export function evaluateEffectivePoolMultiplier(accounts = []) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  const weightForTier = (tierRaw) => {
    const t = String(tierRaw || "").toLowerCase();
    if (t.includes("20x")) return 20;
    if (t.includes("5x") || t.includes("max")) return 5;
    if (t.includes("team")) return 2;
    return 1;
  };

  if (enabled.length === 0) {
    return {
      enabledCount: 0,
      totalMultiplier: 0,
      remainingMultiplier: 0,
      utilizationPct: 0,
      summary: "Etkin havuz kapasitesi yok"
    };
  }

  let totalMultiplier = 0;
  let remainingMultiplier = 0;

  for (const acct of enabled) {
    const w = weightForTier(acct.tier);
    totalMultiplier += w;
    const five =
      typeof acct?.usage?.fiveHour?.pct === "number"
        ? acct.usage.fiveHour.pct
        : typeof acct?.fiveHourPct === "number"
          ? acct.fiveHourPct
          : 0;
    const seven =
      typeof acct?.usage?.sevenDay?.pct === "number"
        ? acct.usage.sevenDay.pct
        : typeof acct?.sevenDayPct === "number"
          ? acct.sevenDayPct
          : 0;
    const remRatio = Math.max(0, Math.min(100, 100 - Math.max(five, seven))) / 100;
    remainingMultiplier += w * remRatio;
  }

  totalMultiplier = Math.round(totalMultiplier * 10) / 10;
  remainingMultiplier = Math.round(remainingMultiplier * 10) / 10;
  const utilizationPct =
    totalMultiplier > 0
      ? Math.max(0, Math.min(100, Math.round(((totalMultiplier - remainingMultiplier) / totalMultiplier) * 100)))
      : 0;

  return {
    enabledCount: enabled.length,
    totalMultiplier,
    remainingMultiplier,
    utilizationPct,
    summary: `Havuz kapasite çarpanı: ${totalMultiplier}x (etkin kalan: ${remainingMultiplier}x)`
  };
}

/**
 * Categorizes remote server sites by HTTP status code class (2xx, 3xx, 4xx, 5xx) or unreachable state.
 */
export function evaluateServerSiteResponseCodeSummary(server = {}) {
  const sites = Array.isArray(server?.sites) ? server.sites : [];
  if (!server || server.status === "unreadable" || sites.length === 0) {
    return {
      totalSites: 0,
      ok2xxCount: 0,
      redirect3xxCount: 0,
      client4xxCount: 0,
      server5xxCount: 0,
      errorSites: [],
      status: "unreadable",
      summary: "Site HTTP yanıt kodu verisi yok"
    };
  }

  let ok2xxCount = 0;
  let redirect3xxCount = 0;
  let client4xxCount = 0;
  let server5xxCount = 0;
  const errorSites = [];

  for (const s of sites) {
    const code = typeof s?.code === "number" ? s.code : null;
    if (code !== null && code >= 200 && code < 300) {
      ok2xxCount += 1;
    } else if (code !== null && code >= 300 && code < 400) {
      redirect3xxCount += 1;
    } else if (code !== null && code >= 400 && code < 500) {
      client4xxCount += 1;
      errorSites.push(`${s.name || "site"} (${code})`);
    } else if (code !== null && code >= 500) {
      server5xxCount += 1;
      errorSites.push(`${s.name || "site"} (${code})`);
    } else if (s?.status === "ok") {
      ok2xxCount += 1;
    } else {
      server5xxCount += 1;
      errorSites.push(`${s?.name || "site"} (${s?.detail || "down"})`);
    }
  }

  const status =
    server5xxCount > 0 ? "critical" : client4xxCount > 0 ? "warning" : "ok";

  return {
    totalSites: sites.length,
    ok2xxCount,
    redirect3xxCount,
    client4xxCount,
    server5xxCount,
    errorSites,
    status,
    summary:
      errorSites.length > 0
        ? `HTTP hatası: ${errorSites.join(", ")} (${ok2xxCount}/${sites.length} 2xx)`
        : `HTTP yanıtları temiz: ${ok2xxCount}/${sites.length} 2xx OK`
  };
}

/**
 * Evaluates the failure/warning rate across recent audit timeline items (`auditTimeline`).
 */
export function evaluateAuditErrorRate(auditTimeline = []) {
  const list = Array.isArray(auditTimeline) ? auditTimeline : [];
  if (list.length === 0) {
    return {
      totalEvents: 0,
      failedEvents: 0,
      errorRatePct: 0,
      status: "clean",
      summary: "Denetim günlüğünde olay yok"
    };
  }

  const failedEvents = list.filter(
    (ev) => ev && (ev.status === "bad" || ev.status === "warn" || ev.status === "error")
  ).length;
  const errorRatePct = Math.round((failedEvents / list.length) * 100);
  const status = errorRatePct >= 40 ? "degraded" : failedEvents > 0 ? "warning" : "clean";

  return {
    totalEvents: list.length,
    failedEvents,
    errorRatePct,
    status,
    summary:
      failedEvents > 0
        ? `Denetim hata oranı: %${errorRatePct} (${failedEvents}/${list.length} olayda hata/uyarı)`
        : `Denetim işlemleri hatasız (${list.length}/${list.length} başarılı)`
  };
}

/**
 * Computes remaining USD budget and safe hourly allowance for the Keysmith failover spending cap.
 */
export function evaluateFailoverCapHeadroomUsd(failoverInfo = {}) {
  const cap = failoverInfo?.cap || null;
  const maxUsd = typeof cap?.max === "number" && cap.max > 0 ? cap.max : null;
  const spentUsd = typeof cap?.spent === "number" && cap.spent >= 0 ? cap.spent : 0;

  if (maxUsd === null) {
    return {
      hasCap: false,
      maxUsd: null,
      spentUsd: null,
      remainingUsd: null,
      safeHourlyAllowanceUsd: null,
      status: "unconfigured",
      summary: "Failover harcama tavanı tanımlı değil"
    };
  }

  const remainingUsd =
    typeof cap?.remaining === "number" && cap.remaining >= 0
      ? Math.round(cap.remaining * 100) / 100
      : Math.max(0, Math.round((maxUsd - spentUsd) * 100) / 100);
  const safeHourlyAllowanceUsd = Math.round((remainingUsd / 8) * 100) / 100;
  const status = remainingUsd <= 2 ? "critical" : remainingUsd <= 5 ? "tight" : "comfortable";

  return {
    hasCap: true,
    maxUsd,
    spentUsd,
    remainingUsd,
    safeHourlyAllowanceUsd,
    status,
    summary: `Kalan bütçe payı: $${remainingUsd.toFixed(2)} (8s seans için güvenli ~$${safeHourlyAllowanceUsd.toFixed(2)}/saat)`
  };
}

/**
 * Evaluates how many enabled Claude accounts are currently below `autoswitch.threshold` in their 5-hour window.
 */
export function evaluateAutoswitchThresholdCompliance(accounts = [], config = {}) {
  const thresholdPct =
    typeof config?.["autoswitch.threshold"] === "number" && config["autoswitch.threshold"] > 0
      ? config["autoswitch.threshold"]
      : 90;
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);

  if (enabled.length === 0) {
    return {
      thresholdPct,
      totalEnabled: 0,
      belowThresholdCount: 0,
      atOrAboveThresholdCount: 0,
      exceedingAccounts: [],
      status: "empty",
      summary: "Etkin hesap yok"
    };
  }

  const exceedingAccounts = [];
  let belowThresholdCount = 0;

  for (const acct of enabled) {
    const five =
      typeof acct?.usage?.fiveHour?.pct === "number"
        ? acct.usage.fiveHour.pct
        : typeof acct?.fiveHourPct === "number"
          ? acct.fiveHourPct
          : 0;
    if (five >= thresholdPct) {
      exceedingAccounts.push(acct.name);
    } else {
      belowThresholdCount += 1;
    }
  }

  const atOrAboveThresholdCount = exceedingAccounts.length;
  const status =
    belowThresholdCount === 0
      ? "all-exceeded"
      : atOrAboveThresholdCount > 0
        ? "partial"
        : "compliant";

  return {
    thresholdPct,
    totalEnabled: enabled.length,
    belowThresholdCount,
    atOrAboveThresholdCount,
    exceedingAccounts,
    status,
    summary:
      atOrAboveThresholdCount > 0
        ? `Eşik uyumu: ${belowThresholdCount}/${enabled.length} hesap %${thresholdPct} altında (aşan: ${exceedingAccounts.join(", ")})`
        : `Tüm hesaplar %${thresholdPct} otomatik geçiş eşiğinin altında (${belowThresholdCount}/${enabled.length})`
  };
}

/**
 * Evaluates idle-to-working reserve capacity ratio across the Traycer agent fleet.
 */
export function evaluateFleetIdleReserveRatio(fleet = {}) {
  if (!fleet || fleet.status === "unreadable" || typeof fleet.working !== "number") {
    return {
      status: "unreadable",
      workingCount: 0,
      idleCount: 0,
      reserveRatioPct: null,
      summary: "Filo yedek kapasite verisi okunamadı"
    };
  }

  const workingCount = Math.max(0, fleet.working || 0);
  const idleCount = Math.max(0, fleet.idle || 0);
  const totalReady = workingCount + idleCount;
  const reserveRatioPct = totalReady > 0 ? Math.round((idleCount / totalReady) * 100) : 0;
  const status = idleCount === 0 && workingCount > 0 ? "saturated" : idleCount > 0 ? "has-reserve" : "empty";

  return {
    status,
    workingCount,
    idleCount,
    reserveRatioPct,
    summary:
      idleCount === 0 && workingCount > 0
        ? `Filo tam kapasite dolu (boşta yedek ajan yok · ${workingCount} aktif)`
        : `Filo yedek kapasitesi: ${idleCount} boşta ajan (%${reserveRatioPct} hazır rezerv)`
  };
}

/**
 * Evaluates average and maximum row count per Status Board section to highlight overcrowded sections.
 */
export function evaluateStatusBoardRowDensity(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  const sectionCount = sections.length;

  if (sectionCount === 0) {
    return {
      sectionCount: 0,
      totalRows: 0,
      avgRowsPerSection: 0,
      maxRowsInSection: 0,
      densestSectionTitle: null,
      status: "empty",
      summary: "Durum panosu bölümü yok"
    };
  }

  let totalRows = 0;
  let maxRowsInSection = 0;
  let densestSectionTitle = null;

  for (const sec of sections) {
    const count = Array.isArray(sec?.rows) ? sec.rows.length : 0;
    totalRows += count;
    if (count > maxRowsInSection) {
      maxRowsInSection = count;
      densestSectionTitle = sec?.title || sec?.id || "Bölüm";
    }
  }

  const avgRowsPerSection = Math.round((totalRows / sectionCount) * 10) / 10;
  const status = maxRowsInSection >= 12 ? "crowded" : maxRowsInSection >= 6 ? "moderate" : "compact";

  return {
    sectionCount,
    totalRows,
    avgRowsPerSection,
    maxRowsInSection,
    densestSectionTitle,
    status,
    summary: `Bölüm yoğunluğu: ort. ${avgRowsPerSection} satır (en yoğun: ${densestSectionTitle || "-"} · ${maxRowsInSection} satır)`
  };
}

/**
 * Summarizes the minimum and average remaining OAuth token validity minutes across enabled Claude accounts.
 */
export function summarizeTokenExpiryHorizon(accounts = []) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  if (enabled.length === 0) {
    return {
      enabledCount: 0,
      validCount: 0,
      minRemainingMinutes: null,
      avgRemainingMinutes: null,
      soonestAccount: null,
      status: "empty",
      summary: "Etkin hesap yok"
    };
  }

  let validCount = 0;
  let sumMin = 0;
  let minRemainingMinutes = null;
  let soonestAccount = null;

  for (const acct of enabled) {
    const remMs = typeof acct?.token?.remainingMs === "number" ? acct.token.remainingMs : null;
    if (remMs !== null && Number.isFinite(remMs)) {
      const mins = Math.max(0, Math.round(remMs / 60000));
      if (acct?.token?.status === "valid" && mins > 0) {
        validCount += 1;
      }
      sumMin += mins;
      if (minRemainingMinutes === null || mins < minRemainingMinutes) {
        minRemainingMinutes = mins;
        soonestAccount = acct.name;
      }
    }
  }

  const avgRemainingMinutes = minRemainingMinutes !== null ? Math.round(sumMin / enabled.length) : null;
  const status =
    minRemainingMinutes === null
      ? "unknown"
      : minRemainingMinutes <= 15
        ? "expiring-soon"
        : minRemainingMinutes <= 60
          ? "watch"
          : "comfortable";

  return {
    enabledCount: enabled.length,
    validCount,
    minRemainingMinutes,
    avgRemainingMinutes,
    soonestAccount,
    status,
    summary:
      minRemainingMinutes !== null
        ? `Token ufku: en yakın ${soonestAccount} (${minRemainingMinutes} dk) · ort. ${avgRemainingMinutes} dk`
        : "Token kalan süre verisi yok"
  };
}

/**
 * Evaluates operational readiness of desktop notifications (`notify.desktop`) and login autostart (`launchAtLogin`).
 */
export function evaluateNotificationAndAutostartPosture(preferences = {}, config = {}) {
  const notifyEnabled =
    typeof preferences?.notify === "boolean"
      ? preferences.notify
      : Boolean(config?.["notify.desktop"]);
  const launchAtLogin = Boolean(preferences?.launchAtLogin);

  const status =
    notifyEnabled && launchAtLogin
      ? "fully-armed"
      : notifyEnabled || launchAtLogin
        ? "partial"
        : "manual";

  return {
    notifyEnabled,
    launchAtLogin,
    status,
    summary: `Otomasyon duruşu: Bildirim ${notifyEnabled ? "açık" : "kapalı"} · Oturumda başlatma ${launchAtLogin ? "etkin" : "kapalı"}`
  };
}

/**
 * Evaluates the average 5-hour quota burn-rate ratio across enabled Claude accounts to determine
 * whether the pool is consuming quota at a sustainable pace (<= 1.0x) or an accelerated pace (> 1.0x).
 */
export function evaluateSustainablePoolBurnRate(quotaForecast = {}) {
  const list = Array.isArray(quotaForecast?.accounts) ? quotaForecast.accounts : [];
  const measured = list.filter((a) => a && typeof a.burnRateRatio === "number" && Number.isFinite(a.burnRateRatio));

  if (measured.length === 0) {
    return {
      measuredCount: 0,
      avgBurnRateRatio: 0,
      maxBurnRateRatio: 0,
      fastestBurningAccount: null,
      sustainable: true,
      status: "idle",
      summary: "Tüketim hızı verisi henüz oluşmadı"
    };
  }

  let sum = 0;
  let maxBurnRateRatio = 0;
  let fastestBurningAccount = null;

  for (const item of measured) {
    sum += item.burnRateRatio;
    if (item.burnRateRatio > maxBurnRateRatio) {
      maxBurnRateRatio = item.burnRateRatio;
      fastestBurningAccount = item.name;
    }
  }

  const avgBurnRateRatio = Math.round((sum / measured.length) * 100) / 100;
  maxBurnRateRatio = Math.round(maxBurnRateRatio * 100) / 100;
  const sustainable = avgBurnRateRatio <= 1.0;
  const status = avgBurnRateRatio > 1.3 ? "unsustainable" : avgBurnRateRatio > 1.0 ? "accelerated" : "sustainable";

  return {
    measuredCount: measured.length,
    avgBurnRateRatio,
    maxBurnRateRatio,
    fastestBurningAccount,
    sustainable,
    status,
    summary: sustainable
      ? `Sürdürülebilir tüketim hızı: ort. ${avgBurnRateRatio}x (dengeli)`
      : `Yüksek tüketim ivmesi: ort. ${avgBurnRateRatio}x (en hızlı: ${fastestBurningAccount} ${maxBurnRateRatio}x)`
  };
}

/**
 * Evaluates the ratio of urgent/critical `owner_needed` items vs normal items in the Status Board.
 */
export function evaluateUrgentOwnerRatio(statusBoard) {
  const owners = Array.isArray(statusBoard?.owner_needed) ? statusBoard.owner_needed : [];
  const totalCount = owners.length;

  if (totalCount === 0) {
    return {
      totalCount: 0,
      urgentCount: 0,
      normalCount: 0,
      urgentRatioPct: 0,
      status: "clear",
      summary: "Bekleyen sahiplik maddesi yok"
    };
  }

  const keywords = ["acil", "kritik", "blocker", "down", "prod", "fatura", "payment", "expired", "süresi doldu", "500", "502", "503"];
  let urgentCount = 0;

  for (const item of owners) {
    const combined = `${item?.project || ""} ${item?.text || ""}`.toLowerCase();
    if (keywords.some((kw) => combined.includes(kw))) {
      urgentCount += 1;
    }
  }

  const normalCount = totalCount - urgentCount;
  const urgentRatioPct = Math.round((urgentCount / totalCount) * 100);
  const status = urgentCount > 0 ? "has-urgent" : "routine-only";

  return {
    totalCount,
    urgentCount,
    normalCount,
    urgentRatioPct,
    status,
    summary:
      urgentCount > 0
        ? `Acil sahiplik oranı: ${urgentCount}/${totalCount} (% ${urgentRatioPct} acil müdahale)`
        : `Tüm sahiplik maddeleri rutin (${totalCount} madde)`
  };
}

/**
 * Summarizes how many daemon-kind local services have an active OS process ID (`pid > 0`).
 */
export function summarizeServiceProcessCoverage(services = []) {
  const list = Array.isArray(services) ? services : [];
  const daemons = list.filter((s) => s && typeof s === "object" && (s.kind === "daemon" || !s.kind));
  const totalDaemons = daemons.length;

  if (totalDaemons === 0) {
    return {
      totalDaemons: 0,
      activePidCount: 0,
      coveragePct: 100,
      missingPidLabels: [],
      status: "none",
      summary: "Daemon türünde izlenen servis yok"
    };
  }

  let activePidCount = 0;
  const missingPidLabels = [];
  for (const svc of daemons) {
    if (typeof svc.pid === "number" && svc.pid > 0) {
      activePidCount += 1;
    } else {
      missingPidLabels.push(svc.title || svc.label || svc.id || "Servis");
    }
  }

  const coveragePct = Math.round((activePidCount / totalDaemons) * 100);
  const status = activePidCount === totalDaemons ? "all-running" : activePidCount > 0 ? "partial" : "down";

  return {
    totalDaemons,
    activePidCount,
    coveragePct,
    missingPidLabels,
    status,
    summary:
      missingPidLabels.length > 0
        ? `Süreç kapsamı: ${activePidCount}/${totalDaemons} daemon PID aktif (eksik: ${missingPidLabels.join(", ")})`
        : `Tüm daemon süreçleri aktif (${activePidCount}/${totalDaemons} PID)`
  };
}

/**
 * Classifies 24-hour failover engagement frequency from `dailyAuditActivity`.
 */
export function evaluateFailoverEngagementFrequency(dailyAuditActivity = {}) {
  const failoverCount =
    typeof dailyAuditActivity?.failoverCount === "number" && dailyAuditActivity.failoverCount >= 0
      ? dailyAuditActivity.failoverCount
      : 0;
  const status =
    failoverCount >= 4 ? "frequent" : failoverCount >= 2 ? "moderate" : failoverCount === 1 ? "single" : "none";

  return {
    failoverCount24h: failoverCount,
    status,
    summary:
      failoverCount === 0
        ? "Son 24 saatte failover tetiklenmedi"
        : `Son 24s failover sıklığı: ${failoverCount} kez (${status === "frequent" ? "yüksek" : "normal"})`
  };
}

/**
 * Summarizes telemetry source diversity (`plugin-json`, `polyctl-quota`, `apicredits`, `none`) across `otherQuotas`.
 */
export function evaluateSecondarySourceDiversity(otherQuotas = []) {
  const list = Array.isArray(otherQuotas) ? otherQuotas : [];
  const counts = {
    pluginJsonCount: 0,
    polyctlQuotaCount: 0,
    apicreditsCount: 0,
    unreadableCount: 0
  };
  const activeSources = new Set();

  for (const q of list) {
    if (!q || typeof q !== "object") continue;
    const src = String(q.source || "none");
    if (src === "plugin-json") {
      counts.pluginJsonCount += 1;
      activeSources.add("plugin-json");
    } else if (src === "polyctl-quota") {
      counts.polyctlQuotaCount += 1;
      activeSources.add("polyctl-quota");
    } else if (src === "apicredits") {
      counts.apicreditsCount += 1;
      activeSources.add("apicredits");
    } else {
      counts.unreadableCount += 1;
    }
  }

  return {
    totalProviders: list.length,
    distinctActiveSources: activeSources.size,
    ...counts,
    summary: `İkincil kaynak dağılımı: ${activeSources.size} aktif kaynak türü (plugin ${counts.pluginJsonCount}, polyctl ${counts.polyctlQuotaCount}, api ${counts.apicreditsCount})`
  };
}

/**
 * Computes the combined 7-day remaining capacity across enabled Claude accounts and identifies
 * the account with the largest weekly reserve.
 */
export function evaluateWeeklyPoolReserveCapacity(accounts = []) {
  const enabled = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.enabled !== false);
  if (enabled.length === 0) {
    return {
      enabledCount: 0,
      totalRemainingSevenDayPct: 0,
      avgRemainingSevenDayPct: 0,
      topReserveAccount: null,
      topReservePct: 0,
      status: "empty",
      summary: "Etkin hesap yok"
    };
  }

  let totalRemainingSevenDayPct = 0;
  let topReserveAccount = null;
  let topReservePct = -1;

  for (const acct of enabled) {
    const seven =
      typeof acct?.usage?.sevenDay?.pct === "number"
        ? acct.usage.sevenDay.pct
        : typeof acct?.sevenDayPct === "number"
          ? acct.sevenDayPct
          : 0;
    const rem = Math.max(0, Math.min(100, 100 - seven));
    totalRemainingSevenDayPct += rem;
    if (rem > topReservePct) {
      topReservePct = rem;
      topReserveAccount = acct.name;
    }
  }

  totalRemainingSevenDayPct = Math.round(totalRemainingSevenDayPct * 10) / 10;
  const avgRemainingSevenDayPct = Math.round((totalRemainingSevenDayPct / enabled.length) * 10) / 10;
  topReservePct = Math.max(0, Math.round(topReservePct * 10) / 10);
  const status = avgRemainingSevenDayPct >= 40 ? "ample" : avgRemainingSevenDayPct >= 15 ? "moderate" : "low";

  return {
    enabledCount: enabled.length,
    totalRemainingSevenDayPct,
    avgRemainingSevenDayPct,
    topReserveAccount,
    topReservePct,
    status,
    summary: `7g havuz rezervi: toplam %${totalRemainingSevenDayPct} boş (ort. %${avgRemainingSevenDayPct} · en geniş: ${topReserveAccount} %${topReservePct})`
  };
}

/**
 * Computes how many Status Board rows have an active `since` duration timestamp and identifies the longest-running state.
 */
export function evaluateStatusBoardSinceCoverage(statusBoard, options = {}) {
  const nowMs =
    typeof options.nowMs === "function" ? options.nowMs() : typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  let totalRows = 0;
  let trackedRows = 0;
  let maxDurationMinutes = null;
  let longestTrackedLabel = null;

  for (const sec of sections) {
    for (const r of sec?.rows || []) {
      totalRows += 1;
      if (r?.since) {
        const ms = Date.parse(String(r.since));
        if (Number.isFinite(ms) && nowMs >= ms) {
          trackedRows += 1;
          const mins = Math.max(1, Math.round((nowMs - ms) / 60000));
          if (maxDurationMinutes === null || mins > maxDurationMinutes) {
            maxDurationMinutes = mins;
            longestTrackedLabel = r.label || sec?.title || "Satır";
          }
        }
      }
    }
  }

  const coveragePct = totalRows > 0 ? Math.round((trackedRows / totalRows) * 100) : 0;

  return {
    totalRows,
    trackedRows,
    coveragePct,
    maxDurationMinutes,
    longestTrackedLabel,
    summary:
      trackedRows > 0
        ? `Süreklilik takibi: ${trackedRows}/${totalRows} satır zaman damgalı (en uzun: ${longestTrackedLabel} · ${maxDurationMinutes} dk)`
        : "Zaman damgalı (since) satır yok"
  };
}

/**
 * Analyzes the 5-hour quota usage spread between the active Claude account and the lowest-used standby enabled account.
 */
export function evaluateActiveVsStandbySpread(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const active = list.find((a) => a && a.isActive);
  const standbys = list.filter((a) => a && a.enabled !== false && !a.isActive && !a.needsReauth);

  if (!active || standbys.length === 0) {
    return {
      activeAccount: active ? active.name || active.id || null : null,
      activeFiveHourPct: active && typeof active.fiveHourPct === "number" ? Math.round(active.fiveHourPct * 10) / 10 : null,
      lowestStandbyAccount: null,
      lowestStandbyFiveHourPct: null,
      spreadPct: 0,
      recommendEarlySwitch: false,
      status: "single_or_no_standby",
      summary: "Aktif/yedek 5s farkı: karşılaştırılabilir yedek hesap yok"
    };
  }

  const activePct = typeof active.fiveHourPct === "number" && Number.isFinite(active.fiveHourPct) ? active.fiveHourPct : 0;
  let lowestStandby = null;
  let lowestPct = Infinity;

  for (const s of standbys) {
    const pct = typeof s.fiveHourPct === "number" && Number.isFinite(s.fiveHourPct) ? s.fiveHourPct : 0;
    if (pct < lowestPct) {
      lowestPct = pct;
      lowestStandby = s.name || s.id || "unknown";
    }
  }

  const spreadPct = Math.round((activePct - lowestPct) * 10) / 10;
  const recommendEarlySwitch = spreadPct >= 30;
  const status = recommendEarlySwitch ? "opportunity" : spreadPct >= 15 ? "moderate" : "balanced";

  return {
    activeAccount: active.name || active.id || "unknown",
    activeFiveHourPct: Math.round(activePct * 10) / 10,
    lowestStandbyAccount: lowestStandby,
    lowestStandbyFiveHourPct: Math.round(lowestPct * 10) / 10,
    spreadPct,
    recommendEarlySwitch,
    status,
    summary: recommendEarlySwitch
      ? `Erken geçiş fırsatı: aktif %${Math.round(activePct)} vs yedek ${lowestStandby} %${Math.round(lowestPct)} (fark %${spreadPct})`
      : `Aktif/yedek 5s farkı: %${spreadPct} (en boş yedek: ${lowestStandby} %${Math.round(lowestPct)})`
  };
}

/**
 * Computes free RAM and free disk percentage on the remote server and Remaining Safety Cushion before reaching the 90% saturation limit.
 */
export function evaluateServerSafetyHeadroom(server) {
  if (!server || server.reachable === false) {
    return {
      reachable: false,
      freeMemoryPct: null,
      freeDiskPct: null,
      memorySafetyCushionPct: null,
      diskSafetyCushionPct: null,
      tightestResource: null,
      status: "unreachable",
      summary: "Sunucu güvenlik payı hesaplanamadı (sunucu erişilemez)"
    };
  }

  const memUsed = typeof server.memoryUsedPct === "number" && Number.isFinite(server.memoryUsedPct) ? server.memoryUsedPct : 0;
  const diskUsed = typeof server.diskUsedPct === "number" && Number.isFinite(server.diskUsedPct) ? server.diskUsedPct : 0;

  const freeMemoryPct = Math.max(0, Math.round((100 - memUsed) * 10) / 10);
  const freeDiskPct = Math.max(0, Math.round((100 - diskUsed) * 10) / 10);
  const memorySafetyCushionPct = Math.round((90 - memUsed) * 10) / 10;
  const diskSafetyCushionPct = Math.round((90 - diskUsed) * 10) / 10;

  const minCushion = Math.min(memorySafetyCushionPct, diskSafetyCushionPct);
  const tightestResource = memorySafetyCushionPct <= diskSafetyCushionPct ? "memory" : "disk";
  const status = minCushion < 0 ? "breached" : minCushion < 15 ? "tight" : "safe";

  return {
    reachable: true,
    freeMemoryPct,
    freeDiskPct,
    memorySafetyCushionPct,
    diskSafetyCushionPct,
    tightestResource,
    status,
    summary: `Sunucu güvenlik payı (%90 sınırına): RAM %${memorySafetyCushionPct} · Disk %${diskSafetyCushionPct} (${status === "safe" ? "güvenli" : status === "tight" ? "dar" : "aşıldı"})`
  };
}

/**
 * Counts auditTimeline events across switch, failover, service, and other categories and reports the dominant operation category.
 */
export function summarizeAuditCategoryBreakdown(auditTimeline) {
  const list = Array.isArray(auditTimeline) ? auditTimeline : [];
  let switchCount = 0;
  let failoverCount = 0;
  let serviceCount = 0;
  let otherCount = 0;

  for (const item of list) {
    const cat = String(item?.category || "").toLowerCase();
    const type = String(item?.type || "").toLowerCase();
    if (cat === "switch" || type.includes("switch")) {
      switchCount += 1;
    } else if (cat === "failover" || type.includes("failover")) {
      failoverCount += 1;
    } else if (cat === "service" || type.includes("service") || type.includes("daemon") || type.includes("restart")) {
      serviceCount += 1;
    } else {
      otherCount += 1;
    }
  }

  const totalEvents = list.length;
  const counts = [
    { name: "switch", count: switchCount },
    { name: "failover", count: failoverCount },
    { name: "service", count: serviceCount },
    { name: "other", count: otherCount }
  ].sort((a, b) => b.count - a.count);

  const dominantCategory = totalEvents > 0 && counts[0].count > 0 ? counts[0].name : "none";

  return {
    totalEvents,
    switchCount,
    failoverCount,
    serviceCount,
    otherCount,
    dominantCategory,
    summary:
      totalEvents > 0
        ? `Denetim dağılımı (${totalEvents}): geçiş ${switchCount} · failover ${failoverCount} · servis ${serviceCount} · diğer ${otherCount} (baskın: ${dominantCategory})`
        : "Denetim kaydı yok"
  };
}

/**
 * Computes average, minimum, and maximum 5-hour quota utilization across enabled Claude accounts.
 */
export function evaluatePoolAverageFiveHourUtilization(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const enabled = list.filter((a) => a && a.enabled !== false && !a.needsReauth);
  if (enabled.length === 0) {
    return {
      enabledCount: 0,
      avgFiveHourPct: 0,
      maxFiveHourPct: 0,
      minFiveHourPct: 0,
      status: "empty",
      summary: "5s havuz ortalaması: etkin hesap yok"
    };
  }

  let sum = 0;
  let maxPct = 0;
  let minPct = Infinity;

  for (const acc of enabled) {
    const pct = typeof acc.fiveHourPct === "number" && Number.isFinite(acc.fiveHourPct) ? Math.max(0, Math.min(100, acc.fiveHourPct)) : 0;
    sum += pct;
    if (pct > maxPct) maxPct = pct;
    if (pct < minPct) minPct = pct;
  }

  if (!Number.isFinite(minPct)) minPct = 0;
  const avgFiveHourPct = Math.round((sum / enabled.length) * 10) / 10;
  maxPct = Math.round(maxPct * 10) / 10;
  minPct = Math.round(minPct * 10) / 10;
  const status = avgFiveHourPct >= 80 ? "high" : avgFiveHourPct >= 50 ? "moderate" : "low";

  return {
    enabledCount: enabled.length,
    avgFiveHourPct,
    maxFiveHourPct: maxPct,
    minFiveHourPct: minPct,
    status,
    summary: `5s havuz ortalaması: %${avgFiveHourPct} kullanım (min %${minPct} · maks %${maxPct})`
  };
}

/**
 * Computes the ratio of early-warning (warn) rows vs critical (bad) rows across Status Board sections.
 */
export function evaluateStatusBoardWarningToBadRatio(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  let warnCount = 0;
  let badCount = 0;

  for (const sec of sections) {
    for (const r of sec?.rows || []) {
      const st = String(r?.status || "").toLowerCase();
      if (st === "warn") warnCount += 1;
      else if (st === "bad") badCount += 1;
    }
  }

  const totalProblemRows = warnCount + badCount;
  const earlyWarningRatioPct = totalProblemRows > 0 ? Math.round((warnCount / totalProblemRows) * 100) : 100;
  const status = badCount > 0 ? "critical_present" : warnCount > 0 ? "warnings_only" : "clean";

  return {
    warnCount,
    badCount,
    totalProblemRows,
    earlyWarningRatioPct,
    status,
    summary:
      totalProblemRows > 0
        ? `Sorun satırı dengesi: ${warnCount} uyarı / ${badCount} kritik (%${earlyWarningRatioPct} erken uyarı)`
        : "Sorunlu (warn/bad) satır yok"
  };
}

/**
 * Summarizes desktop.autoRestart setting and pending desktop restart posture.
 */
export function evaluateDaemonAutoRestartPosture(config, desktopRestartSafety) {
  const autoRestartEnabled = Boolean(config && config["desktop.autoRestart"]);
  const pendingRestart = Boolean(desktopRestartSafety && desktopRestartSafety.pendingRestart);
  const safeToRestart = desktopRestartSafety ? Boolean(desktopRestartSafety.safeToRestart) : true;
  const status = pendingRestart
    ? safeToRestart
      ? "pending_ready"
      : "pending_deferred"
    : autoRestartEnabled
      ? "armed"
      : "manual_only";

  return {
    autoRestartEnabled,
    pendingRestart,
    safeToRestart,
    status,
    summary: pendingRestart
      ? `Masaüstü yeniden başlatma bekliyor (${safeToRestart ? "uygun" : "ertelendi"})`
      : `Masaüstü oto-yeniden başlatma: ${autoRestartEnabled ? "açık" : "manuel"}`
  };
}

/**
 * Summarizes Keysmith gateway probe readiness and failover chain status.
 */
export function evaluateFailoverGatewayReadiness(failover) {
  const f = failover || {};
  const enabled = Boolean(f.enabled);
  const gatewayReady = Boolean(f.gatewayReady);
  const gatewayReason = f.gatewayReason ? String(f.gatewayReason) : gatewayReady ? "ok" : "unprobed";
  const engaged = Boolean(f.engaged);
  const status = gatewayReady ? (engaged ? "engaged_ready" : "standby_ready") : enabled ? "degraded" : "disabled";

  return {
    enabled,
    gatewayReady,
    gatewayReason,
    engaged,
    status,
    summary: gatewayReady
      ? `Failover ağ geçidi hazır (${engaged ? "aktif devrede" : "beklemede"})`
      : enabled
        ? `Failover ağ geçidi hazır değil (${gatewayReason})`
        : "Failover devre dışı"
  };
}

/**
 * Computes the ratio of active+idle (live) agents vs dormant agents in the Traycer fleet.
 */
export function evaluateFleetActiveVsDormantRatio(fleet) {
  if (!fleet || fleet.readable === false) {
    return {
      readable: false,
      liveCount: 0,
      dormantCount: 0,
      totalCount: 0,
      liveRatioPct: null,
      status: "unreadable",
      summary: "Filo canlı/uyuyan oranı okunamadı"
    };
  }

  const active = typeof fleet.active === "number" && Number.isFinite(fleet.active) ? Math.max(0, fleet.active) : 0;
  const idle = typeof fleet.idle === "number" && Number.isFinite(fleet.idle) ? Math.max(0, fleet.idle) : 0;
  const dormant = typeof fleet.dormant === "number" && Number.isFinite(fleet.dormant) ? Math.max(0, fleet.dormant) : 0;
  const liveCount = active + idle;
  const totalCount = liveCount + dormant;
  const liveRatioPct = totalCount > 0 ? Math.round((liveCount / totalCount) * 100) : 0;
  const status = totalCount === 0 ? "empty" : liveRatioPct >= 50 ? "mostly_live" : "mostly_dormant";

  return {
    readable: true,
    liveCount,
    dormantCount: dormant,
    totalCount,
    liveRatioPct,
    status,
    summary:
      totalCount > 0
        ? `Filo canlılık oranı: ${liveCount} canlı / ${dormant} uyuyan (%${liveRatioPct} hazır/aktif)`
        : "Filo ajanı kayıtlı değil"
  };
}

/**
 * Computes the count and percentage of standby (non-active, enabled) Claude accounts that are healthy and below 70% usage.
 */
export function evaluatePoolHealthyStandbyRatio(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const standbys = list.filter((a) => a && a.enabled !== false && !a.isActive);
  if (standbys.length === 0) {
    return {
      totalStandbyCount: 0,
      healthyStandbyCount: 0,
      healthyStandbyRatioPct: 0,
      status: "no_standby",
      summary: "Yedek hesap sağlığı: etkin yedek hesap yok"
    };
  }

  let healthyStandbyCount = 0;
  for (const s of standbys) {
    const fivePct = typeof s.fiveHourPct === "number" && Number.isFinite(s.fiveHourPct) ? s.fiveHourPct : 0;
    const sevenPct = typeof s?.usage?.sevenDay?.pct === "number" && Number.isFinite(s.usage.sevenDay.pct)
      ? s.usage.sevenDay.pct
      : typeof s.sevenDayPct === "number" && Number.isFinite(s.sevenDayPct)
        ? s.sevenDayPct
        : 0;
    if (!s.needsReauth && fivePct < 70 && sevenPct < 70) {
      healthyStandbyCount += 1;
    }
  }

  const healthyStandbyRatioPct = Math.round((healthyStandbyCount / standbys.length) * 100);
  const status = healthyStandbyCount === standbys.length ? "all_healthy" : healthyStandbyCount > 0 ? "partial" : "depleted";

  return {
    totalStandbyCount: standbys.length,
    healthyStandbyCount,
    healthyStandbyRatioPct,
    status,
    summary: `Sağlıklı yedek oranı: ${healthyStandbyCount}/${standbys.length} yedek hesap hazır (<%70 kota · %${healthyStandbyRatioPct})`
  };
}

/**
 * Computes how many distinct Status Board sections have at least one bad or warn row.
 */
export function evaluateStatusBoardSectionAlertSpread(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  if (sections.length === 0) {
    return {
      totalSections: 0,
      affectedSectionCount: 0,
      spreadPct: 0,
      mostImpactedSectionTitle: null,
      status: "empty",
      summary: "Bölüm uyarı yayılımı: bölüm yok"
    };
  }

  let affectedSectionCount = 0;
  let maxIssues = 0;
  let mostImpactedSectionTitle = null;

  for (const sec of sections) {
    let secIssues = 0;
    for (const r of sec?.rows || []) {
      const st = String(r?.status || "").toLowerCase();
      if (st === "bad" || st === "warn") {
        secIssues += 1;
      }
    }
    if (secIssues > 0) {
      affectedSectionCount += 1;
      if (secIssues > maxIssues) {
        maxIssues = secIssues;
        mostImpactedSectionTitle = sec?.title || sec?.id || "Bölüm";
      }
    }
  }

  const spreadPct = Math.round((affectedSectionCount / sections.length) * 100);
  const status = affectedSectionCount === 0 ? "clean" : spreadPct >= 50 ? "widespread" : "localized";

  return {
    totalSections: sections.length,
    affectedSectionCount,
    spreadPct,
    mostImpactedSectionTitle,
    status,
    summary:
      affectedSectionCount > 0
        ? `Bölüm uyarı yayılımı: ${affectedSectionCount}/${sections.length} bölüm etkileniyor (%${spreadPct} · en yoğun: ${mostImpactedSectionTitle})`
        : `Bölüm uyarı yayılımı: 0/${sections.length} bölüm sorunsuz`
  };
}

/**
 * Parses server.load (1m / 5m / 15m) to determine whether remote server load is rising, falling, or steady.
 */
export function evaluateServerLoadTrend(server) {
  const rawLoad = server && typeof server.load === "string" ? server.load.trim() : "";
  if (!server || server.reachable === false || !rawLoad || rawLoad === "okunamadı") {
    return {
      parsed: false,
      load1m: null,
      load5m: null,
      load15m: null,
      delta1mTo15m: null,
      trend: "unknown",
      summary: "Sunucu yük eğilimi okunamadı"
    };
  }

  const nums = rawLoad
    .split(/[\s,/]+/)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n));

  if (nums.length < 3) {
    return {
      parsed: false,
      load1m: nums[0] ?? null,
      load5m: nums[1] ?? null,
      load15m: null,
      delta1mTo15m: null,
      trend: "unknown",
      summary: "Sunucu yük eğilimi ayrıştırılamadı"
    };
  }

  const [l1, l5, l15] = nums;
  const delta1mTo15m = Math.round((l1 - l15) * 100) / 100;
  const trend = delta1mTo15m >= 0.25 ? "rising" : delta1mTo15m <= -0.25 ? "falling" : "steady";
  const trendLabel = trend === "rising" ? "yükselişte" : trend === "falling" ? "düşüşte" : "dengeli";

  return {
    parsed: true,
    load1m: l1,
    load5m: l5,
    load15m: l15,
    delta1mTo15m,
    trend,
    summary: `Yük eğilimi (1d/15d): ${l1.toFixed(2)} → ${l15.toFixed(2)} (${trendLabel})`
  };
}

/**
 * Computes the count and percentage of readable secondary quota providers in warning or exhausted state.
 */
export function evaluateSecondaryQuotaWarningRatio(otherQuotas) {
  const list = Array.isArray(otherQuotas) ? otherQuotas : [];
  let readableCount = 0;
  let warningCount = 0;
  let exhaustedCount = 0;

  for (const item of list) {
    const st = String(item?.status || "").toLowerCase();
    if (st === "ok" || st === "warning" || st === "exhausted") {
      readableCount += 1;
      if (st === "warning") warningCount += 1;
      else if (st === "exhausted") exhaustedCount += 1;
    }
  }

  const atRiskCount = warningCount + exhaustedCount;
  const atRiskRatioPct = readableCount > 0 ? Math.round((atRiskCount / readableCount) * 100) : 0;
  const status = readableCount === 0 ? "unreadable" : exhaustedCount > 0 ? "critical" : warningCount > 0 ? "warning" : "healthy";

  return {
    readableCount,
    warningCount,
    exhaustedCount,
    atRiskCount,
    atRiskRatioPct,
    status,
    summary:
      readableCount > 0
        ? `İkincil kota risk oranı: ${atRiskCount}/${readableCount} sağlayıcı uyarıda/tükendi (%${atRiskRatioPct})`
        : "İkincil kota risk oranı okunamadı"
  };
}

/**
 * Summarizes daemon active warning count and runtime posture.
 */
export function evaluateDaemonActiveWarningPosture(daemonRunning, warnings) {
  const running = daemonRunning !== false;
  const list = Array.isArray(warnings) ? warnings : [];
  const warningCount = list.length;
  const status = !running ? "offline" : warningCount > 0 ? "warnings_active" : "clean_online";

  return {
    daemonRunning: running,
    warningCount,
    status,
    summary: !running
      ? "Daemon çevrimdışı"
      : warningCount > 0
        ? `Daemon çevrimiçi (${warningCount} aktif uyarı)`
        : "Daemon çevrimiçi ve uyarısız"
  };
}

/**
 * Computes the 7-day utilization spread between the highest-used and lowest-used enabled Claude accounts.
 */
export function evaluatePoolPeakVsFloorSpread(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const enabled = list.filter((a) => a && a.enabled !== false && !a.needsReauth);
  if (enabled.length < 2) {
    return {
      enabledCount: enabled.length,
      maxSevenDayPct: 0,
      minSevenDayPct: 0,
      spreadSevenDayPct: 0,
      highestAccount: null,
      lowestAccount: null,
      status: "insufficient_accounts",
      summary: "7g tavan/taban farkı: karşılaştırma için en az 2 etkin hesap gerekli"
    };
  }

  let maxPct = -Infinity;
  let minPct = Infinity;
  let highestAccount = null;
  let lowestAccount = null;

  for (const acc of enabled) {
    const pct =
      typeof acc?.usage?.sevenDay?.pct === "number" && Number.isFinite(acc.usage.sevenDay.pct)
        ? acc.usage.sevenDay.pct
        : typeof acc.sevenDayPct === "number" && Number.isFinite(acc.sevenDayPct)
          ? acc.sevenDayPct
          : 0;
    if (pct > maxPct) {
      maxPct = pct;
      highestAccount = acc.name || acc.id || "unknown";
    }
    if (pct < minPct) {
      minPct = pct;
      lowestAccount = acc.name || acc.id || "unknown";
    }
  }

  maxPct = Math.round(maxPct * 10) / 10;
  minPct = Math.round(minPct * 10) / 10;
  const spreadSevenDayPct = Math.round((maxPct - minPct) * 10) / 10;
  const status = spreadSevenDayPct >= 40 ? "skewed" : spreadSevenDayPct >= 20 ? "moderate" : "balanced";

  return {
    enabledCount: enabled.length,
    maxSevenDayPct: maxPct,
    minSevenDayPct: minPct,
    spreadSevenDayPct,
    highestAccount,
    lowestAccount,
    status,
    summary: `7g tavan/taban makası: %${spreadSevenDayPct} (${highestAccount} %${maxPct} vs ${lowestAccount} %${minPct})`
  };
}

/**
 * Computes the exact count and percentage of 'ok' rows across all Status Board rows.
 */
export function evaluateStatusBoardHealthyRowRatio(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  let totalRows = 0;
  let okCount = 0;

  for (const sec of sections) {
    for (const r of sec?.rows || []) {
      totalRows += 1;
      if (String(r?.status || "").toLowerCase() === "ok") {
        okCount += 1;
      }
    }
  }

  const healthyRatioPct = totalRows > 0 ? Math.round((okCount / totalRows) * 100) : 100;
  const status = totalRows === 0 ? "empty" : healthyRatioPct >= 85 ? "strong" : healthyRatioPct >= 60 ? "moderate" : "degraded";

  return {
    totalRows,
    okCount,
    healthyRatioPct,
    status,
    summary:
      totalRows > 0
        ? `Sağlıklı satır oranı: ${okCount}/${totalRows} satır OK (%${healthyRatioPct})`
        : "Durum panosunda satır yok"
  };
}

/**
 * Computes how many monitored local services have a clean last exit code (lastExit === 0 or null while running).
 */
export function evaluateServiceZeroExitRatio(services) {
  const list = Array.isArray(services) ? services : [];
  if (list.length === 0) {
    return {
      totalServices: 0,
      cleanExitCount: 0,
      nonZeroExitCount: 0,
      cleanExitRatioPct: 100,
      nonZeroLabels: [],
      status: "empty",
      summary: "Servis çıkış kodu oranı: izlenen servis yok"
    };
  }

  let cleanExitCount = 0;
  const nonZeroLabels = [];

  for (const s of list) {
    const code = s?.lastExit;
    if (code === 0 || code === null || code === undefined) {
      cleanExitCount += 1;
    } else {
      nonZeroLabels.push(`${s.label || "servis"}(${code})`);
    }
  }

  const nonZeroExitCount = list.length - cleanExitCount;
  const cleanExitRatioPct = Math.round((cleanExitCount / list.length) * 100);
  const status = nonZeroExitCount === 0 ? "all_clean" : cleanExitRatioPct >= 75 ? "minor_errors" : "degraded";

  return {
    totalServices: list.length,
    cleanExitCount,
    nonZeroExitCount,
    cleanExitRatioPct,
    nonZeroLabels,
    status,
    summary:
      nonZeroExitCount === 0
        ? `Servis çıkış kodları: ${cleanExitCount}/${list.length} hatasız (exit 0 · %100)`
        : `Servis çıkış kodları: ${nonZeroExitCount}/${list.length} hatalı çıkış (${nonZeroLabels.join(", ")})`
  };
}

/**
 * Estimates how many standard 2-hour coding sessions ($3.00 each) remain within the daily failover spend cap.
 */
export function evaluateFailoverRemainingSessionsEstimate(failover) {
  const f = failover || {};
  const capUsd = typeof f.dailyCapUsd === "number" && Number.isFinite(f.dailyCapUsd) && f.dailyCapUsd > 0 ? f.dailyCapUsd : 15;
  const spentUsd = typeof f.dailySpentUsd === "number" && Number.isFinite(f.dailySpentUsd) && f.dailySpentUsd >= 0 ? f.dailySpentUsd : 0;
  const remainingUsd = Math.max(0, Math.round((capUsd - spentUsd) * 100) / 100);
  const sessionCostUsd = 3.0;
  const estimatedTwoHourSessions = Math.round((remainingUsd / sessionCostUsd) * 10) / 10;
  const status = estimatedTwoHourSessions >= 3 ? "ample" : estimatedTwoHourSessions >= 1 ? "limited" : "exhausted";

  return {
    remainingUsd,
    sessionCostUsd,
    estimatedTwoHourSessions,
    status,
    summary: `Failover seans kapasitesi: ~%${Math.round((remainingUsd / capUsd) * 100)} bütçe ile ~${estimatedTwoHourSessions} adet 2s seans ($${remainingUsd.toFixed(2)} kalan)`
  };
}

/**
 * Counts consecutive successful (status === 'ok') events from the start of auditTimeline.
 */
export function evaluateAuditRecentSuccessStreak(auditTimeline) {
  const list = Array.isArray(auditTimeline) ? auditTimeline : [];
  let streakCount = 0;

  for (const item of list) {
    const st = String(item?.status || "ok").toLowerCase();
    if (st === "ok" || st === "success" || st === "good") {
      streakCount += 1;
    } else {
      break;
    }
  }

  const totalEvents = list.length;
  const status = totalEvents === 0 ? "empty" : streakCount === totalEvents ? "unbroken" : streakCount >= 5 ? "solid" : "interrupted";

  return {
    totalEvents,
    streakCount,
    status,
    summary:
      totalEvents > 0
        ? `Denetim başarı serisi: son ${streakCount}/${totalEvents} işlem kesintisiz başarılı`
        : "Denetim başarı serisi: kayıt yok"
  };
}

/**
 * Computes the count and percentage of enabled Claude accounts that have comfortable headroom (<50% in both 5h and 7d windows).
 */
export function evaluatePoolLowUtilizationAccountRatio(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const enabled = list.filter((a) => a && a.enabled !== false && !a.needsReauth);
  if (enabled.length === 0) {
    return {
      enabledCount: 0,
      lowUtilCount: 0,
      lowUtilRatioPct: 0,
      status: "empty",
      summary: "Ferah hesap oranı: etkin hesap yok"
    };
  }

  let lowUtilCount = 0;
  for (const acc of enabled) {
    const fivePct = typeof acc.fiveHourPct === "number" && Number.isFinite(acc.fiveHourPct) ? acc.fiveHourPct : 0;
    const sevenPct =
      typeof acc?.usage?.sevenDay?.pct === "number" && Number.isFinite(acc.usage.sevenDay.pct)
        ? acc.usage.sevenDay.pct
        : typeof acc.sevenDayPct === "number" && Number.isFinite(acc.sevenDayPct)
          ? acc.sevenDayPct
          : 0;
    if (fivePct < 50 && sevenPct < 50) {
      lowUtilCount += 1;
    }
  }

  const lowUtilRatioPct = Math.round((lowUtilCount / enabled.length) * 100);
  const status = lowUtilRatioPct >= 50 ? "ample_fresh" : lowUtilCount > 0 ? "some_fresh" : "all_loaded";

  return {
    enabledCount: enabled.length,
    lowUtilCount,
    lowUtilRatioPct,
    status,
    summary: `Ferah hesap oranı (<%50 5s/7g): ${lowUtilCount}/${enabled.length} hesap (%${lowUtilRatioPct})`
  };
}

/**
 * Computes the percentage of Status Board rows that carry non-empty detail context.
 */
export function evaluateStatusBoardDetailCoverage(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  let totalRows = 0;
  let detailedRows = 0;

  for (const sec of sections) {
    for (const r of sec?.rows || []) {
      totalRows += 1;
      if (typeof r?.detail === "string" && r.detail.trim().length > 0) {
        detailedRows += 1;
      }
    }
  }

  const coveragePct = totalRows > 0 ? Math.round((detailedRows / totalRows) * 100) : 0;
  const status = totalRows === 0 ? "empty" : coveragePct >= 60 ? "rich" : coveragePct >= 30 ? "moderate" : "sparse";

  return {
    totalRows,
    detailedRows,
    coveragePct,
    status,
    summary:
      totalRows > 0
        ? `Detay açıklama kapsamı: ${detailedRows}/${totalRows} satır detaylı (%${coveragePct})`
        : "Durum panosunda satır yok"
  };
}

/**
 * Computes the spread between memoryUsedPct and diskUsedPct on the remote server and identifies the primary bottleneck resource.
 */
export function evaluateServerResourceBalance(server) {
  if (!server || server.reachable === false) {
    return {
      reachable: false,
      memoryUsedPct: null,
      diskUsedPct: null,
      spreadPct: null,
      dominantResource: null,
      status: "unreachable",
      summary: "Sunucu kaynak dengesi okunamadı"
    };
  }

  const mem = typeof server.memoryUsedPct === "number" && Number.isFinite(server.memoryUsedPct) ? server.memoryUsedPct : 0;
  const disk = typeof server.diskUsedPct === "number" && Number.isFinite(server.diskUsedPct) ? server.diskUsedPct : 0;
  const spreadPct = Math.round(Math.abs(mem - disk) * 10) / 10;
  const dominantResource = Math.abs(mem - disk) < 5 ? "balanced" : mem > disk ? "memory" : "disk";
  const status = spreadPct >= 25 ? "skewed" : "balanced";

  return {
    reachable: true,
    memoryUsedPct: Math.round(mem * 10) / 10,
    diskUsedPct: Math.round(disk * 10) / 10,
    spreadPct,
    dominantResource,
    status,
    summary: `Kaynak dengesi: RAM %${Math.round(mem)} vs Disk %${Math.round(disk)} (fark %${spreadPct} · baskın: ${dominantResource})`
  };
}

/**
 * Computes the count and percentage of readable secondary quota providers in healthy ('ok') state.
 */
export function evaluateSecondaryQuotaHealthyRatio(otherQuotas) {
  const list = Array.isArray(otherQuotas) ? otherQuotas : [];
  let readableCount = 0;
  let okCount = 0;

  for (const item of list) {
    const st = String(item?.status || "").toLowerCase();
    if (st === "ok" || st === "warning" || st === "exhausted") {
      readableCount += 1;
      if (st === "ok") okCount += 1;
    }
  }

  const healthyRatioPct = readableCount > 0 ? Math.round((okCount / readableCount) * 100) : 0;
  const status = readableCount === 0 ? "unreadable" : healthyRatioPct === 100 ? "all_ok" : healthyRatioPct >= 50 ? "partial_ok" : "low_ok";

  return {
    readableCount,
    okCount,
    healthyRatioPct,
    status,
    summary:
      readableCount > 0
        ? `İkincil kota sağlık oranı: ${okCount}/${readableCount} sağlayıcı OK (%${healthyRatioPct})`
        : "İkincil kota sağlık oranı okunamadı"
  };
}

/**
 * Summarizes the ratio of working (active) agents vs waiting (idle) agents in the Traycer fleet.
 */
export function evaluateFleetActiveToIdleBalance(fleet) {
  if (!fleet || fleet.readable === false) {
    return {
      readable: false,
      activeCount: 0,
      idleCount: 0,
      liveTotal: 0,
      activeSharePct: null,
      status: "unreadable",
      summary: "Filo aktif/boşta dengesi okunamadı"
    };
  }

  const activeCount = typeof fleet.active === "number" && Number.isFinite(fleet.active) ? Math.max(0, fleet.active) : 0;
  const idleCount = typeof fleet.idle === "number" && Number.isFinite(fleet.idle) ? Math.max(0, fleet.idle) : 0;
  const liveTotal = activeCount + idleCount;
  const activeSharePct = liveTotal > 0 ? Math.round((activeCount / liveTotal) * 100) : 0;
  const status = liveTotal === 0 ? "no_live" : activeSharePct >= 75 ? "busy" : activeSharePct >= 25 ? "balanced" : "mostly_idle";

  return {
    readable: true,
    activeCount,
    idleCount,
    liveTotal,
    activeSharePct,
    status,
    summary:
      liveTotal > 0
        ? `Aktif/boşta ajan dengesi: ${activeCount} aktif / ${idleCount} boşta (%${activeSharePct} aktif)`
        : "Canlı (aktif/boşta) ajan yok"
  };
}

/**
 * Computes the total and average remaining 5-hour quota headroom across enabled Claude accounts.
 */
export function evaluatePoolCombinedFiveHourHeadroom(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const enabled = list.filter((a) => a && a.enabled !== false && !a.needsReauth);
  if (enabled.length === 0) {
    return {
      enabledCount: 0,
      totalRemainingFiveHourPct: 0,
      avgRemainingFiveHourPct: 0,
      topHeadroomAccount: null,
      topHeadroomPct: 0,
      status: "empty",
      summary: "5s toplam boş kapasite: etkin hesap yok"
    };
  }

  let totalRemaining = 0;
  let topHeadroomAccount = null;
  let topHeadroomPct = -1;

  for (const acc of enabled) {
    const used = typeof acc.fiveHourPct === "number" && Number.isFinite(acc.fiveHourPct) ? Math.max(0, Math.min(100, acc.fiveHourPct)) : 0;
    const rem = Math.max(0, 100 - used);
    totalRemaining += rem;
    if (rem > topHeadroomPct) {
      topHeadroomPct = rem;
      topHeadroomAccount = acc.name || acc.id || "unknown";
    }
  }

  totalRemaining = Math.round(totalRemaining * 10) / 10;
  const avgRemainingFiveHourPct = Math.round((totalRemaining / enabled.length) * 10) / 10;
  topHeadroomPct = Math.max(0, Math.round(topHeadroomPct * 10) / 10);
  const status = avgRemainingFiveHourPct >= 50 ? "ample" : avgRemainingFiveHourPct >= 25 ? "moderate" : "tight";

  return {
    enabledCount: enabled.length,
    totalRemainingFiveHourPct: totalRemaining,
    avgRemainingFiveHourPct,
    topHeadroomAccount,
    topHeadroomPct,
    status,
    summary: `5s toplam boş kapasite: %${totalRemaining} (ort. %${avgRemainingFiveHourPct} · en ferah: ${topHeadroomAccount} %${topHeadroomPct})`
  };
}

/**
 * Computes the percentage of Status Board rows specifically in critical ('bad') state and identifies the section with the most critical rows.
 */
export function evaluateStatusBoardCriticalRowDensity(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  let totalRows = 0;
  let badCount = 0;
  let maxSectionBad = 0;
  let worstSectionTitle = null;

  for (const sec of sections) {
    let secBad = 0;
    for (const r of sec?.rows || []) {
      totalRows += 1;
      if (String(r?.status || "").toLowerCase() === "bad") {
        badCount += 1;
        secBad += 1;
      }
    }
    if (secBad > maxSectionBad) {
      maxSectionBad = secBad;
      worstSectionTitle = sec?.title || sec?.id || "Bölüm";
    }
  }

  const criticalDensityPct = totalRows > 0 ? Math.round((badCount / totalRows) * 100) : 0;
  const status = badCount === 0 ? "zero_critical" : criticalDensityPct >= 25 ? "high_critical" : "low_critical";

  return {
    totalRows,
    badCount,
    criticalDensityPct,
    worstSectionTitle,
    status,
    summary:
      badCount > 0
        ? `Kritik satır yoğunluğu: ${badCount}/${totalRows} satır BAD (%${criticalDensityPct} · odak: ${worstSectionTitle})`
        : `Kritik satır yoğunluğu: 0/${totalRows} satır (kritik hata yok)`
  };
}

/**
 * Computes how many monitored local services have a non-empty lastLogLine entry.
 */
export function evaluateServiceLogPresenceRatio(services) {
  const list = Array.isArray(services) ? services : [];
  if (list.length === 0) {
    return {
      totalServices: 0,
      withLogCount: 0,
      presenceRatioPct: 0,
      status: "empty",
      summary: "Servis log kapsamı: izlenen servis yok"
    };
  }

  let withLogCount = 0;
  for (const s of list) {
    if (typeof s?.lastLogLine === "string" && s.lastLogLine.trim().length > 0 && s.lastLogLine.trim() !== "okunamadı") {
      withLogCount += 1;
    }
  }

  const presenceRatioPct = Math.round((withLogCount / list.length) * 100);
  const status = presenceRatioPct >= 80 ? "complete" : presenceRatioPct >= 40 ? "partial" : "sparse";

  return {
    totalServices: list.length,
    withLogCount,
    presenceRatioPct,
    status,
    summary: `Servis log kapsamı: ${withLogCount}/${list.length} serviste son log satırı mevcut (%${presenceRatioPct})`
  };
}

/**
 * Classifies daily failover spend into zero, light, moderate, or heavy utilization bands.
 */
export function evaluateFailoverBudgetUtilizationBand(failover) {
  const f = failover || {};
  const capUsd = typeof f.dailyCapUsd === "number" && Number.isFinite(f.dailyCapUsd) && f.dailyCapUsd > 0 ? f.dailyCapUsd : 15;
  const spentUsd = typeof f.dailySpentUsd === "number" && Number.isFinite(f.dailySpentUsd) && f.dailySpentUsd >= 0 ? f.dailySpentUsd : 0;
  const utilizationPct = Math.round((spentUsd / capUsd) * 1000) / 10;
  const band = spentUsd === 0 ? "zero" : utilizationPct < 25 ? "light" : utilizationPct < 75 ? "moderate" : "heavy";
  const bandLabel = band === "zero" ? "sıfır" : band === "light" ? "düşük" : band === "moderate" ? "orta" : "yoğun";

  return {
    spentUsd: Math.round(spentUsd * 100) / 100,
    capUsd,
    utilizationPct,
    band,
    summary: `Failover bütçe bandı: ${bandLabel} ($${spentUsd.toFixed(2)} / $${capUsd.toFixed(2)} · %${utilizationPct})`
  };
}

/**
 * Computes the percentage of auditTimeline events that include descriptive detail text.
 */
export function evaluateAuditDetailRichness(auditTimeline) {
  const list = Array.isArray(auditTimeline) ? auditTimeline : [];
  if (list.length === 0) {
    return {
      totalEvents: 0,
      withDetailCount: 0,
      richnessPct: 0,
      status: "empty",
      summary: "Denetim detay zenginliği: kayıt yok"
    };
  }

  let withDetailCount = 0;
  for (const item of list) {
    if (typeof item?.detail === "string" && item.detail.trim().length > 0) {
      withDetailCount += 1;
    }
  }

  const richnessPct = Math.round((withDetailCount / list.length) * 100);
  const status = richnessPct >= 75 ? "high" : richnessPct >= 40 ? "moderate" : "low";

  return {
    totalEvents: list.length,
    withDetailCount,
    richnessPct,
    status,
    summary: `Denetim detay zenginliği: ${withDetailCount}/${list.length} olay açıklamalı (%${richnessPct})`
  };
}

/**
 * Computes the average, minimum, and maximum 7-day quota utilization across enabled Claude accounts.
 */
export function evaluatePoolSevenDayAverageUtilization(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const enabled = list.filter((a) => a && a.enabled !== false && !a.needsReauth);
  if (enabled.length === 0) {
    return {
      enabledCount: 0,
      avgSevenDayPct: 0,
      minSevenDayPct: 0,
      maxSevenDayPct: 0,
      status: "empty",
      summary: "7g havuz ortalaması: etkin hesap yok"
    };
  }

  let sum = 0;
  let minPct = Infinity;
  let maxPct = 0;

  for (const acc of enabled) {
    const pct =
      typeof acc?.usage?.sevenDay?.pct === "number" && Number.isFinite(acc.usage.sevenDay.pct)
        ? Math.max(0, Math.min(100, acc.usage.sevenDay.pct))
        : typeof acc.sevenDayPct === "number" && Number.isFinite(acc.sevenDayPct)
          ? Math.max(0, Math.min(100, acc.sevenDayPct))
          : 0;
    sum += pct;
    if (pct < minPct) minPct = pct;
    if (pct > maxPct) maxPct = pct;
  }

  if (!Number.isFinite(minPct)) minPct = 0;
  const avgSevenDayPct = Math.round((sum / enabled.length) * 10) / 10;
  minPct = Math.round(minPct * 10) / 10;
  maxPct = Math.round(maxPct * 10) / 10;
  const status = avgSevenDayPct >= 80 ? "high" : avgSevenDayPct >= 50 ? "moderate" : "low";

  return {
    enabledCount: enabled.length,
    avgSevenDayPct,
    minSevenDayPct: minPct,
    maxSevenDayPct: maxPct,
    status,
    summary: `7g havuz ortalaması: %${avgSevenDayPct} kullanım (min %${minPct} · maks %${maxPct})`
  };
}

/**
 * Computes the count and percentage of Status Board sections that have zero critical ('bad') rows.
 */
export function evaluateStatusBoardZeroBadSectionRatio(statusBoard) {
  const sections = Array.isArray(statusBoard?.sections) ? statusBoard.sections : [];
  if (sections.length === 0) {
    return {
      totalSections: 0,
      zeroBadSectionCount: 0,
      zeroBadRatioPct: 100,
      status: "empty",
      summary: "Kritiksiz bölüm oranı: bölüm yok"
    };
  }

  let zeroBadSectionCount = 0;
  for (const sec of sections) {
    const hasBad = (sec?.rows || []).some((r) => String(r?.status || "").toLowerCase() === "bad");
    if (!hasBad) {
      zeroBadSectionCount += 1;
    }
  }

  const zeroBadRatioPct = Math.round((zeroBadSectionCount / sections.length) * 100);
  const status = zeroBadSectionCount === sections.length ? "all_free_of_bad" : zeroBadRatioPct >= 50 ? "mostly_free_of_bad" : "critical_widespread";

  return {
    totalSections: sections.length,
    zeroBadSectionCount,
    zeroBadRatioPct,
    status,
    summary: `Kritiksiz bölüm oranı: ${zeroBadSectionCount}/${sections.length} bölümde BAD satır yok (%${zeroBadRatioPct})`
  };
}
