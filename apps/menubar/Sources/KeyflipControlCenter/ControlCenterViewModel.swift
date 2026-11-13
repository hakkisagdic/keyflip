import Combine
import Foundation
import SwiftUI

@MainActor
public final class ControlCenterViewModel: ObservableObject {
    @Published public var payload: ControlCenterPayload = ControlCenterPayload(daemonRunning: false)
    @Published public var daemonRunning: Bool = false
    @Published public var isLoading: Bool = false
    @Published public var lastError: String?
    @Published public var statusBanner: String?
    @Published public var pendingConfirmation: PendingConfirmationAction?

    // Editable preferences
    @Published public var prefThresholdPct: Double = 95
    @Published public var prefRefreshIntervalSec: Int = 120
    @Published public var prefNotify: Bool = true
    @Published public var prefLaunchAtLogin: Bool = false
    @Published public var preferencesLoaded: Bool = false

    private let client: DaemonClient
    private var timer: Timer?

    public init(client: DaemonClient = DaemonClient(), startPolling: Bool = true) {
        self.client = client
        if startPolling {
            refresh()
            scheduleTimer()
        }
    }

    public func scheduleTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 15.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
    }

    public func refresh() {
        guard !isLoading else { return }
        isLoading = true
        let clientRef = self.client

        Task.detached(priority: .userInitiated) {
            let result = clientRef.fetchControlCenter()
            await MainActor.run { [weak self] in
                guard let self = self else { return }
                self.isLoading = false
                self.daemonRunning = result.daemonRunning
                if let p = result.payload {
                    self.payload = p
                    if let prefs = p.preferences, !self.preferencesLoaded {
                        self.prefThresholdPct = prefs.thresholdPct
                        self.prefRefreshIntervalSec = prefs.refreshIntervalSec
                        self.prefNotify = prefs.notify
                        self.prefLaunchAtLogin = prefs.launchAtLogin
                        self.preferencesLoaded = true
                    }
                    self.lastError = nil
                } else {
                    self.lastError = result.error
                }
            }
        }
    }

    // MARK: - Menu Bar Summary Helpers

    public var menuBarAccountTitle: String {
        if !daemonRunning && payload.accounts.isEmpty {
            return "keyflip"
        }
        if let active = payload.activeAccount {
            return active.name
        }
        if let firstActive = payload.accounts.first(where: { $0.active }) {
            return firstActive.name
        }
        return "keyflip"
    }

    public var activeUsedPct: Double? {
        guard let active = payload.accounts.first(where: { $0.active }) else {
            return nil
        }
        return active.fiveHourPct ?? active.sevenDayPct
    }

    public var activeRemainingPct: Int? {
        guard let used = activeUsedPct else { return nil }
        return max(0, min(100, Int((100.0 - used).rounded())))
    }

    public var menuBarSeverity: QuotaSeverity {
        QuotaSeverity.from(usedPct: activeUsedPct)
    }

    public var isFailoverEngaged: Bool {
        payload.failover.engaged
    }

    // MARK: - Confirmation Flow

    public func requestSwitchAccount(_ accountName: String) {
        pendingConfirmation = .switchAccount(account: accountName)
    }

    public func requestToggleFailover(enable: Bool) {
        pendingConfirmation = .toggleFailover(enable: enable)
    }

    public func requestRestartService(label: String, title: String) {
        pendingConfirmation = .restartService(label: label, title: title)
    }

    public func requestSavePreferences() {
        pendingConfirmation = .savePreferences(
            threshold: Int(prefThresholdPct.rounded()),
            refreshIntervalSec: prefRefreshIntervalSec,
            notify: prefNotify
        )
    }

    public func cancelConfirmation() {
        pendingConfirmation = nil
    }

    public func executeConfirmedAction() {
        guard let action = pendingConfirmation else { return }
        pendingConfirmation = nil
        isLoading = true
        statusBanner = nil
        lastError = nil

        let clientRef = self.client
        Task.detached(priority: .userInitiated) {
            do {
                switch action {
                case .switchAccount(let account):
                    try clientRef.sendConfirmedCommand([
                        "cmd": "switch",
                        "account": account,
                        "confirm": true,
                        "reason": "menubar"
                    ])
                case .toggleFailover(let enable):
                    try clientRef.sendConfirmedCommand([
                        "cmd": "failover",
                        "action": enable ? "on" : "off",
                        "confirm": true,
                        "reason": "menubar"
                    ])
                case .restartService(let label, _):
                    try clientRef.sendConfirmedCommand([
                        "cmd": "service-restart",
                        "label": label,
                        "confirm": true
                    ])
                case .savePreferences(let threshold, let refreshIntervalSec, let notify):
                    try clientRef.sendConfirmedCommand([
                        "cmd": "config",
                        "confirm": true,
                        "set": [
                            "autoswitch.threshold": threshold,
                            "daemon.autoswitchIntervalSeconds": refreshIntervalSec,
                            "notify.desktop": notify
                        ]
                    ])
                }
                let updated = clientRef.fetchControlCenter()
                await MainActor.run { [weak self] in
                    guard let self = self else { return }
                    self.isLoading = false
                    self.daemonRunning = updated.daemonRunning
                    if let p = updated.payload {
                        self.payload = p
                    }
                    self.statusBanner = "İşlem tamamlandı ve denetim günlüğüne kaydedildi."
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self = self else { return }
                    self.isLoading = false
                    self.lastError = error.localizedDescription
                }
            }
        }
    }

    public func startDaemonService() {
        isLoading = true
        lastError = nil
        statusBanner = nil
        let clientRef = self.client

        Task.detached(priority: .userInitiated) {
            do {
                try clientRef.installAndStartDaemon()
                try await Task.sleep(nanoseconds: 700_000_000)
                let updated = clientRef.fetchControlCenter()
                await MainActor.run { [weak self] in
                    guard let self = self else { return }
                    self.isLoading = false
                    self.daemonRunning = updated.daemonRunning
                    if let p = updated.payload {
                        self.payload = p
                    }
                    self.statusBanner = "Keyflip daemon başlatıldı."
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self = self else { return }
                    self.isLoading = false
                    self.lastError = error.localizedDescription
                }
            }
        }
    }
}
