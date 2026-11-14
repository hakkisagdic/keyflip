import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectOtherQuotas,
  collectServicesStatus,
  restartManagedService,
  summarizeFleetSweep,
  collectServerStatus,
  collectStatusBoard,
  computeQuotaForecast,
  buildControlCenterMarkdown,
  collectAuditTimeline,
  evaluateFailoverSpendHealth,
  evaluatePoolReadiness,
  detectStatusBoardTransitions
} from "../src/controlcenter.js";
import * as daemon from "../src/daemon.js";

function makeTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kf-cc-test-"));
  const home = path.join(root, "home");
  const configDir = path.join(home, ".config", "keyflip");
  fs.mkdirSync(configDir, { recursive: true });
  return {
    root,
    home,
    configDir,
    ctx: {
      home,
      configDir,
      platform: "darwin",
      now: () => "2026-11-13T15:00:00.000Z",
      nowMs: () => Date.parse("2026-11-13T15:00:00.000Z")
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test("collectOtherQuotas reads quota.md, apicredits, plugin JSON, and returns okunamadı for unknown sources", () => {
  const env = makeTempEnv();
  try {
    const adminDir = path.join(env.home, ".polyctl", "admin");
    fs.mkdirSync(adminDir, { recursive: true });
    const quotaMd = path.join(adminDir, "quota.md");
    fs.writeFileSync(
      quotaMd,
      [
        "## 2026-11-13 15:47",
        "| tool | account | 5h used % | weekly used % | resets |",
        "|---|---|---:|---:|---|",
        "| antigravity | hakkisagdic@gmail.com | 0.0 | 40.0 | 5h: 1h39m, 7d: Nov 20 |",
        "| kiro (monthly credits, freeskynet) | - | - | 0.21 / 50 | 12/01 |"
      ].join("\n"),
      "utf8"
    );

    // Write manual apicredits entry
    fs.writeFileSync(
      path.join(env.configDir, "api-accounts.json"),
      JSON.stringify({
        schemaVersion: 1,
        accounts: [
          {
            id: "max20",
            plan: "max20x",
            grant: 200,
            cycleDay: 1,
            entries: [{ at: "2026-11-13T12:00:00.000Z", usd: 145.5 }]
          }
        ]
      }),
      "utf8"
    );

    const quotas = collectOtherQuotas(env.ctx, { homeDir: env.home, configDir: env.configDir });
    const byId = Object.fromEntries(quotas.map((q) => [q.id, q]));

    assert.equal(byId.kiro.status, "ok");
    assert.equal(byId.kiro.display, "0.21 / 50 kredi");
    assert.equal(byId.kiro.usedPct, 0.4);

    assert.equal(byId.agy.status, "ok");
    assert.equal(byId.agy.display, "5s: %0 · 7g: %40");
    assert.equal(byId.agy.usedPct, 40);

    // Unknown sources must NEVER fabricate numbers; they must return "okunamadı"
    assert.equal(byId.copilot.status, "unreadable");
    assert.equal(byId.copilot.display, "okunamadı");
    assert.equal(byId.copilot.usedPct, null);

    assert.equal(byId.evren.status, "unreadable");
    assert.equal(byId.evren.display, "okunamadı");

    // API credits
    assert.equal(byId.apicredits.status, "ok");
    assert.match(byId.apicredits.display, /\$145\.50 kalan/);

    // Plugin JSON override for EVREN
    const quotasDir = path.join(env.configDir, "quotas");
    fs.mkdirSync(quotasDir, { recursive: true });
    fs.writeFileSync(
      path.join(quotasDir, "evren.json"),
      JSON.stringify({
        label: "EVREN",
        status: "ok",
        display: "120 / 500 sorgu",
        usedPct: 24
      }),
      "utf8"
    );

    const quotasWithPlugin = collectOtherQuotas(env.ctx, { homeDir: env.home, configDir: env.configDir });
    const evrenPlugin = quotasWithPlugin.find((q) => q.id === "evren");
    assert.equal(evrenPlugin.status, "ok");
    assert.equal(evrenPlugin.display, "120 / 500 sorgu");
    assert.equal(evrenPlugin.usedPct, 24);
  } finally {
    env.cleanup();
  }
});

test("collectServicesStatus inspects launchd map and log tails; restartManagedService enforces confirm and whitelist", () => {
  const env = makeTempEnv();
  try {
    const backupLogDir = path.join(env.home, ".polyctl", "admin", "backups", "flowparts-nightly");
    fs.mkdirSync(backupLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(backupLogDir, "nightly.log"),
      [
        "2026-11-13 03:30:01 start (pid 26970)",
        "2026-11-13 03:31:55 ok: /Users/hakkisagdic/.polyctl/admin/backups/flowparts-nightly/2026-11-13 4.2M; 169 tables verified",
        "2026-11-13 03:31:55 done"
      ].join("\n"),
      "utf8"
    );

    const services = collectServicesStatus(env.ctx, {
      homeDir: env.home,
      launchdMap: {
        "dev.keysmith.gateway": { pid: 14197, lastExitStatus: 0 },
        "dev.keysmith.router": { pid: 50076, lastExitStatus: 0 },
        "dev.polyctl.admin-tick": { pid: null, lastExitStatus: 0 },
        "dev.polyctl.flowparts-backup": { pid: null, lastExitStatus: 0 },
        "local.yargitay.embed-ensure": { pid: null, lastExitStatus: 1 }
      }
    });

    const gw = services.find((s) => s.id === "keysmith-gateway");
    assert.equal(gw.state, "running");
    assert.equal(gw.pid, 14197);
    assert.equal(gw.restartable, true);

    const backup = services.find((s) => s.id === "nightly-backup");
    assert.equal(backup.state, "scheduled");
    assert.match(backup.lastSuccess, /169 tables verified/);

    const embed = services.find((s) => s.id === "embedding-guardian");
    assert.equal(embed.state, "error");

    // 1. Rejects without confirm: true
    assert.throws(
      () => restartManagedService(env.ctx, { label: "dev.keysmith.gateway", confirm: false }),
      (err) => err.code === "CONFIRMATION_REQUIRED"
    );

    // 2. Rejects non-whitelisted service even with confirm: true
    assert.throws(
      () => restartManagedService(env.ctx, { label: "com.apple.Finder", confirm: true }),
      (err) => err.code === "SERVICE_NOT_ALLOWED"
    );

    // 3. Succeeds with confirm: true on whitelisted service and writes audit logs
    const calls = [];
    const res = restartManagedService(env.ctx, {
      label: "dev.keysmith.gateway",
      confirm: true,
      runner: (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0, stdout: "kickstarted", stderr: "" };
      }
    });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "launchctl");
    assert.equal(calls[0].args[0], "kickstart");

    const logContent = fs.readFileSync(path.join(env.configDir, "logs", "keyflip.log"), "utf8");
    assert.match(logContent, /AUDIT action=service_restart label=dev\.keysmith\.gateway ok=true/);

    const eventsContent = fs.readFileSync(path.join(env.configDir, "events.jsonl"), "utf8");
    assert.match(eventsContent, /"kind":"service-restart"/);
  } finally {
    env.cleanup();
  }
});

test("summarizeFleetSweep and collectServerStatus handle data and unreadable fallbacks cleanly", () => {
  const env = makeTempEnv();
  try {
    const unreadableFleet = summarizeFleetSweep(null);
    assert.equal(unreadableFleet.status, "unreadable");
    assert.equal(unreadableFleet.display, "okunamadı");

    const summary = summarizeFleetSweep([
      { active: true, lastTurnAt: 10, updatedMinAgo: 10 },
      { active: true, lastTurnAt: 180, updatedMinAgo: 180 }, // stuck (>120m)
      { active: false, updatedMinAgo: 30 }, // idle
      { active: false, updatedMinAgo: 60 * 24 * 10 } // dormant (>7d)
    ]);
    assert.equal(summary.working, 1);
    assert.equal(summary.stuck, 1);
    assert.equal(summary.idle, 1);
    assert.equal(summary.dormant, 1);
    assert.equal(summary.status, "warning");

    const srvUnreadable = collectServerStatus(env.ctx, { homeDir: env.home, configDir: env.configDir });
    assert.equal(srvUnreadable.status, "unreadable");
    assert.equal(srvUnreadable.load, "okunamadı");
    assert.equal(srvUnreadable.readOnly, true);
    assert.deepEqual(srvUnreadable.sites, []);
  } finally {
    env.cleanup();
  }
});

test("collectStatusBoard returns null when missing, sorts bad/warn first, and flags data older than 20 minutes", () => {
  const env = makeTempEnv();
  try {
    // 1. Missing file -> null (section hidden)
    assert.equal(collectStatusBoard(env.ctx, { homeDir: env.home }), null);

    // 2. Load sample fixture (updated: 2026-11-14T18:20:00Z)
    const fixturePath = path.resolve("test/fixtures/status.sample.json");
    const freshBoard = collectStatusBoard(env.ctx, {
      homeDir: env.home,
      statusFile: fixturePath,
      nowMs: () => Date.parse("2026-11-14T18:35:00Z") // 15m old -> fresh
    });
    assert.ok(freshBoard);
    assert.equal(freshBoard.stale, false);
    assert.equal(freshBoard.ageMinutes, 15);
    assert.equal(freshBoard.owner_needed.length, 2);
    assert.deepEqual(
      freshBoard.sections[0].rows.map((r) => r.status),
      ["bad", "warn", "ok"]
    );

    // 3. Stale (>20 minutes old)
    const staleBoard = collectStatusBoard(env.ctx, {
      homeDir: env.home,
      statusFile: fixturePath,
      nowMs: () => Date.parse("2026-11-14T18:45:00Z") // 25m old -> stale
    });
    assert.equal(staleBoard.stale, true);
    assert.equal(staleBoard.ageMinutes, 25);
  } finally {
    env.cleanup();
  }
});

test("computeQuotaForecast calculates burn-rate and prioritizes expiring headroom (use-it-or-lose-it)", () => {
  const nowMs = Date.parse("2026-11-14T18:00:00Z");
  const forecast = computeQuotaForecast(
    [
      {
        name: "acct-fast-burn",
        active: true,
        usage: {
          fiveHour: { pct: 80, resetsAt: "2026-11-14T22:00:00Z" }, // 240m left (60m elapsed, 80% used -> fast burn)
          sevenDay: { pct: 50 }
        }
      },
      {
        name: "acct-expiring-soon",
        active: false,
        usage: {
          fiveHour: { pct: 35, resetsAt: "2026-11-14T18:45:00Z" }, // 45m left, 65% free -> use-it-or-lose-it!
          sevenDay: { pct: 40 }
        }
      }
    ],
    { nowMs }
  );

  assert.equal(forecast.recommendedAccount, "acct-expiring-soon");
  assert.match(forecast.recommendationReason, /45 dk içinde sıfırlanıyor/);
  const fastAcct = forecast.accounts.find((a) => a.name === "acct-fast-burn");
  assert.equal(fastAcct.willExhaustBeforeReset, true);
  assert.equal(fastAcct.minutesUntilExhaustion, 15);

  const md = buildControlCenterMarkdown({
    generatedAt: "2026-11-14T18:00:00Z",
    quotaForecast: forecast
  });
  assert.match(md, /acct-expiring-soon/);
});

test("daemon handleCommand serves control-center and service-restart endpoints", async () => {
  const env = makeTempEnv();
  try {
    const ccRes = await daemon.handleCommand(
      env.ctx,
      null,
      { cmd: "control-center" },
      {
        home: env.home,
        controlCenter: {
          homeDir: env.home,
          configDir: env.configDir,
          sweepScript: null,
          launchdMap: { "dev.keysmith.gateway": { pid: 999, lastExitStatus: 0 } }
        }
      }
    );
    assert.equal(ccRes.status, 200);
    assert.equal(ccRes.body.ok, true);
    assert.equal(Array.isArray(ccRes.body.otherQuotas), true);
    assert.equal(Array.isArray(ccRes.body.services), true);
    assert.equal(ccRes.body.fleet.display, "okunamadı");
    assert.equal(ccRes.body.server.readOnly, true);
    assert.equal(ccRes.body.statusBoard, null);
    assert.equal(typeof ccRes.body.preferences.thresholdPct, "number");
    assert.equal(ccRes.body.preferences.statusFile, "~/.polyctl/admin/status.json");
    assert.equal(typeof ccRes.body.markdownReport, "string");

    const restartNoConfirm = await daemon.handleCommand(
      env.ctx,
      null,
      { cmd: "service-restart", label: "dev.keysmith.gateway" },
      { home: env.home }
    );
    assert.equal(restartNoConfirm.status, 400);
    assert.equal(restartNoConfirm.body.error, "confirmation_required");

    const restartForbidden = await daemon.handleCommand(
      env.ctx,
      null,
      { cmd: "service-restart", label: "com.apple.WindowServer", confirm: true },
      { home: env.home }
    );
    assert.equal(restartForbidden.status, 403);
    assert.equal(restartForbidden.body.error, "service_not_allowed");
  } finally {
    env.cleanup();
  }
});

test("collectStatusBoard computes sinceAge, merges extraStatusFiles, and collectAuditTimeline formats recent events", () => {
  const env = makeTempEnv();
  try {
    const fixturePath = path.resolve("test/fixtures/status.sample.json");
    const extraPath = path.join(env.root, "extra-status.json");
    fs.writeFileSync(
      extraPath,
      JSON.stringify({
        host: "devbox-2",
        updated: "2026-11-14T18:25:00Z",
        sections: [
          {
            id: "quotas",
            title: "Kotalar",
            rows: [{ label: "Uzak Hesap", value: "%99", status: "bad", since: "2026-11-14T17:00:00Z" }]
          }
        ],
        owner_needed: [{ project: "remote-api", text: "Sertifika yenilenmeli" }]
      }),
      "utf8"
    );

    const merged = collectStatusBoard(env.ctx, {
      homeDir: env.home,
      statusFile: fixturePath,
      extraStatusFiles: extraPath,
      nowMs: () => Date.parse("2026-11-14T18:30:00Z")
    });
    assert.equal(merged.owner_needed.length, 3);
    assert.equal(merged.sections[0].rows.length, 4);
    assert.equal(merged.sections[0].rows[0].sinceAge, "45 dk");
    assert.ok(merged.sections[0].rows.some((r) => r.label === "[devbox-2] Uzak Hesap"));

    fs.writeFileSync(
      path.join(env.configDir, "events.jsonl"),
      [
        JSON.stringify({ at: "2026-11-14T18:00:00Z", kind: "daemon-switch", from: "a", to: "b", reason: "menubar" }),
        JSON.stringify({ at: "2026-11-14T18:05:00Z", kind: "service-restart", label: "dev.keysmith.gateway", ok: true })
      ].join("\n") + "\n",
      "utf8"
    );

    const timeline = collectAuditTimeline(env.ctx, { limit: 5 });
    assert.equal(timeline.length, 2);
    assert.match(timeline[0].summary, /Servis yeniden başlatıldı/);
    assert.match(timeline[1].summary, /Hesap geçişi: a → b/);
  } finally {
    env.cleanup();
  }
});

test("evaluateFailoverSpendHealth, evaluatePoolReadiness, and detectStatusBoardTransitions detect anomalies accurately", () => {
  const nowMs = Date.parse("2026-11-14T18:30:00Z");
  const spendHealth = evaluateFailoverSpendHealth(
    {
      enabled: true,
      engaged: true,
      since: "2026-11-14T18:00:00Z", // 30m elapsed
      cap: { max: 20, spent: 12, remaining: 8, exceeded: false } // $24/hr burn -> 20m to cap
    },
    { nowMs }
  );
  assert.equal(spendHealth.status, "critical");
  assert.equal(spendHealth.utilizationPct, 60);
  assert.equal(spendHealth.burnUsdPerHour, 24);
  assert.equal(spendHealth.estimatedMinutesToCap, 20);
  assert.match(spendHealth.alertReason, /tavan ~20 dk içinde dolabilir/);

  const readiness = evaluatePoolReadiness([
    {
      name: "primary",
      enabled: true,
      token: { status: "valid", remainingMs: 2 * 3600 * 1000 },
      usage: { fiveHour: { pct: 40 }, sevenDay: { pct: 50 } }
    },
    {
      name: "expiring",
      enabled: true,
      token: { status: "valid", remainingMs: 20 * 60 * 1000 }, // <= 45m -> needsPreWarm
      usage: { fiveHour: { pct: 10 }, sevenDay: { pct: 20 } }
    }
  ]);
  assert.equal(readiness.totalEnabled, 2);
  assert.equal(readiness.readyForRotation, 2);
  assert.deepEqual(readiness.needsPreWarm, ["expiring"]);
  assert.equal(readiness.status, "warning");

  const prevBoard = {
    sections: [{ id: "s1", title: "S1", rows: [{ label: "API", value: "OK", status: "ok" }] }],
    owner_needed: [{ project: "p1", text: "t1" }]
  };
  const nextBoard = {
    sections: [{ id: "s1", title: "S1", rows: [{ label: "API", value: "502", status: "bad" }] }],
    owner_needed: [
      { project: "p1", text: "t1" },
      { project: "p2", text: "t2" }
    ]
  };
  const diff = detectStatusBoardTransitions(prevBoard, nextBoard);
  assert.equal(diff.hasAlert, true);
  assert.equal(diff.newBadRows.length, 1);
  assert.equal(diff.ownerNeededDelta, 1);
  assert.match(diff.summary, /Yeni kritik satır: API/);
});
