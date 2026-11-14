import SwiftUI

@main
struct KeyflipControlCenterApp: App {
    @StateObject private var viewModel = ControlCenterViewModel()

    var body: some Scene {
        MenuBarExtra {
            ControlCenterView(viewModel: viewModel)
        } label: {
            MenuBarGlanceLabel(
                accountName: viewModel.menuBarAccountTitle,
                remainingPct: viewModel.activeRemainingPct,
                severity: viewModel.menuBarSeverity,
                failoverEngaged: viewModel.isFailoverEngaged,
                daemonRunning: viewModel.daemonRunning,
                ownerNeededCount: viewModel.ownerNeededBadgeCount,
                compactMode: viewModel.compactMenuBarLabel
            )
        }
        .menuBarExtraStyle(.window)
    }
}

public struct MenuBarGlanceLabel: View {
    public let accountName: String
    public let remainingPct: Int?
    public let severity: QuotaSeverity
    public let failoverEngaged: Bool
    public let daemonRunning: Bool
    public let ownerNeededCount: Int
    public let compactMode: Bool

    public init(
        accountName: String,
        remainingPct: Int?,
        severity: QuotaSeverity,
        failoverEngaged: Bool,
        daemonRunning: Bool,
        ownerNeededCount: Int = 0,
        compactMode: Bool = false
    ) {
        self.accountName = accountName
        self.remainingPct = remainingPct
        self.severity = severity
        self.failoverEngaged = failoverEngaged
        self.daemonRunning = daemonRunning
        self.ownerNeededCount = ownerNeededCount
        self.compactMode = compactMode
    }

    public var body: some View {
        HStack(spacing: 4) {
            Image(systemName: daemonRunning ? severitySymbol : "bolt.slash")
            Text(labelText)
                .font(.system(size: 12, design: .monospaced))
        }
    }

    public var labelText: String {
        if compactMode {
            var parts: [String] = []
            if let rem = remainingPct { parts.append("%\(rem)") }
            if failoverEngaged { parts.append("Y") }
            if ownerNeededCount > 0 { parts.append("•\(ownerNeededCount)") }
            return parts.isEmpty ? String(accountName.prefix(2)) : parts.joined(separator: " ")
        }
        var base = accountName
        if let rem = remainingPct {
            base += " %\(rem)"
        }
        if failoverEngaged {
            base += " · YEDEK"
        }
        if ownerNeededCount > 0 {
            base += " •\(ownerNeededCount)"
        }
        return base
    }

    private var severitySymbol: String {
        if failoverEngaged {
            return "arrow.triangle.branch"
        }
        switch severity {
        case .normal: return "circle.fill"
        case .warning: return "exclamationmark.circle.fill"
        case .critical: return "xmark.octagon.fill"
        case .unknown: return "circle.dotted"
        }
    }
}
