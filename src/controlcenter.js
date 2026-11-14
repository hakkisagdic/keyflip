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

export function sortStatusBoardRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r, idx) => {
      const st = ["ok", "warn", "bad", "unknown"].includes(r?.status) ? r.status : "unknown";
      return {
        index: idx,
        row: {
          label: String(r?.label ?? ""),
          value: String(r?.value ?? ""),
          status: st,
          detail: r?.detail != null ? String(r.detail) : null,
          since: r?.since != null ? String(r.since) : null
        }
      };
    })
    .sort((a, b) => {
      const rankDiff = (STATUS_ROW_RANK[a.row.status] ?? 3) - (STATUS_ROW_RANK[b.row.status] ?? 3);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map((item) => item.row);
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

  const sections = Array.isArray(raw.sections)
    ? raw.sections.map((sec, idx) => ({
        id: String(sec?.id || `section-${idx}`),
        title: String(sec?.title || sec?.id || `Bölüm ${idx + 1}`),
        rows: sortStatusBoardRows(sec?.rows)
      }))
    : [];

  const ownerNeeded = Array.isArray(raw.owner_needed)
    ? raw.owner_needed
        .filter((item) => item && (item.project || item.text))
        .map((item) => ({
          project: String(item.project ?? ""),
          text: String(item.text ?? "")
        }))
    : [];

  return {
    updated: raw.updated ? String(raw.updated) : null,
    stale,
    ageMinutes,
    sections,
    owner_needed: ownerNeeded
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
      useItOrLoseIt
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

  return lines.join("\n").trim() + "\n";
}

export function collectPreferences(ctx) {
  const homeDir = ctx?.home || ctx?.homeDir || os.homedir();
  const daemonPlist = path.join(homeDir, "Library", "LaunchAgents", "com.keyflip.daemon.plist");
  return {
    thresholdPct: _config.get(ctx, "autoswitch.threshold") ?? 95,
    refreshIntervalSec: _config.get(ctx, "daemon.autoswitchIntervalSeconds") ?? 120,
    notify: _config.get(ctx, "notify.desktop") !== false,
    launchAtLogin: fs.existsSync(daemonPlist),
    statusFile: _config.get(ctx, "menubar.statusFile") || "~/.polyctl/admin/status.json"
  };
}
