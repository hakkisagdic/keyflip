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
        self.preferences = preferences
        self.warnings = warnings
    }
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
        cap: nil
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

public struct PreferencesSummary: Codable {
    public var thresholdPct: Double
    public var refreshIntervalSec: Int
    public var notify: Bool
    public var launchAtLogin: Bool
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
    case savePreferences(threshold: Int, refreshIntervalSec: Int, notify: Bool)

    public var id: String {
        switch self {
        case .switchAccount(let account): return "switch-\(account)"
        case .toggleFailover(let enable): return "failover-\(enable)"
        case .restartService(let label, _): return "restart-\(label)"
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
        case .savePreferences(let threshold, let refreshIntervalSec, let notify):
            return "Otomatik geçiş eşiği %\(threshold), kontrol aralığı \(refreshIntervalSec) sn, bildirimler \(notify ? "açık" : "kapalı") olarak güncellenecek."
        }
    }
}
