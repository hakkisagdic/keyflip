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
                daemonRunning: viewModel.daemonRunning
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

    public init(
        accountName: String,
        remainingPct: Int?,
        severity: QuotaSeverity,
        failoverEngaged: Bool,
        daemonRunning: Bool
    ) {
        self.accountName = accountName
        self.remainingPct = remainingPct
        self.severity = severity
        self.failoverEngaged = failoverEngaged
        self.daemonRunning = daemonRunning
    }

    public var body: some View {
        HStack(spacing: 4) {
            Image(systemName: daemonRunning ? severitySymbol : "bolt.slash")
            if let rem = remainingPct {
                Text("\(accountName) %\(rem)\(failoverEngaged ? " · YEDEK" : "")")
                    .font(.system(size: 12, design: .monospaced))
            } else {
                Text("\(accountName)\(failoverEngaged ? " · YEDEK" : "")")
                    .font(.system(size: 12, design: .monospaced))
            }
        }
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
