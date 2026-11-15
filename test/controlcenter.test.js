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
  estimateFailoverSessionCost,
  evaluatePoolReadiness,
  evaluatePoolResilienceScore,
  detectStatusBoardTransitions,
  evaluatePoolHorizonAndQuietHours,
  buildDiagnosticBundle,
  validateStatusBoardSchema,
  computeStatusBoardHealth,
  buildWeeklyResetCalendar,
  diffStatusBoards,
  evaluateMultiProviderContinuity,
  evaluateServicesHealthSummary,
  predictDailyBottleneckWindow,
  snapshotStatusBoard,
  listStatusBoardSnapshots,
  evaluateWorkSessionReadiness,
  evaluateSubscriptionValueROI,
  evaluateRotationStability,
  evaluateFleetEfficiency,
  evaluateServerSitesHealth,
  pruneStatusBoardSnapshots,
  evaluateSecondaryQuotasAlert,
  formatDaemonCompactSummary,
  evaluateAutonomousOpsPosture,
  prioritizeOwnerNeededQueue,
  evaluateOAuthRefreshReliability,
  recommendAdaptiveAutoswitchThreshold,
  summarizeSectionHealthBreakdown,
  buildRemediationPlaybook,
  evaluatePoolLoadBalance,
  listAgingStatusBoardIssues,
  evaluateFailoverRecoveryCountdown,
  summarizeDailyAuditActivity,
  evaluateDaemonSchedulerHealth,
  evaluateWeeklyUnclaimedQuota,
  groupOwnerNeededByProject,
  evaluateServerResourcePressure,
  evaluateDesktopRestartSafety,
  evaluateSonnetModelSplitHealth,
  evaluateServiceLogHygiene
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

test("evaluatePoolHorizonAndQuietHours, weeklyEfficiency, service sparkline, and buildDiagnosticBundle work and scrub PII/secrets", () => {
  const forecast = computeQuotaForecast(
    [
      {
        name: "acct-under",
        active: true,
        usage: {
          fiveHour: { pct: 20, resetsAt: "2026-11-14T20:00:00Z" },
          sevenDay: { pct: 15, resetsAt: "2026-11-15T10:00:00Z" } // <35% and <=36h left -> underutilized
        }
      }
    ],
    { nowMs: Date.parse("2026-11-14T18:00:00Z") }
  );
  assert.equal(forecast.accounts[0].weeklyEfficiency, "underutilized");

  const horizon = evaluatePoolHorizonAndQuietHours([
    { name: "a1", enabled: true, usage: { fiveHour: { pct: 40 } } },
    { name: "a2", enabled: true, usage: { fiveHour: { pct: 60 } } }
  ]);
  assert.equal(horizon.enabledAccounts, 2);
  assert.equal(horizon.totalRemainingFiveHourPct, 100);
  assert.equal(horizon.estimatedPoolDepletionMinutes, 200);

  const diag = buildDiagnosticBundle({
    generatedAt: "2026-11-14T18:00:00Z",
    activeAccount: { name: "gmail", email: "user@example.com" },
    accounts: [{ name: "gmail", accessToken: "sk-ant-secret123456" }]
  });
  assert.equal(diag.schema, "keyflip.diagnostic.v1");
  assert.equal(diag.summary.activeAccount.email, "[EMAIL_REDACTED]");
});

test("validateStatusBoardSchema, computeStatusBoardHealth, estimateFailoverSessionCost, and evaluatePoolResilienceScore work accurately", () => {
  const sampleText = fs.readFileSync(path.resolve("test/fixtures/status.sample.json"), "utf8");
  const validRes = validateStatusBoardSchema(sampleText);
  assert.equal(validRes.valid, true);
  assert.equal(validRes.errors.length, 0);
  assert.equal(validRes.stats.sectionCount, 2);
  assert.equal(validRes.stats.rowCount, 5);
  assert.equal(validRes.stats.ownerNeededCount, 2);

  const invalidRes = validateStatusBoardSchema({
    updated: "not-a-date",
    sections: [{ id: "", rows: [{ label: "", value: "1", status: "invalid-status" }] }]
  });
  assert.equal(invalidRes.valid, false);
  assert.ok(invalidRes.errors.length >= 3);

  const parsedSample = JSON.parse(sampleText);
  const health = computeStatusBoardHealth(parsedSample.sections);
  assert.equal(health.totalRows, 5);
  assert.equal(health.okRows, 2);
  assert.equal(health.warnRows, 1);
  assert.equal(health.badRows, 1);
  assert.equal(health.unknownRows, 1);
  assert.equal(health.healthPct, 65);

  const costSim = estimateFailoverSessionCost({
    cap: { max: 25, spent: 5.8, remaining: 19.2 }
  });
  assert.equal(costSim.remainingUsd, 19.2);
  assert.equal(costSim.standardHoursCovered, 8);
  assert.equal(costSim.canCoverOneHourStandard, true);

  const resilienceHigh = evaluatePoolResilienceScore(
    [
      { name: "a1", enabled: true, token: { status: "valid" }, usage: { fiveHour: { pct: 20 }, sevenDay: { pct: 30 } } },
      { name: "a2", enabled: true, token: { status: "valid" }, usage: { fiveHour: { pct: 10 }, sevenDay: { pct: 40 } } },
      { name: "a3", enabled: true, token: { status: "valid" }, usage: { fiveHour: { pct: 50 }, sevenDay: { pct: 60 } } }
    ],
    { enabled: true, gatewayReady: true }
  );
  assert.equal(resilienceHigh.score, 100);
  assert.equal(resilienceHigh.grade, "A");
  assert.equal(resilienceHigh.spofRisk, false);

  const resilienceLow = evaluatePoolResilienceScore(
    [{ name: "only", enabled: true, token: { status: "expired" }, usage: { fiveHour: { pct: 95 }, sevenDay: { pct: 92 } } }],
    { enabled: false, gatewayReady: false }
  );
  assert.equal(resilienceLow.grade, "D");
  assert.equal(resilienceLow.spofRisk, true);
  assert.ok(resilienceLow.risks.length >= 3);
});

test("buildWeeklyResetCalendar, diffStatusBoards, evaluateMultiProviderContinuity, and evaluateServicesHealthSummary work accurately", () => {
  const nowMs = Date.parse("2026-11-14T12:00:00Z");
  const cal = buildWeeklyResetCalendar(
    [
      {
        name: "work",
        enabled: true,
        usage: { sevenDay: { pct: 60, resetsAt: "2026-11-16T08:00:00Z" } }
      },
      {
        name: "personal",
        enabled: true,
        usage: { sevenDay: { pct: 25, resetsAt: "2026-11-15T06:00:00Z" } }
      }
    ],
    { nowMs }
  );
  assert.equal(cal.nextResetAccount, "personal");
  assert.equal(cal.nextResetHours, 18);
  assert.equal(cal.items.length, 2);
  assert.match(cal.summary, /Sıradaki 7g sıfırlama: personal/);

  const boardA = {
    sections: [
      {
        id: "quotas",
        title: "Kotalar",
        rows: [
          { label: "Claude", value: "%30", status: "ok" },
          { label: "Gateway", value: "502", status: "bad" }
        ]
      }
    ],
    owner_needed: [{ project: "app", text: "Onay bekliyor" }]
  };
  const boardB = {
    sections: [
      {
        id: "quotas",
        title: "Kotalar",
        rows: [
          { label: "Claude", value: "%99", status: "bad" },
          { label: "Gateway", value: "200", status: "ok" }
        ]
      }
    ],
    owner_needed: [
      { project: "app", text: "Onay bekliyor" },
      { project: "infra", text: "Disk dolu" }
    ]
  };
  const diff = diffStatusBoards(boardA, boardB);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.degraded.length, 1);
  assert.equal(diff.degraded[0].label, "Claude");
  assert.equal(diff.recovered.length, 1);
  assert.equal(diff.recovered[0].label, "Gateway");
  assert.equal(diff.addedOwners.length, 1);

  const cont = evaluateMultiProviderContinuity(
    [
      { name: "a1", enabled: true, usage: { fiveHour: { pct: 30 }, sevenDay: { pct: 40 } } },
      { name: "a2", enabled: true, usage: { fiveHour: { pct: 50 }, sevenDay: { pct: 60 } } }
    ],
    { enabled: true, gatewayReady: true, cap: { exceeded: false } },
    [
      { id: "agy", label: "Antigravity (agy)", status: "ok", usedPct: 20 },
      { id: "kiro", label: "Kiro Kredisi", status: "ok", usedPct: 10 },
      { id: "copilot", label: "GitHub Copilot", status: "unreadable", usedPct: null }
    ]
  );
  assert.equal(cont.score, 90);
  assert.equal(cont.tier, "high");
  assert.equal(cont.readyClaudeCount, 2);
  assert.equal(cont.readySecondaryCount, 2);

  const svcHealth = evaluateServicesHealthSummary([
    { id: "gw", label: "dev.keysmith.gateway", state: "running" },
    { id: "rt", label: "dev.keysmith.router", state: "scheduled" },
    { id: "em", label: "local.yargitay.embed-ensure", state: "error" }
  ]);
  assert.equal(svcHealth.status, "critical");
  assert.equal(svcHealth.errorCount, 1);
  assert.deepEqual(svcHealth.failedLabels, ["local.yargitay.embed-ensure"]);
  assert.equal(svcHealth.score, 67);
});

test("predictDailyBottleneckWindow, snapshotStatusBoard, evaluateWorkSessionReadiness, and evaluateSubscriptionValueROI work accurately", () => {
  const env = makeTempEnv();
  try {
    const bn = predictDailyBottleneckWindow([
      { kind: "daemon-switch", at: "2026-11-14T14:10:00Z" },
      { kind: "autoswitch", at: "2026-11-14T14:40:00Z" },
      { kind: "failover-on", at: "2026-11-14T09:05:00Z" }
    ]);
    assert.equal(bn.totalRotations, 3);
    assert.equal(bn.peakHourUtc, 14);
    assert.equal(bn.peakWindowLabel, "14:00-15:00 UTC");
    assert.equal(bn.peakCount, 2);

    const fixturePath = path.resolve("test/fixtures/status.sample.json");
    const snapRes = snapshotStatusBoard(env.ctx, {
      sourceFile: fixturePath,
      homeDir: env.home,
      configDir: env.configDir,
      now: () => "2026-11-14T20:00:00Z"
    });
    assert.equal(snapRes.ok, true);
    assert.equal(fs.existsSync(snapRes.snapshotPath), true);
    assert.equal(fs.existsSync(snapRes.latestPath), true);

    const readyCheck = evaluateWorkSessionReadiness({
      accounts: [
        {
          name: "gmail",
          enabled: true,
          active: true,
          token: { status: "valid", remainingMs: 2 * 3600 * 1000 },
          usage: { fiveHour: { pct: 40 }, sevenDay: { pct: 50 } }
        }
      ],
      failover: { enabled: true, gatewayReady: true, cap: { exceeded: false } },
      services: [{ id: "gw", state: "running" }],
      statusBoard: { sections: [{ id: "s1", rows: [{ label: "API", status: "ok", value: "200" }] }] }
    });
    assert.equal(readyCheck.status, "ready");
    assert.equal(readyCheck.passedCount, 5);
    assert.equal(readyCheck.totalCount, 5);

    const roi = evaluateSubscriptionValueROI(
      [{ name: "gmail", enabled: true, tier: "max", usage: { sevenDay: { pct: 80 } } }],
      [{ id: "apicredits", status: "ok", display: "$140 kalan" }],
      { cap: { spent: 3.5 } }
    );
    assert.equal(roi.enabledSubscriptionCount, 1);
    assert.equal(roi.avgWeeklyUtilizationPct, 80);
    assert.equal(roi.estimatedWeeklyApiEquivalentUsd, 48);
  } finally {
    env.cleanup();
  }
});

test("listStatusBoardSnapshots, evaluateRotationStability, evaluateFleetEfficiency, and evaluateServerSitesHealth work accurately", () => {
  const env = makeTempEnv();
  try {
    const fixturePath = path.resolve("test/fixtures/status.sample.json");
    snapshotStatusBoard(env.ctx, {
      sourceFile: fixturePath,
      homeDir: env.home,
      configDir: env.configDir,
      now: () => "2026-11-15T01:00:00Z"
    });
    const hist = listStatusBoardSnapshots(env.ctx, {
      sourceFile: fixturePath,
      homeDir: env.home,
      configDir: env.configDir
    });
    assert.equal(hist.snapshots.length, 1);
    assert.equal(hist.diffWithLive.hasChanges, false);

    const rot = evaluateRotationStability([
      { kind: "daemon-switch", at: "2026-11-15T01:00:00Z" },
      { kind: "autoswitch", at: "2026-11-15T01:05:00Z" },
      { kind: "switch", at: "2026-11-15T01:12:00Z" }
    ]);
    assert.equal(rot.status, "thrashing");
    assert.equal(rot.rapidSwitchCount, 2);
    assert.equal(rot.minIntervalMinutes, 5);

    const fleetEff = evaluateFleetEfficiency({
      status: "warning",
      working: 3,
      idle: 1,
      stuck: 1,
      total: 5
    });
    assert.equal(fleetEff.status, "warning");
    assert.equal(fleetEff.score, 75);
    assert.equal(fleetEff.activeRatioPct, 60);

    const srvHealth = evaluateServerSitesHealth({
      host: "Uzak Sunucu",
      status: "ok",
      sites: [
        { name: "app.example.com", status: "ok" },
        { name: "api.example.com", status: "down" }
      ]
    });
    assert.equal(srvHealth.status, "warning");
    assert.equal(srvHealth.score, 50);
    assert.deepEqual(srvHealth.downSites, ["api.example.com"]);
  } finally {
    env.cleanup();
  }
});

test("pruneStatusBoardSnapshots, evaluateSecondaryQuotasAlert, formatDaemonCompactSummary, evaluateAutonomousOpsPosture, and prioritizeOwnerNeededQueue work accurately", () => {
  const env = makeTempEnv();
  try {
    const fixturePath = path.resolve("test/fixtures/status.sample.json");
    snapshotStatusBoard(env.ctx, { sourceFile: fixturePath, homeDir: env.home, configDir: env.configDir, now: () => "2026-11-15T01:00:00Z" });
    snapshotStatusBoard(env.ctx, { sourceFile: fixturePath, homeDir: env.home, configDir: env.configDir, now: () => "2026-11-15T02:00:00Z" });
    snapshotStatusBoard(env.ctx, { sourceFile: fixturePath, homeDir: env.home, configDir: env.configDir, now: () => "2026-11-15T03:00:00Z" });

    const pruned = pruneStatusBoardSnapshots(env.ctx, { homeDir: env.home, configDir: env.configDir, keep: 2 });
    assert.equal(pruned.keptCount, 2);
    assert.equal(pruned.deletedCount, 1);

    const secAlert = evaluateSecondaryQuotasAlert([
      { id: "kiro", label: "Kiro Kredisi", status: "ok", usedPct: 30 },
      { id: "agy", label: "Antigravity (agy)", status: "exhausted", usedPct: 98 },
      { id: "apicredits", label: "API Promosyonları", status: "warning", usedPct: 90 }
    ]);
    assert.equal(secAlert.hasAlert, true);
    assert.equal(secAlert.severity, "critical");
    assert.deepEqual(secAlert.exhausted, ["Antigravity (agy)"]);
    assert.deepEqual(secAlert.warning, ["API Promosyonları"]);

    const posture = evaluateAutonomousOpsPosture({
      poolResilience: { score: 90 },
      sessionReadiness: { passedCount: 5, totalCount: 5 },
      multiProviderContinuity: { score: 80 },
      servicesHealth: { score: 100 },
      statusBoard: { healthPct: 80 }
    });
    assert.equal(posture.grade, "A");
    assert.equal(posture.score >= 85, true);

    const queue = prioritizeOwnerNeededQueue({
      owner_needed: [
        { project: "docs", text: "README guncelle" },
        { project: "billing", text: "ACIL fatura odemesi gerekiyor" }
      ]
    });
    assert.equal(queue.totalCount, 2);
    assert.equal(queue.urgentCount, 1);
    assert.equal(queue.topItem.project, "billing");

    const compact = formatDaemonCompactSummary({
      activeAccount: { name: "gmail" },
      accounts: [{ name: "gmail", active: true, usage: { fiveHour: { pct: 40 }, sevenDay: { pct: 55 } } }],
      poolReadiness: { status: "ok" },
      poolResilience: { summary: "Dayanıklılık: A (90/100)" },
      failover: { enabled: true, engaged: false, costEstimate: { summary: "~$2.40/saat" } },
      servicesHealth: { status: "ok", summary: "5/5 servis sağlıklı" }
    });
    assert.equal(compact.pillars.length, 6);
    assert.equal(compact.text.includes("Hesap Havuzu"), true);
  } finally {
    env.cleanup();
  }
});

test("evaluateOAuthRefreshReliability, recommendAdaptiveAutoswitchThreshold, summarizeSectionHealthBreakdown, buildRemediationPlaybook, and evaluatePoolLoadBalance work accurately", () => {
  const oauthRel = evaluateOAuthRefreshReliability([
    { name: "gmail", enabled: true, token: { status: "valid", remainingMs: 2 * 3600 * 1000, lastResult: "ok" } },
    { name: "yahoo", enabled: true, token: { status: "expired", remainingMs: 0, lastResult: "failed" } }
  ]);
  assert.equal(oauthRel.status, "critical");
  assert.equal(oauthRel.score, 50);
  assert.deepEqual(oauthRel.failedAccounts, ["yahoo"]);

  const adaptive = recommendAdaptiveAutoswitchThreshold({
    currentThreshold: 95,
    accounts: [{ name: "gmail", enabled: true }, { name: "yahoo", enabled: true }],
    quotaForecast: { accounts: [{ name: "gmail", active: true, burnRateRatio: 1.8 }] },
    bottleneckWindow: { peakHourUtc: 14 },
    nowMs: Date.parse("2026-11-15T14:20:00Z")
  });
  assert.equal(adaptive.recommendedThreshold, 85);
  assert.equal(adaptive.needsAdjustment, true);

  const secBreakdown = summarizeSectionHealthBreakdown({
    sections: [
      { id: "s1", title: "Kotalar", rows: [{ label: "A", status: "bad", value: "99%", since: "2026-11-15T05:00:00Z" }] },
      { id: "s2", title: "Servisler", rows: [{ label: "B", status: "ok", value: "200" }] }
    ]
  }, Date.parse("2026-11-15T06:00:00Z"));
  assert.equal(secBreakdown.weakestSectionId, "s1");
  assert.equal(secBreakdown.weakestSectionHealthPct, 0);

  const playbook = buildRemediationPlaybook({
    accounts: [{ name: "yahoo", enabled: true, token: { status: "expired", lastResult: "failed" } }],
    failover: { cap: { exceeded: true } },
    services: [{ label: "dev.keysmith.gateway", title: "Gateway", state: "error", restartable: true }],
    statusBoard: { sections: [{ id: "s1", rows: [{ label: "DB", status: "bad", value: "down" }] }] }
  });
  assert.equal(playbook.hasActions, true);
  assert.equal(playbook.topSteps.length, 3);
  assert.equal(playbook.topSteps[0].target, "yahoo");

  const loadBal = evaluatePoolLoadBalance([
    { name: "gmail", enabled: true, usage: { sevenDay: { pct: 90 } } },
    { name: "yahoo", enabled: true, usage: { sevenDay: { pct: 20 } } }
  ]);
  assert.equal(loadBal.balanced, false);
  assert.equal(loadBal.spreadPct, 70);
  assert.equal(loadBal.underutilizedAccount, "yahoo");
});


test("listAgingStatusBoardIssues, evaluateFailoverRecoveryCountdown, summarizeDailyAuditActivity, evaluateDaemonSchedulerHealth, and evaluateWeeklyUnclaimedQuota work accurately", () => {
  const nowMs = Date.parse("2026-11-15T10:00:00Z");

  const aging = listAgingStatusBoardIssues(
    {
      sections: [
        {
          id: "infra",
          title: "Altyapı",
          rows: [
            { label: "Redis", value: "Yavaş", status: "warn", since: "2026-11-15T09:30:00Z" },
            { label: "Postgres", value: "Çöktü", status: "bad", since: "2026-11-15T06:00:00Z" },
            { label: "Nginx", value: "200 OK", status: "ok" }
          ]
        }
      ]
    },
    { nowMs }
  );
  assert.equal(aging.totalIssues, 2);
  assert.equal(aging.chronicCount, 1);
  assert.equal(aging.oldestIssueMinutes, 240);
  assert.equal(aging.items[0].label, "Postgres");

  const foCountdown = evaluateFailoverRecoveryCountdown(
    { engaged: true, fromAccount: "gmail" },
    [
      { name: "gmail", enabled: true, usage: { fiveHour: { pct: 98, resetsAt: "2026-11-15T10:35:00Z" } } },
      { name: "yahoo", enabled: true, usage: { fiveHour: { pct: 96, resetsAt: "2026-11-15T11:15:00Z" } } }
    ],
    { nowMs }
  );
  assert.equal(foCountdown.engaged, true);
  assert.equal(foCountdown.remainingMinutes, 35);
  assert.equal(foCountdown.recoverTarget, "gmail");

  const dailyAct = summarizeDailyAuditActivity(null, {
    nowMs,
    events: [
      { kind: "daemon-switch", ts: "2026-11-15T08:00:00Z" },
      { kind: "autoswitch", ts: "2026-11-15T09:00:00Z" },
      { kind: "daemon-failover-on", ts: "2026-11-15T09:15:00Z" },
      { kind: "service-restart", ts: "2026-11-15T09:30:00Z" },
      { kind: "daemon-switch", ts: "2026-11-13T08:00:00Z" } // older than 24h
    ]
  });
  assert.equal(dailyAct.switchCount, 2);
  assert.equal(dailyAct.failoverCount, 1);
  assert.equal(dailyAct.serviceRestartCount, 1);
  assert.equal(dailyAct.totalEvents24h, 4);

  const sched = evaluateDaemonSchedulerHealth(
    {
      autoswitch: { intervalSeconds: 120, lastRunAt: "2026-11-15T09:59:00Z", lastResult: "ok", lastDurationMs: 400 },
      refresh: { intervalSeconds: 900, lastRunAt: "2026-11-15T08:00:00Z", lastResult: "ok", lastDurationMs: 500 },
      "conv-index": { intervalSeconds: 1800, lastRunAt: "2026-11-15T09:50:00Z", lastResult: "error", lastDurationMs: 1200 }
    },
    { nowMs }
  );
  assert.equal(sched.status, "critical");
  assert.deepEqual(sched.failingJobs, ["conv-index"]);
  assert.deepEqual(sched.overdueJobs, ["refresh"]);

  const unclaimed = evaluateWeeklyUnclaimedQuota(
    [
      { name: "gmail", enabled: true, usage: { sevenDay: { pct: 85, resetsAt: "2026-11-16T04:00:00Z" } } },
      { name: "yahoo", enabled: true, usage: { sevenDay: { pct: 30, resetsAt: "2026-11-16T02:00:00Z" } } }
    ],
    { nowMs }
  );
  assert.equal(unclaimed.hasUnclaimed, true);
  assert.equal(unclaimed.priorityAccount, "yahoo");
  assert.equal(unclaimed.candidates[0].unclaimedPct, 70);
});


test("groupOwnerNeededByProject, evaluateServerResourcePressure, evaluateDesktopRestartSafety, evaluateSonnetModelSplitHealth, and evaluateServiceLogHygiene work accurately", () => {
  const nowMs = Date.parse("2026-11-15T10:00:00Z");

  const projGroups = groupOwnerNeededByProject({
    owner_needed: [
      { project: "keyflip", text: "Doküman kontrolü" },
      { project: "billing", text: "ACİL prod ödeme hatası" },
      { project: "billing", text: "Fatura şablonu" }
    ]
  });
  assert.equal(projGroups.projectCount, 2);
  assert.equal(projGroups.totalItems, 3);
  assert.equal(projGroups.topProject, "billing");
  assert.equal(projGroups.groups[0].urgentCount, 1);

  const srvPressure = evaluateServerResourcePressure({
    host: "hetzner-1",
    status: "ok",
    load: "4.50, 3.20, 2.10",
    memory: "14.8 GB / 16.0 GB (92.5%)",
    disk: "85% used"
  });
  assert.equal(srvPressure.status, "critical");
  assert.equal(srvPressure.loadAvg1m, 4.5);
  assert.equal(srvPressure.memoryPct, 92.5);
  assert.equal(srvPressure.diskPct, 85);
  assert.equal(srvPressure.pressures.length, 3);

  const deskSafety = evaluateDesktopRestartSafety(
    { pending: true, actions: [{ kind: "account", target: "yahoo" }] },
    { "desktop.autoRestart": true, "desktop.snoozeUntil": "2026-11-15T10:40:00Z" },
    { nowMs }
  );
  assert.equal(deskSafety.status, "snoozed");
  assert.equal(deskSafety.snoozeRemainingMin, 40);

  const sonnetSplit = evaluateSonnetModelSplitHealth([
    {
      name: "gmail",
      enabled: true,
      usage: { sevenDay: { pct: 45 }, sevenDaySonnet: { pct: 84 } }
    },
    {
      name: "yahoo",
      enabled: true,
      usage: { sevenDay: { pct: 30 }, sevenDaySonnet: { pct: 32 } }
    }
  ]);
  assert.equal(sonnetSplit.hasBottleneck, true);
  assert.equal(sonnetSplit.topConstrainedAccount, "gmail");
  assert.equal(sonnetSplit.maxDivergencePct, 39);

  const logHyg = evaluateServiceLogHygiene([
    { id: "gw", title: "Gateway", state: "running", sparkline: "██▁▁█▁", lastError: "ECONNREFUSED" },
    { id: "rt", title: "Router", state: "running", sparkline: "██████", lastError: null }
  ]);
  assert.equal(logHyg.noisyServiceCount, 1);
  assert.equal(logHyg.status, "warning");
  assert.equal(logHyg.noisyServices[0].title, "Gateway");
});
