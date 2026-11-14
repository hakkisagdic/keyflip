import Foundation

public struct ControlCenterPayload: Codable {
    public var ok: Bool
    public var daemonRunning: Bool?
    public var daemon: DaemonMeta?
    public var activeAccount: ActiveAccountSummary?
    public var accounts: [AccountItem]
    public var usageThrottle: UsageThrottleInfo?
    public var failover: FailoverStatus
    public var otherQuotas: [OtherQuotaItem]?
    public var services: [ServiceItem]?
    public var fleet: FleetSummary?
    public var server: ServerSummary?
    public var statusBoard: StatusBoardPayload?
    public var poolReadiness: PoolReadinessSummary?
    public var poolResilience: PoolResilienceSummary?
    public var poolHorizon: PoolHorizonSummary?
    public var quotaForecast: QuotaForecastSummary?
    public var auditTimeline: [AuditEventItem]?
    public var markdownReport: String?
    public var preferences: PreferencesSummary?
    public var warnings: [DaemonWarning]?

    public init(
        ok: Bool = true,
        daemonRunning: Bool? = true,
        daemon: DaemonMeta? = nil,
        activeAccount: ActiveAccountSummary? = nil,
        accounts: [AccountItem] = [],
        usageThrottle: UsageThrottleInfo? = nil,
        failover: FailoverStatus = .empty,
        otherQuotas: [OtherQuotaItem]? = [],
        services: [ServiceItem]? = [],
        fleet: FleetSummary? = nil,
        server: ServerSummary? = nil,
        statusBoard: StatusBoardPayload? = nil,
        poolReadiness: PoolReadinessSummary? = nil,
        poolResilience: PoolResilienceSummary? = nil,
        poolHorizon: PoolHorizonSummary? = nil,
        quotaForecast: QuotaForecastSummary? = nil,
        auditTimeline: [AuditEventItem]? = [],
        markdownReport: String? = nil,
        preferences: PreferencesSummary? = nil,
        warnings: [DaemonWarning]? = []
    ) {
        self.ok = ok
        self.daemonRunning = daemonRunning
        self.daemon = daemon
        self.activeAccount = activeAccount
        self.accounts = accounts
        self.usageThrottle = usageThrottle
        self.failover = failover
        self.otherQuotas = otherQuotas
        self.services = services
        self.fleet = fleet
        self.server = server
        self.statusBoard = statusBoard
        self.poolReadiness = poolReadiness
        self.poolResilience = poolResilience
        self.poolHorizon = poolHorizon
        self.quotaForecast = quotaForecast
        self.auditTimeline = auditTimeline
        self.markdownReport = markdownReport
        self.preferences = preferences
        self.warnings = warnings
    }
}

public struct PoolResilienceSummary: Codable {
    public var score: Int
    public var grade: String
    public var spofRisk: Bool
    public var risks: [String]?
    public var summary: String

    public init(
        score: Int = 100,
        grade: String = "A",
        spofRisk: Bool = false,
        risks: [String]? = [],
        summary: String = ""
    ) {
        self.score = score
        self.grade = grade
        self.spofRisk = spofRisk
        self.risks = risks
        self.summary = summary
    }
}

public struct PoolHorizonSummary: Codable {
    public var enabledAccounts: Int
    public var totalRemainingFiveHourPct: Double
    public var estimatedPoolDepletionMinutes: Int

    public init(
        enabledAccounts: Int = 0,
        totalRemainingFiveHourPct: Double = 0,
        estimatedPoolDepletionMinutes: Int = 0
    ) {
        self.enabledAccounts = enabledAccounts
        self.totalRemainingFiveHourPct = totalRemainingFiveHourPct
        self.estimatedPoolDepletionMinutes = estimatedPoolDepletionMinutes
    }
}

public struct PoolReadinessSummary: Codable {
    public var status: String
    public var totalEnabled: Int
    public var healthyTokens: Int
    public var readyForRotation: Int
    public var needsPreWarm: [String]?
    public var summary: String

    public init(
        status: String = "ok",
        totalEnabled: Int = 0,
        healthyTokens: Int = 0,
        readyForRotation: Int = 0,
        needsPreWarm: [String]? = [],
        summary: String = ""
    ) {
        self.status = status
        self.totalEnabled = totalEnabled
        self.healthyTokens = healthyTokens
        self.readyForRotation = readyForRotation
        self.needsPreWarm = needsPreWarm
        self.summary = summary
    }
}

public struct FailoverSpendHealth: Codable {
    public var status: String
    public var utilizationPct: Double?
    public var burnUsdPerHour: Double?
    public var estimatedMinutesToCap: Int?
    public var alertReason: String?

    public init(
        status: String = "ok",
        utilizationPct: Double? = nil,
        burnUsdPerHour: Double? = nil,
        estimatedMinutesToCap: Int? = nil,
        alertReason: String? = nil
    ) {
        self.status = status
        self.utilizationPct = utilizationPct
        self.burnUsdPerHour = burnUsdPerHour
        self.estimatedMinutesToCap = estimatedMinutesToCap
        self.alertReason = alertReason
    }
}

public struct FailoverCostEstimate: Codable {
    public var lightHourlyUsd: Double
    public var standardHourlyUsd: Double
    public var heavyHourlyUsd: Double
    public var remainingUsd: Double
    public var standardHoursCovered: Double
    public var canCoverOneHourStandard: Bool
    public var summary: String

    public init(
        lightHourlyUsd: Double = 0.9,
        standardHourlyUsd: Double = 2.4,
        heavyHourlyUsd: Double = 6.0,
        remainingUsd: Double = 25.0,
        standardHoursCovered: Double = 10.4,
        canCoverOneHourStandard: Bool = true,
        summary: String = ""
    ) {
        self.lightHourlyUsd = lightHourlyUsd
        self.standardHourlyUsd = standardHourlyUsd
        self.heavyHourlyUsd = heavyHourlyUsd
        self.remainingUsd = remainingUsd
        self.standardHoursCovered = standardHoursCovered
        self.canCoverOneHourStandard = canCoverOneHourStandard
        self.summary = summary
    }
}

public struct AuditEventItem: Codable, Identifiable {
    public var id: String
    public var at: String?
    public var kind: String
    public var status: String
    public var summary: String
    public var detail: String?

    public init(
        id: String,
        at: String? = nil,
        kind: String,
        status: String = "ok",
        summary: String,
        detail: String? = nil
    ) {
        self.id = id
        self.at = at
        self.kind = kind
        self.status = status
        self.summary = summary
        self.detail = detail
    }
}

public struct QuotaForecastSummary: Codable {
    public var accounts: [AccountQuotaForecast]?
    public var recommendedAccount: String?
    public var recommendationReason: String?

    public init(
        accounts: [AccountQuotaForecast]? = nil,
        recommendedAccount: String? = nil,
        recommendationReason: String? = nil
    ) {
        self.accounts = accounts
        self.recommendedAccount = recommendedAccount
        self.recommendationReason = recommendationReason
    }
}

public struct AccountQuotaForecast: Codable, Identifiable {
    public var id: String { name }
    public var name: String
    public var active: Bool
    public var fiveHourPct: Double?
    public var sevenDayPct: Double?
    public var minutesUntilReset: Int?
    public var burnRateRatio: Double?
    public var minutesUntilExhaustion: Int?
    public var willExhaustBeforeReset: Bool
    public var pace: String
    public var useItOrLoseIt: Bool
    public var weeklyEfficiency: String?
}

public struct DaemonMeta: Codable {
    public var pid: Int?
    public var startedAt: String?
    public var uptimeSeconds: Int?
    public var socketPath: String?
    public var logPath: String?
}

public struct ActiveAccountSummary: Codable {
    public var name: String
    public var email: String?
    public var tier: String?
}

public struct AccountItem: Codable, Identifiable {
    public var id: String { name }
    public var name: String
    public var email: String
    public var tier: String?
    public var enabled: Bool
    public var active: Bool
    public var token: AccountTokenStatus
    public var usage: AccountUsage?

    public var fiveHourPct: Double? {
        usage?.fiveHour?.pct
    }

    public var sevenDayPct: Double? {
        usage?.sevenDay?.pct
    }

    public var dominantUsedPct: Double? {
        switch (fiveHourPct, sevenDayPct) {
        case let (a?, b?): return max(a, b)
        case let (a?, nil): return a
        case let (nil, b?): return b
        case (nil, nil): return nil
        }
    }
}

public struct AccountTokenStatus: Codable {
    public var status: String
    public var expiresAt: String?
    public var remainingMs: Double?
    public var refreshable: Bool
    public var lastResult: String?
    public var lastRefreshAt: String?
    public var lastError: String?

    public var formattedRemaining: String {
        guard let ms = remainingMs else { return "okunamadı" }
        if ms <= 0 { return "süresi doldu" }
        let totalMinutes = Int(ms / 60000.0)
        if totalMinutes < 60 {
            return "\(totalMinutes) dk"
        }
        let hours = totalMinutes / 60
        let mins = totalMinutes % 60
        if hours < 48 {
            return mins > 0 ? "\(hours)s \(mins)dk" : "\(hours) saat"
        }
        let days = hours / 24
        return "\(days) gün"
    }
}

public struct AccountUsage: Codable {
    public var fiveHour: UsageWindow?
    public var sevenDay: UsageWindow?
    public var sevenDaySonnet: UsageWindow?
    public var effectiveHeadroom: Double?
    public var stale: Bool?
    public var fetchedAt: String?
}

public struct UsageWindow: Codable {
    public var pct: Double?
    public var resetsAt: String?
}

public struct UsageThrottleInfo: Codable {
    public var throttled: Bool
    public var retryAt: String?
    public var strike: Int?
}

public struct FailoverStatus: Codable {
    public var enabled: Bool
    public var engaged: Bool
    public var manual: Bool
    public var since: String?
    public var fromAccount: String?
    public var reason: String?
    public var recoverAt: String?
    public var alias: String?
    public var legs: [String]?
    public var gatewayUrl: String?
    public var gatewayReady: Bool
    public var gatewayReason: String?
    public var cap: FailoverCap?
    public var spendHealth: FailoverSpendHealth?
    public var costEstimate: FailoverCostEstimate?

    public static let empty = FailoverStatus(
        enabled: false,
        engaged: false,
        manual: false,
        since: nil,
        fromAccount: nil,
        reason: nil,
        recoverAt: nil,
        alias: nil,
        legs: nil,
        gatewayUrl: nil,
        gatewayReady: false,
        gatewayReason: nil,
        cap: nil,
        spendHealth: nil,
        costEstimate: nil
    )
}

public struct FailoverCap: Codable {
    public var max: Double?
    public var spent: Double?
    public var remaining: Double?
    public var period: String?
    public var exceeded: Bool?
    public var windowStatus: String?
}

public struct OtherQuotaItem: Codable, Identifiable {
    public var id: String
    public var label: String
    public var status: String
    public var display: String
    public var usedPct: Double?
    public var detail: String?
    public var updatedAt: String?
    public var source: String?
}

public struct ServiceItem: Codable, Identifiable {
    public var id: String
    public var label: String
    public var title: String
    public var kind: String
    public var loaded: Bool
    public var running: Bool
    public var pid: Int?
    public var lastExitStatus: Int?
    public var state: String
    public var lastSuccess: String?
    public var lastError: String?
    public var heartbeatAgeMin: Int?
    public var sparkline: String?
    public var lastLine: String?
    public var restartable: Bool
}

public struct FleetSummary: Codable {
    public var status: String
    public var display: String
    public var working: Int?
    public var idle: Int?
    public var stuck: Int?
    public var dormant: Int?
    public var total: Int?
    public var updatedAt: String?
}

public struct ServerSummary: Codable {
    public var host: String
    public var status: String
    public var load: String
    public var memory: String
    public var disk: String
    public var sites: [ServerSiteItem]
    public var updatedAt: String?
    public var readOnly: Bool
}

public struct ServerSiteItem: Codable, Identifiable {
    public var id: String { name }
    public var name: String
    public var status: String
    public var code: Int?
    public var detail: String
}

// MARK: - Generic Status Board Schema (status.json)

public struct StatusBoardPayload: Codable {
    public static let defaultRelativePath = "~/.polyctl/admin/status.json"
    public static let staleThresholdSeconds: TimeInterval = 20 * 60

    public var host: String?
    public var updated: String?
    public var healthPct: Int?
    public var healthSummary: String?
    public var sections: [StatusBoardSection]
    public var owner_needed: [StatusBoardOwnerItem]?

    public init(
        host: String? = nil,
        updated: String? = nil,
        healthPct: Int? = nil,
        healthSummary: String? = nil,
        sections: [StatusBoardSection] = [],
        owner_needed: [StatusBoardOwnerItem]? = nil
    ) {
        self.host = host
        self.updated = updated
        self.healthPct = healthPct
        self.healthSummary = healthSummary
        self.sections = sections
        self.owner_needed = owner_needed
    }

    public var ownerNeededItems: [StatusBoardOwnerItem] {
        owner_needed ?? []
    }

    public var ownerNeededCount: Int {
        ownerNeededItems.count
    }

    public var totalIssueCount: Int {
        sections.reduce(0) { $0 + $1.badCount + $1.warnCount }
    }

    public func unmutedIssueCount(mutedRowKeys: Set<String> = []) -> Int {
        sections.reduce(0) { acc, sec in
            let count = sec.rows.filter { row in
                (row.status == "bad" || row.status == "warn") && !mutedRowKeys.contains("\(sec.id)::\(row.label)")
            }.count
            return acc + count
        }
    }

    public var computedHealthPct: Int {
        if let explicit = healthPct { return explicit }
        var total = 0
        var weighted = 0.0
        for sec in sections {
            for r in sec.rows {
                total += 1
                switch r.status.lowercased() {
                case "ok": weighted += 1.0
                case "warn": weighted += 0.5
                case "bad": weighted += 0.0
                default: weighted += 0.75
                }
            }
        }
        guard total > 0 else { return 100 }
        return Int(((weighted / Double(total)) * 100.0).rounded())
    }

    public func filteredOwnerNeeded(searchQuery: String = "") -> [StatusBoardOwnerItem] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return ownerNeededItems }
        return ownerNeededItems.filter { item in
            item.project.lowercased().contains(query) || item.text.lowercased().contains(query)
        }
    }

    public func filteredSections(
        onlyIssues: Bool,
        searchQuery: String = "",
        mutedRowKeys: Set<String> = []
    ) -> [StatusBoardSection] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return sections.compactMap { sec in
            let sectionTitleMatches = !query.isEmpty && sec.title.lowercased().contains(query)
            let rows = sec.sortedRows.filter { row in
                let isMuted = mutedRowKeys.contains("\(sec.id)::\(row.label)")
                if onlyIssues {
                    if isMuted { return false }
                    if row.status != "bad" && row.status != "warn" { return false }
                }
                if query.isEmpty || sectionTitleMatches {
                    return true
                }
                return row.matchesSearch(query)
            }
            guard !rows.isEmpty else { return nil }
            return StatusBoardSection(id: sec.id, title: sec.title, rows: rows)
        }
    }

    public func orderedSections(
        pinnedIds: Set<String> = [],
        onlyIssues: Bool = false,
        searchQuery: String = "",
        mutedRowKeys: Set<String> = []
    ) -> [StatusBoardSection] {
        let filtered = filteredSections(onlyIssues: onlyIssues, searchQuery: searchQuery, mutedRowKeys: mutedRowKeys)
        guard !pinnedIds.isEmpty else { return filtered }
        let pinned = filtered.filter { pinnedIds.contains($0.id) }
        let unpinned = filtered.filter { !pinnedIds.contains($0.id) }
        return pinned + unpinned
    }

    public func newlyDegradedRows(comparedTo previous: StatusBoardPayload?) -> [StatusBoardRow] {
        guard let prev = previous else { return [] }
        var prevBadKeys: Set<String> = []
        for sec in prev.sections {
            for r in sec.rows where r.status == "bad" {
                prevBadKeys.insert("\(sec.id)::\(r.label)")
            }
        }
        var freshBad: [StatusBoardRow] = []
        for sec in sections {
            for r in sec.rows where r.status == "bad" {
                let key = "\(sec.id)::\(r.label)"
                if !prevBadKeys.contains(key) {
                    freshBad.append(r)
                }
            }
        }
        return freshBad
    }

    public func buildMarkdownSummary(isStale: Bool = false) -> String {
        var lines: [String] = []
        lines.append("# Durum Panosu Özeti\(isStale ? " (VERİ ESKİ)" : "")")
        if let u = updated {
            lines.append("Güncelleme: \(u)")
        }
        if !ownerNeededItems.isEmpty {
            lines.append("\n## Sahipten Bekleyen (\(ownerNeededItems.count))")
            for item in ownerNeededItems {
                lines.append("- **[\(item.project)]** \(item.text)")
            }
        }
        for sec in sections {
            let rows = sec.sortedRows
            guard !rows.isEmpty else { continue }
            lines.append("\n## \(sec.title)")
            for r in rows {
                let d = (r.detail?.isEmpty == false) ? " — \(r.detail!)" : ""
                lines.append("- [\(r.status.uppercased())] **\(r.label)**: \(r.value)\(d)")
            }
        }
        return lines.joined(separator: "\n")
    }

    public func isStale(now: Date = Date(), fallbackModificationDate: Date? = nil) -> Bool {
        if let updatedStr = updated, let parsed = Self.parseISO8601(updatedStr) {
            return now.timeIntervalSince(parsed) > Self.staleThresholdSeconds
        }
        if let mtime = fallbackModificationDate {
            return now.timeIntervalSince(mtime) > Self.staleThresholdSeconds
        }
        return true
    }

    public static func parseISO8601(_ string: String) -> Date? {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let frac = ISO8601DateFormatter()
        frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = frac.date(from: trimmed) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: trimmed)
    }

    public static func resolvePath(_ configuredPath: String?) -> String {
        let raw = (configuredPath?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
            ?? ProcessInfo.processInfo.environment["KEYFLIP_STATUS_FILE"]
            ?? Self.defaultRelativePath
        return (raw as NSString).expandingTildeInPath
    }

    public static func load(fromFile path: String, extraPaths: String? = nil) -> (board: StatusBoardPayload, isStale: Bool)? {
        let expanded = resolvePath(path)
        guard FileManager.default.fileExists(atPath: expanded),
              let data = try? Data(contentsOf: URL(fileURLWithPath: expanded)),
              var decoded = try? JSONDecoder().decode(StatusBoardPayload.self, from: data)
        else {
            return nil
        }

        if let extrasRaw = extraPaths, !extrasRaw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let parts = extrasRaw.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            var ownerList = decoded.owner_needed ?? []
            for extra in parts where !extra.isEmpty {
                let expExtra = (extra as NSString).expandingTildeInPath
                guard FileManager.default.fileExists(atPath: expExtra),
                      let extraData = try? Data(contentsOf: URL(fileURLWithPath: expExtra)),
                      let extraBoard = try? JSONDecoder().decode(StatusBoardPayload.self, from: extraData)
                else { continue }

                let prefix = (extraBoard.host?.isEmpty == false) ? "[\(extraBoard.host!)] " : ""
                for extraSec in extraBoard.sections {
                    let taggedRows = extraSec.rows.map { r -> StatusBoardRow in
                        var copy = r
                        if !prefix.isEmpty { copy.label = "\(prefix)\(r.label)" }
                        return copy
                    }
                    if let idx = decoded.sections.firstIndex(where: { $0.id == extraSec.id }) {
                        decoded.sections[idx].rows.append(contentsOf: taggedRows)
                    } else {
                        decoded.sections.append(StatusBoardSection(id: extraSec.id, title: extraSec.title, rows: taggedRows))
                    }
                }
                if let extraOwners = extraBoard.owner_needed {
                    for item in extraOwners {
                        let proj = prefix.isEmpty ? item.project : "\(prefix)\(item.project)"
                        ownerList.append(StatusBoardOwnerItem(project: proj, text: item.text))
                    }
                }
            }
            decoded.owner_needed = ownerList
        }

        decoded.sections = decoded.sections.map { sec in
            var copy = sec
            copy.rows = sec.sortedRows
            return copy
        }
        let attrs = try? FileManager.default.attributesOfItem(atPath: expanded)
        let mtime = attrs?[.modificationDate] as? Date
        return (decoded, decoded.isStale(now: Date(), fallbackModificationDate: mtime))
    }
}

public struct StatusBoardSection: Codable, Identifiable {
    public var id: String
    public var title: String
    public var rows: [StatusBoardRow]

    public init(id: String, title: String, rows: [StatusBoardRow] = []) {
        self.id = id
        self.title = title
        self.rows = rows
    }

    /// Stable sort placing `bad` first, `warn` second, `ok` third, and `unknown` last.
    public var sortedRows: [StatusBoardRow] {
        rows.enumerated()
            .sorted { lhs, rhs in
                let lRank = lhs.element.statusRank
                let rRank = rhs.element.statusRank
                if lRank != rRank {
                    return lRank < rRank
                }
                return lhs.offset < rhs.offset
            }
            .map { $0.element }
    }

    public var badCount: Int {
        rows.filter { $0.status == "bad" }.count
    }

    public var warnCount: Int {
        rows.filter { $0.status == "warn" }.count
    }
}

public struct StatusBoardRow: Codable, Identifiable {
    public var id: String { "\(label)-\(value)-\(status)" }
    public var label: String
    public var value: String
    public var status: String
    public var detail: String?
    public var since: String?
    public var sinceAge: String?

    public init(
        label: String,
        value: String,
        status: String,
        detail: String? = nil,
        since: String? = nil,
        sinceAge: String? = nil
    ) {
        self.label = label
        self.value = value
        self.status = status
        self.detail = detail
        self.since = since
        self.sinceAge = sinceAge
    }

    public var statusRank: Int {
        switch status.lowercased() {
        case "bad": return 0
        case "warn": return 1
        case "ok": return 2
        default: return 3
        }
    }

    public func matchesSearch(_ lowercaseQuery: String) -> Bool {
        if lowercaseQuery.isEmpty { return true }
        if label.lowercased().contains(lowercaseQuery) { return true }
        if value.lowercased().contains(lowercaseQuery) { return true }
        if let d = detail, d.lowercased().contains(lowercaseQuery) { return true }
        return false
    }

    public func formattedSinceDuration(now: Date = Date()) -> String? {
        if let precomputed = sinceAge, !precomputed.isEmpty {
            return precomputed
        }
        guard let sinceStr = since, let parsed = StatusBoardPayload.parseISO8601(sinceStr) else {
            return nil
        }
        let elapsedSec = now.timeIntervalSince(parsed)
        guard elapsedSec >= 0 else { return nil }
        let totalMin = max(1, Int((elapsedSec / 60.0).rounded()))
        if totalMin < 60 {
            return "\(totalMin) dk"
        }
        let hours = totalMin / 60
        let mins = totalMin % 60
        if hours < 48 {
            return mins > 0 ? "\(hours)s \(mins)dk" : "\(hours) saat"
        }
        let days = hours / 24
        return "\(days) gün"
    }
}

public struct StatusBoardOwnerItem: Codable, Identifiable {
    public var id: String { "\(project):\(text)" }
    public var project: String
    public var text: String

    public init(project: String, text: String) {
        self.project = project
        self.text = text
    }
}

public struct PreferencesSummary: Codable {
    public var thresholdPct: Double
    public var refreshIntervalSec: Int
    public var notify: Bool
    public var launchAtLogin: Bool
    public var statusFile: String?
    public var extraStatusFiles: String?
    public var snoozeUntil: String?
    public var snoozed: Bool?
}

public struct DaemonWarning: Codable, Identifiable {
    public var id: String
    public var severity: String
    public var title: String
    public var detail: String?
    public var fix: String?
}

public enum QuotaSeverity: String {
    case normal
    case warning
    case critical
    case unknown

    public static func from(usedPct: Double?) -> QuotaSeverity {
        guard let pct = usedPct else { return .unknown }
        if pct >= 90.0 { return .critical }
        if pct >= 75.0 { return .warning }
        return .normal
    }
}

public enum PendingConfirmationAction: Identifiable {
    case switchAccount(account: String)
    case toggleFailover(enable: Bool)
    case restartService(label: String, title: String)
    case toggleFocusSnooze(enable: Bool, snoozeUntil: String)
    case triggerDaemonJob(job: String, title: String)
    case savePreferences(threshold: Int, refreshIntervalSec: Int, notify: Bool, statusFile: String)

    public var id: String {
        switch self {
        case .switchAccount(let account): return "switch-\(account)"
        case .toggleFailover(let enable): return "failover-\(enable)"
        case .restartService(let label, _): return "restart-\(label)"
        case .toggleFocusSnooze(let enable, _): return "snooze-\(enable)"
        case .triggerDaemonJob(let job, _): return "job-\(job)"
        case .savePreferences: return "save-prefs"
        }
    }

    public var title: String {
        switch self {
        case .switchAccount(let account):
            return "'\(account)' hesabına geçilsin mi?"
        case .toggleFailover(let enable):
            return enable ? "Yedek zincir (Failover) devreye alınsın mı?" : "Yedek zincir (Failover) kapatılsın mı?"
        case .restartService(_, let title):
            return "'\(title)' servisi yeniden başlatılsın mı?"
        case .toggleFocusSnooze(let enable, _):
            return enable ? "Odak Modu (60 dk masaüstü restart erteleme) açılsın mı?" : "Odak Modu (erteleme) kapatılsın mı?"
        case .triggerDaemonJob(_, let title):
            return "'\(title)' görevi şimdi çalıştırılsın mı?"
        case .savePreferences:
            return "Tercih değişiklikleri kaydedilsin mi?"
        }
    }

    public var message: String {
        switch self {
        case .switchAccount(let account):
            return "Etkin Claude hesabı '\(account)' olarak değiştirilecek ve denetim günlüğüne (audit log) kaydedilecek."
        case .toggleFailover(let enable):
            return enable
                ? "Claude istekleri Keysmith yedek zinciri üzerinden yönlendirilecek ve denetim günlüğüne kaydedilecek."
                : "Yedek zincir devre dışı bırakılıp normal hesaba dönülecek ve denetim günlüğüne kaydedilecek."
        case .restartService(let label, _):
            return "launchctl kickstart -k (\(label)) komutu çalıştırılacak ve denetim günlüğüne kaydedilecek."
        case .toggleFocusSnooze(let enable, let snoozeUntil):
            return enable
                ? "Otomatik Claude Desktop yeniden başlatmaları '\(snoozeUntil)' zamanına kadar ertelenecek ve audit log'a kaydedilecek."
                : "Masaüstü yeniden başlatma ertelemesi kaldırılacak ve audit log'a kaydedilecek."
        case .triggerDaemonJob(let job, _):
            return "Daemon üzerinde '\(job)' görevi anında tetiklenecek ve denetim günlüğüne kaydedilecek."
        case .savePreferences(let threshold, let refreshIntervalSec, let notify, let statusFile):
            return "Otomatik geçiş eşiği %\(threshold), kontrol aralığı \(refreshIntervalSec) sn, bildirimler \(notify ? "açık" : "kapalı"), durum panosu yolu '\(statusFile)' olarak güncellenecek."
        }
    }
}
