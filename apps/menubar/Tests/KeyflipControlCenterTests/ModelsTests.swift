import Foundation
#if !STANDALONE_TEST_RUNNER
import XCTest
@testable import KeyflipControlCenter
#endif

public enum ModelsTestSuite {
    public static func runAll() throws {
        let sampleJson = """
        {
          "ok": true,
          "activeAccount": { "name": "gmail", "email": "user@gmail.com", "tier": "max" },
          "accounts": [
            {
              "name": "gmail",
              "email": "user@gmail.com",
              "tier": "max",
              "enabled": true,
              "active": true,
              "token": {
                "status": "valid",
                "expiresAt": "2026-11-13T18:00:00.000Z",
                "remainingMs": 7200000,
                "refreshable": true
              },
              "usage": {
                "fiveHour": { "pct": 42.0, "resetsAt": "2026-11-13T17:00:00.000Z" },
                "sevenDay": { "pct": 81.5, "resetsAt": "2026-11-18T00:00:00.000Z" }
              }
            }
          ],
          "failover": {
            "enabled": true,
            "engaged": false,
            "manual": false,
            "gatewayReady": true,
            "alias": "claude-sonnet-failover",
            "cap": { "max": 25.0, "spent": 3.4, "remaining": 21.6, "exceeded": false },
            "spendHealth": { "status": "ok", "utilizationPct": 13.6, "burnUsdPerHour": null, "estimatedMinutesToCap": null, "alertReason": null },
            "costEstimate": { "lightHourlyUsd": 0.9, "standardHourlyUsd": 2.4, "heavyHourlyUsd": 6.0, "remainingUsd": 21.6, "standardHoursCovered": 9.0, "canCoverOneHourStandard": true, "summary": "Simülasyon: Standart ~$2.40/saat · Kalan tavan ~9 saat yeter" }
          },
          "otherQuotas": [
            { "id": "kiro", "label": "Kiro Kredisi", "status": "ok", "display": "0.21 / 50 kredi", "usedPct": 0.4 },
            { "id": "copilot", "label": "GitHub Copilot", "status": "unreadable", "display": "okunamadı", "usedPct": null }
          ],
          "services": [
            {
              "id": "keysmith-gateway",
              "label": "dev.keysmith.gateway",
              "title": "Keysmith Gateway",
              "kind": "daemon",
              "loaded": true,
              "running": true,
              "pid": 14197,
              "state": "running",
              "restartable": true
            }
          ],
          "fleet": {
            "status": "ok",
            "display": "5 çalışıyor · 12 boşta · 0 takılı",
            "working": 5,
            "idle": 12,
            "stuck": 0,
            "total": 17
          },
          "server": {
            "host": "Uzak Sunucu",
            "status": "unreadable",
            "load": "okunamadı",
            "memory": "okunamadı",
            "disk": "okunamadı",
            "sites": [],
            "readOnly": true
          },
          "poolReadiness": {
            "status": "ok",
            "totalEnabled": 1,
            "healthyTokens": 1,
            "readyForRotation": 1,
            "needsPreWarm": [],
            "summary": "1/1 hesap rotasyona hazır"
          },
          "poolResilience": {
            "score": 88,
            "grade": "A",
            "spofRisk": false,
            "risks": [],
            "summary": "Dayanıklılık: A (88/100)"
          },
          "weeklyResetCalendar": {
            "items": [
              { "account": "gmail", "resetsAt": "2026-11-18T00:00:00.000Z", "hoursUntilReset": 80, "unusedSevenDayPct": 18.5, "slotLabel": "Çar 00:00" }
            ],
            "nextResetAccount": "gmail",
            "nextResetHours": 80,
            "summary": "Sıradaki 7g sıfırlama: gmail (Çar 00:00 · 80s kaldı)"
          },
          "multiProviderContinuity": {
            "score": 85,
            "tier": "high",
            "readyClaudeCount": 1,
            "readySecondaryCount": 2,
            "activeSurfaces": ["Claude (1 hesap)", "Keysmith Failover", "Kiro Kredisi"],
            "summary": "Süreklilik: %85 (3 aktif yüzey)"
          },
          "servicesHealth": {
            "score": 100,
            "status": "ok",
            "healthyCount": 1,
            "warningCount": 0,
            "errorCount": 0,
            "failedLabels": [],
            "summary": "1/1 servis sağlıklı (%100)"
          },
          "bottleneckWindow": {
            "totalRotations": 4,
            "peakHourUtc": 14,
            "peakWindowLabel": "14:00-15:00 UTC",
            "peakCount": 3,
            "summary": "Darboğaz saati: 14:00-15:00 UTC (3/4 geçiş)"
          },
          "sessionReadiness": {
            "status": "ready",
            "passedCount": 5,
            "totalCount": 5,
            "checks": [
              { "id": "headroom", "label": "Etkin hesap 5s boşluk ≥%25", "passed": true }
            ],
            "failedLabels": [],
            "summary": "Oturuma Hazır (5/5 kontrol tam)"
          },
          "subscriptionRoi": {
            "enabledSubscriptionCount": 1,
            "avgWeeklyUtilizationPct": 81.5,
            "estimatedWeeklyApiEquivalentUsd": 48.9,
            "failoverSpentUsd": 3.4,
            "apiCreditsStatus": "ok",
            "summary": "Haftalık verim: %81.5 (~$49 eşdeğer API değeri)"
          },
          "quotaForecast": {
            "recommendedAccount": "gmail",
            "recommendationReason": "5s penceresi 45 dk içinde sıfırlanıyor (%58 boş kapasite)",
            "accounts": [
              {
                "name": "gmail",
                "active": true,
                "fiveHourPct": 42.0,
                "sevenDayPct": 81.5,
                "minutesUntilReset": 45,
                "burnRateRatio": 0.5,
                "minutesUntilExhaustion": 360,
                "willExhaustBeforeReset": false,
                "pace": "safe",
                "useItOrLoseIt": true
              }
            ]
          },
          "auditTimeline": [
            {
              "id": "1",
              "at": "2026-11-14T18:10:00Z",
              "kind": "daemon-switch",
              "status": "ok",
              "summary": "Hesap geçişi: yahoo → gmail",
              "detail": "autoswitch"
            }
          ],
          "preferences": {
            "thresholdPct": 95,
            "refreshIntervalSec": 120,
            "notify": true,
            "launchAtLogin": true,
            "statusFile": "~/.polyctl/admin/status.json",
            "snoozed": false,
            "snoozeUntil": ""
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(ControlCenterPayload.self, from: sampleJson)
        precondition(decoded.ok, "decoded.ok must be true")
        precondition(decoded.activeAccount?.name == "gmail", "activeAccount.name must be gmail")
        precondition(decoded.accounts.first?.token.formattedRemaining == "2 saat", "token remaining must be 2 saat")
        precondition(decoded.otherQuotas?.last?.display == "okunamadı", "unreadable quota must display okunamadı")
        precondition(decoded.server?.load == "okunamadı", "unreadable server load must be okunamadı")
        precondition(decoded.server?.readOnly == true, "server must be readOnly")
        precondition(decoded.poolReadiness?.readyForRotation == 1, "poolReadiness.readyForRotation must be 1")
        precondition(decoded.poolResilience?.grade == "A", "poolResilience.grade must be A")
        precondition(decoded.failover.spendHealth?.utilizationPct == 13.6, "failover.spendHealth.utilizationPct must be 13.6")
        precondition(decoded.failover.costEstimate?.standardHoursCovered == 9.0, "failover.costEstimate.standardHoursCovered must be 9.0")
        precondition(decoded.quotaForecast?.recommendedAccount == "gmail", "quotaForecast.recommendedAccount must be gmail")
        precondition(decoded.auditTimeline?.first?.kind == "daemon-switch", "auditTimeline must decode daemon-switch")
        precondition(decoded.auditTimeline?.first?.matchesCategory("switch") == true, "audit event must match switch category")
        precondition(decoded.auditTimeline?.first?.matchesCategory("failover") == false, "switch event must not match failover category")
        precondition(decoded.weeklyResetCalendar?.nextResetAccount == "gmail", "weeklyResetCalendar.nextResetAccount must be gmail")
        precondition(decoded.multiProviderContinuity?.score == 85, "multiProviderContinuity.score must be 85")
        precondition(decoded.servicesHealth?.score == 100, "servicesHealth.score must be 100")
        precondition(decoded.sessionReadiness?.passedCount == 5, "sessionReadiness.passedCount must be 5")
        precondition(decoded.subscriptionRoi?.avgWeeklyUtilizationPct == 81.5, "subscriptionRoi.avgWeeklyUtilizationPct must be 81.5")
        precondition(decoded.bottleneckWindow?.peakHourUtc == 14, "bottleneckWindow.peakHourUtc must be 14")

        precondition(QuotaSeverity.from(usedPct: nil) == .unknown, "nil pct -> unknown")
        precondition(QuotaSeverity.from(usedPct: 45.0) == .normal, "45% -> normal")
        precondition(QuotaSeverity.from(usedPct: 80.0) == .warning, "80% -> warning")
        precondition(QuotaSeverity.from(usedPct: 95.0) == .critical, "95% -> critical")

        let switchConfirm = PendingConfirmationAction.switchAccount(account: "yahoo")
        precondition(switchConfirm.title.contains("yahoo"), "confirmation title must include target account")
        precondition(switchConfirm.message.contains("audit log"), "confirmation message must mention audit log")

        let snoozeConfirm = PendingConfirmationAction.toggleFocusSnooze(enable: true, snoozeUntil: "2026-11-14T19:00:00Z")
        precondition(snoozeConfirm.title.contains("Odak Modu"), "snooze confirmation must mention Odak Modu")

        let jobConfirm = PendingConfirmationAction.triggerDaemonJob(job: "refresh", title: "OAuth Ön-Isıtma")
        precondition(jobConfirm.id == "job-refresh", "jobConfirm id must be job-refresh")
        precondition(jobConfirm.message.contains("refresh"), "jobConfirm message must mention refresh")

        let client = DaemonClient(customSocketPath: "/tmp/nonexistent-keyflip-test.sock")
        precondition(client.resolveSocketPath() == "/tmp/nonexistent-keyflip-test.sock", "custom socket path must resolve")

        // Status board fixture test: sorting (bad -> warn -> ok -> unknown), owner_needed count, and 20-minute staleness
        let cwd = FileManager.default.currentDirectoryPath
        let fixturePath = (cwd as NSString).appendingPathComponent("test/fixtures/status.sample.json")
        guard let loaded = StatusBoardPayload.load(fromFile: fixturePath) else {
            preconditionFailure("Expected test/fixtures/status.sample.json to load")
        }
        let board = loaded.board
        precondition(board.ownerNeededCount == 2, "ownerNeededCount must be 2")
        precondition(board.sections.count == 2, "sections.count must be 2")
        precondition(board.totalIssueCount == 2, "totalIssueCount must be 2 (1 bad + 1 warn)")
        precondition(board.computedHealthPct == 65, "computedHealthPct for 2 ok + 1 warn + 1 unknown + 1 bad must be 65")

        // Muted row test
        let mutedSet: Set<String> = ["quotas::Test Hesabı"]
        precondition(board.unmutedIssueCount(mutedRowKeys: mutedSet) == 1, "unmutedIssueCount must drop to 1 when bad row is muted")
        let issuesWithMute = board.filteredSections(onlyIssues: true, searchQuery: "", mutedRowKeys: mutedSet)
        precondition(issuesWithMute.count == 1 && issuesWithMute[0].rows.count == 1, "muted row must be hidden in onlyIssues mode")

        let quotaRows = board.sections[0].sortedRows
        precondition(quotaRows.count == 3, "quotaRows.count must be 3")
        precondition(quotaRows[0].status == "bad", "first sorted row must be bad")
        precondition(quotaRows[1].status == "warn", "second sorted row must be warn")
        precondition(quotaRows[2].status == "ok", "third sorted row must be ok")

        // Since-age formatting test (fixture row[0] since is 2026-11-14T17:45:00Z)
        let refNow = StatusBoardPayload.parseISO8601("2026-11-14T18:30:00Z")!
        precondition(quotaRows[0].formattedSinceDuration(now: refNow) == "45 dk", "since duration must be 45 dk")

        // Issue-only filter test: sections with no bad/warn rows are omitted
        let onlyIssues = board.filteredSections(onlyIssues: true)
        precondition(onlyIssues.count == 1, "only quotas section has bad/warn issues")
        precondition(onlyIssues[0].id == "quotas", "filtered section must be quotas")
        precondition(onlyIssues[0].rows.count == 2, "quotas section has 2 issue rows (bad + warn)")

        // Search query filter test + Pinned section ordering test
        let searchFiltered = board.filteredSections(onlyIssues: false, searchQuery: "8787")
        precondition(searchFiltered.count == 1 && searchFiltered[0].id == "services", "search query '8787' must match services section")

        let pinnedOrder = board.orderedSections(pinnedIds: ["services"], onlyIssues: false, searchQuery: "")
        precondition(pinnedOrder.first?.id == "services", "pinned 'services' section must appear first")

        // Transition detection test: newlyDegradedRows(comparedTo:)
        var cleanPrev = board
        cleanPrev.sections = board.sections.map { sec in
            var copy = sec
            copy.rows = sec.rows.map { r in
                var rCopy = r
                if rCopy.status == "bad" { rCopy.status = "ok" }
                return rCopy
            }
            return copy
        }
        let degraded = board.newlyDegradedRows(comparedTo: cleanPrev)
        precondition(degraded.count == 1, "newlyDegradedRows must detect 1 newly bad row")

        // Round 11 decoding check for DaemonSchedulerHealthSummary & WeeklyUnclaimedQuotaSummary
        let r11Json = """
        {
          "score": 100,
          "status": "healthy",
          "totalJobs": 4,
          "healthyJobs": 4,
          "failingJobs": [],
          "overdueJobs": [],
          "summary": "Zamanlayıcı sağlıklı (4/4 iş zamanında)"
        }
        """.data(using: .utf8)!
        let r11Decoded = try JSONDecoder().decode(DaemonSchedulerHealthSummary.self, from: r11Json)
        precondition(r11Decoded.score == 100 && r11Decoded.status == "healthy", "DaemonSchedulerHealthSummary must decode accurately")

        // Round 12 decoding check for SonnetModelSplitSummary & ServiceLogHygieneSummary
        let r12Json = """
        {
          "hasBottleneck": true,
          "constrainedCount": 1,
          "maxDivergencePct": 39.0,
          "topConstrainedAccount": "gmail",
          "summary": "Sonnet alt-kota darboğazı: gmail (Sonnet %84, genel %45)"
        }
        """.data(using: .utf8)!
        let r12Decoded = try JSONDecoder().decode(SonnetModelSplitSummary.self, from: r12Json)
        precondition(r12Decoded.hasBottleneck == true && r12Decoded.topConstrainedAccount == "gmail", "SonnetModelSplitSummary must decode accurately")

        // Round 13 decoding check for UsageCacheFreshnessSummary & BackupGuardianContinuitySummary
        let r13Json = """
        {
          "score": 50,
          "status": "stale",
          "freshCount": 1,
          "staleCount": 1,
          "missingCount": 0,
          "maxAgeMinutes": 50,
          "staleAccounts": ["yahoo"],
          "summary": "Kota verisi bayat (1/2 hesap): yahoo"
        }
        """.data(using: .utf8)!
        let r13Decoded = try JSONDecoder().decode(UsageCacheFreshnessSummary.self, from: r13Json)
        precondition(r13Decoded.status == "stale" && r13Decoded.staleCount == 1, "UsageCacheFreshnessSummary must decode accurately")

        // Round 14 decoding check for AccountTierAlignmentSummary & FailoverChainRedundancySummary
        let r14Json = """
        {
          "enabled": true,
          "legCount": 2,
          "gatewayReady": true,
          "score": 100,
          "status": "redundant",
          "summary": "Failover zinciri yedekli (2 ayak hazır)"
        }
        """.data(using: .utf8)!
        let r14Decoded = try JSONDecoder().decode(FailoverChainRedundancySummary.self, from: r14Json)
        precondition(r14Decoded.legCount == 2 && r14Decoded.status == "redundant", "FailoverChainRedundancySummary must decode accurately")

        // Round 15 decoding check for FiveHourWindowStaggeringSummary & StatusBoardHotspotSummary
        let r15Json = """
        {
          "hasHotspot": true,
          "sectionId": "s2",
          "sectionTitle": "Altyapı",
          "badCount": 2,
          "warnCount": 1,
          "summary": "Odak darboğazı: Altyapı (2 kritik, 1 uyarı)"
        }
        """.data(using: .utf8)!
        let r15Decoded = try JSONDecoder().decode(StatusBoardHotspotSummary.self, from: r15Json)
        precondition(r15Decoded.hasHotspot == true && r15Decoded.badCount == 2, "StatusBoardHotspotSummary must decode accurately")

        // Round 16 decoding check for ActiveAccountSafetyCushionSummary & FleetWorkingUtilizationSummary
        let r16Json = """
        {
          "hasActive": true,
          "activeAccount": "gmail",
          "usedFiveHourPct": 84.0,
          "thresholdPct": 90.0,
          "cushionPct": 6.0,
          "status": "imminent",
          "summary": "Otomatik geçişe %6 kaldı (gmail: %84 / eşik %90)"
        }
        """.data(using: .utf8)!
        let r16Decoded = try JSONDecoder().decode(ActiveAccountSafetyCushionSummary.self, from: r16Json)
        precondition(r16Decoded.status == "imminent" && r16Decoded.cushionPct == 6.0, "ActiveAccountSafetyCushionSummary must decode accurately")

        // Round 17 decoding check for DualWindowBottleneckSummary & ServerOverallReadinessSummary
        let r17Json = """
        {
          "status": "constrained",
          "dominantConstraint": "seven-day",
          "sevenDayConstrainedCount": 1,
          "fiveHourConstrainedCount": 0,
          "bestEffectiveAccount": "yahoo",
          "bestEffectiveHeadroomPct": 70.0,
          "summary": "Çift pencere daralması: 1 hesapta 7g limit baskın (en geniş: yahoo %70 boş)"
        }
        """.data(using: .utf8)!
        let r17Decoded = try JSONDecoder().decode(DualWindowBottleneckSummary.self, from: r17Json)
        precondition(r17Decoded.dominantConstraint == "seven-day" && r17Decoded.bestEffectiveAccount == "yahoo", "DualWindowBottleneckSummary must decode accurately")

        // Round 18 decoding check for SecondaryPoolHeadroomSummary & ServiceHeartbeatFreshnessSummary
        let r18Json = """
        {
          "status": "ample",
          "readableCount": 2,
          "avgRemainingPct": 70.0,
          "bestFallbackId": "kiro",
          "bestFallbackLabel": "Kiro Kredisi",
          "summary": "İkincil havuz boşluğu: ort. %70 (2 yüzey · en geniş: Kiro Kredisi)"
        }
        """.data(using: .utf8)!
        let r18Decoded = try JSONDecoder().decode(SecondaryPoolHeadroomSummary.self, from: r18Json)
        precondition(r18Decoded.status == "ample" && r18Decoded.bestFallbackId == "kiro", "SecondaryPoolHeadroomSummary must decode accurately")

        // Round 19 decoding check for EffectivePoolMultiplierSummary & StatusBoardCleanSectionSummary
        let r19Json = """
        {
          "enabledCount": 2,
          "totalMultiplier": 6.0,
          "remainingMultiplier": 3.5,
          "utilizationPct": 42,
          "summary": "Havuz kapasite çarpanı: 6x (etkin kalan: 3.5x)"
        }
        """.data(using: .utf8)!
        let r19Decoded = try JSONDecoder().decode(EffectivePoolMultiplierSummary.self, from: r19Json)
        precondition(r19Decoded.totalMultiplier == 6.0 && r19Decoded.remainingMultiplier == 3.5, "EffectivePoolMultiplierSummary must decode accurately")

        // Round 20 decoding check for AutoswitchThresholdComplianceSummary & FleetIdleReserveSummary
        let r20Json = """
        {
          "thresholdPct": 90.0,
          "totalEnabled": 2,
          "belowThresholdCount": 1,
          "atOrAboveThresholdCount": 1,
          "exceedingAccounts": ["gmail"],
          "status": "partial",
          "summary": "Eşik uyumu: 1/2 hesap %90 altında (aşan: gmail)"
        }
        """.data(using: .utf8)!
        let r20Decoded = try JSONDecoder().decode(AutoswitchThresholdComplianceSummary.self, from: r20Json)
        precondition(r20Decoded.belowThresholdCount == 1 && r20Decoded.exceedingAccounts == ["gmail"], "AutoswitchThresholdComplianceSummary must decode accurately")

        // Round 21 decoding check for SustainablePoolBurnRateSummary & UrgentOwnerRatioSummary
        let r21Json = """
        {
          "measuredCount": 2,
          "avgBurnRateRatio": 1.2,
          "maxBurnRateRatio": 1.5,
          "fastestBurningAccount": "gmail",
          "sustainable": false,
          "status": "accelerated",
          "summary": "Yüksek tüketim ivmesi: ort. 1.2x (en hızlı: gmail 1.5x)"
        }
        """.data(using: .utf8)!
        let r21Decoded = try JSONDecoder().decode(SustainablePoolBurnRateSummary.self, from: r21Json)
        precondition(r21Decoded.sustainable == false && r21Decoded.fastestBurningAccount == "gmail", "SustainablePoolBurnRateSummary must decode accurately")

        // Round 22 decoding check for WeeklyPoolReserveCapacitySummary & StatusBoardSinceCoverageSummary
        let r22Json = """
        {
          "enabledCount": 2,
          "totalRemainingSevenDayPct": 110.0,
          "avgRemainingSevenDayPct": 55.0,
          "topReserveAccount": "yahoo",
          "topReservePct": 80.0,
          "status": "ample",
          "summary": "7g havuz rezervi: toplam %110 boş (ort. %55 · en geniş: yahoo %80)"
        }
        """.data(using: .utf8)!
        let r22Decoded = try JSONDecoder().decode(WeeklyPoolReserveCapacitySummary.self, from: r22Json)
        precondition(r22Decoded.topReserveAccount == "yahoo" && r22Decoded.totalRemainingSevenDayPct == 110.0, "WeeklyPoolReserveCapacitySummary must decode accurately")

        // Urgent owner_needed classification test
        let urgentOwner = StatusBoardOwnerItem(project: "prod", text: "ACİL müdahale")
        let normalOwner = StatusBoardOwnerItem(project: "docs", text: "Not ekle")
        precondition(urgentOwner.isUrgent == true, "urgentOwner must be classified as urgent")
        precondition(normalOwner.isUrgent == false, "normalOwner must not be classified as urgent")

        // Issues-only summary test
        let issuesOnlyMd = board.buildIssuesOnlySummary()
        precondition(issuesOnlyMd.contains("Açık Sorunlar"), "issues-only summary must include header")
        precondition(issuesOnlyMd.contains("[BAD]"), "issues-only summary must include BAD rows")
        precondition(!issuesOnlyMd.contains("[OK]"), "issues-only summary must exclude OK rows")

        // Markdown export test
        let md = board.buildMarkdownSummary(isStale: true)
        precondition(md.contains("(VERİ ESKİ)"), "markdown summary must indicate stale state")
        precondition(md.contains("Sahipten Bekleyen (2)"), "markdown summary must list owner_needed count")

        // Staleness check: fixture updated is 2026-11-14T18:20:00Z
        let freshNow = StatusBoardPayload.parseISO8601("2026-11-14T18:35:00Z")! // 15 min later -> fresh
        let staleNow = StatusBoardPayload.parseISO8601("2026-11-14T18:45:00Z")! // 25 min later -> stale (>20m)
        precondition(!board.isStale(now: freshNow), "15-minute-old board must NOT be stale")
        precondition(board.isStale(now: staleNow), "25-minute-old board MUST be stale (>20 min)")

        // Round 23 struct decoding check
        let r23Json = """
        {
          "enabledCount": 2,
          "avgFiveHourPct": 42.5,
          "maxFiveHourPct": 65.0,
          "minFiveHourPct": 20.0,
          "status": "low",
          "summary": "5s havuz ortalaması: %42.5 kullanım"
        }
        """.data(using: .utf8)!
        let r23Decoded = try JSONDecoder().decode(PoolAverageFiveHourUtilizationSummary.self, from: r23Json)
        precondition(r23Decoded.enabledCount == 2 && r23Decoded.avgFiveHourPct == 42.5, "PoolAverageFiveHourUtilizationSummary must decode")

        // Round 24 struct decoding check
        let r24Json = """
        {
          "totalStandbyCount": 2,
          "healthyStandbyCount": 1,
          "healthyStandbyRatioPct": 50,
          "status": "partial",
          "summary": "Sağlıklı yedek oranı: 1/2 yedek hesap hazır"
        }
        """.data(using: .utf8)!
        let r24Decoded = try JSONDecoder().decode(PoolHealthyStandbyRatioSummary.self, from: r24Json)
        precondition(r24Decoded.totalStandbyCount == 2 && r24Decoded.healthyStandbyRatioPct == 50, "PoolHealthyStandbyRatioSummary must decode")

        // Round 25 struct decoding check
        let r25Json = """
        {
          "enabledCount": 2,
          "maxSevenDayPct": 75.0,
          "minSevenDayPct": 20.0,
          "spreadSevenDayPct": 55.0,
          "highestAccount": "gmail",
          "lowestAccount": "yahoo",
          "status": "skewed",
          "summary": "7g tavan/taban makası: %55"
        }
        """.data(using: .utf8)!
        let r25Decoded = try JSONDecoder().decode(PoolPeakVsFloorSpreadSummary.self, from: r25Json)
        precondition(r25Decoded.enabledCount == 2 && r25Decoded.spreadSevenDayPct == 55.0, "PoolPeakVsFloorSpreadSummary must decode")

        // Missing file must return nil so section is hidden
        precondition(StatusBoardPayload.load(fromFile: "/tmp/definitely-missing-status-board-99999.json") == nil, "missing file must return nil")
    }
}

#if STANDALONE_TEST_RUNNER
@main
struct StandaloneTestMain {
    static func main() throws {
        try ModelsTestSuite.runAll()
        print("✔ KeyflipControlCenter Swift model, statusBoard fixture, search/pin, mute, resilience, costEstimate & confirmation tests passed")
    }
}
#else
final class ModelsTests: XCTestCase {
    func testAll() throws {
        try ModelsTestSuite.runAll()
    }
}
#endif
