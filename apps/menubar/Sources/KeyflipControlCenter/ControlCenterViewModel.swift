import AppKit
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

    // External status board (watched from configured statusFile; nil if file does not exist)
    @Published public var statusBoard: StatusBoardPayload?
    @Published public var statusBoardStale: Bool = false
    @Published public var showOnlyIssuesInStatusBoard: Bool = false
    @Published public var statusBoardSearchQuery: String = ""
    @Published public var auditKindFilter: String = "all"
    @Published public var pinnedSectionIds: Set<String> = Set(
        UserDefaults.standard.stringArray(forKey: "menubar.pinnedSections") ?? []
    )
    @Published public var mutedRowKeys: Set<String> = Set(
        UserDefaults.standard.stringArray(forKey: "menubar.mutedRowKeys") ?? []
    )
    @Published public var compactMenuBarLabel: Bool = UserDefaults.standard.bool(forKey: "menubar.compactLabel") {
        didSet { UserDefaults.standard.set(compactMenuBarLabel, forKey: "menubar.compactLabel") }
    }

    // Editable preferences
    @Published public var prefThresholdPct: Double = 95
    @Published public var prefRefreshIntervalSec: Int = 120
    @Published public var prefNotify: Bool = true
    @Published public var prefLaunchAtLogin: Bool = false
    @Published public var prefStatusFile: String = UserDefaults.standard.string(forKey: "menubar.statusFile")
        ?? StatusBoardPayload.defaultRelativePath
    @Published public var prefExtraStatusFiles: String = UserDefaults.standard.string(forKey: "menubar.extraStatusFiles")
        ?? ""
    @Published public var preferencesLoaded: Bool = false

    private let client: DaemonClient
    private var timer: Timer?
    private var fileWatchTimer: Timer?
    private var lastObservedStatusMtime: Date?
    private var lastObservedStatusExists: Bool = false

    public init(client: DaemonClient = DaemonClient(), startPolling: Bool = true) {
        self.client = client
        reloadStatusBoard()
        if startPolling {
            refresh()
            scheduleTimer()
        }
    }

    public func togglePinSection(_ sectionId: String) {
        if pinnedSectionIds.contains(sectionId) {
            pinnedSectionIds.remove(sectionId)
        } else {
            pinnedSectionIds.insert(sectionId)
        }
        UserDefaults.standard.set(Array(pinnedSectionIds).sorted(), forKey: "menubar.pinnedSections")
    }

    public func rowMuteKey(sectionId: String, label: String) -> String {
        "\(sectionId)::\(label)"
    }

    public func isRowMuted(sectionId: String, label: String) -> Bool {
        mutedRowKeys.contains(rowMuteKey(sectionId: sectionId, label: label))
    }

    public func toggleMuteRow(sectionId: String, label: String) {
        let key = rowMuteKey(sectionId: sectionId, label: label)
        if mutedRowKeys.contains(key) {
            mutedRowKeys.remove(key)
        } else {
            mutedRowKeys.insert(key)
        }
        UserDefaults.standard.set(Array(mutedRowKeys).sorted(), forKey: "menubar.mutedRowKeys")
    }

    public func clearMutedRows() {
        mutedRowKeys.removeAll()
        UserDefaults.standard.removeObject(forKey: "menubar.mutedRowKeys")
    }

    public func scheduleTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 15.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
        fileWatchTimer?.invalidate()
        fileWatchTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.checkStatusFileIfChanged()
            }
        }
    }

    public func checkStatusFileIfChanged() {
        let expanded = StatusBoardPayload.resolvePath(prefStatusFile)
        let exists = FileManager.default.fileExists(atPath: expanded)
        let attrs = exists ? (try? FileManager.default.attributesOfItem(atPath: expanded)) : nil
        let mtime = attrs?[.modificationDate] as? Date
        if exists != lastObservedStatusExists || mtime != lastObservedStatusMtime {
            reloadStatusBoard()
        } else if let board = statusBoard {
            let newStale = board.isStale(now: Date(), fallbackModificationDate: mtime)
            if newStale != statusBoardStale {
                statusBoardStale = newStale
            }
        }
    }

    public func reloadStatusBoard(overridePath: String? = nil) {
        let previousBoard = self.statusBoard
        let configured = overridePath ?? prefStatusFile
        let expanded = StatusBoardPayload.resolvePath(configured)
        lastObservedStatusExists = FileManager.default.fileExists(atPath: expanded)
        let attrs = lastObservedStatusExists ? (try? FileManager.default.attributesOfItem(atPath: expanded)) : nil
        lastObservedStatusMtime = attrs?[.modificationDate] as? Date

        if let loaded = StatusBoardPayload.load(fromFile: configured, extraPaths: prefExtraStatusFiles) {
            let freshBad = loaded.board.newlyDegradedRows(comparedTo: previousBoard)
            if !freshBad.isEmpty {
                let labels = freshBad.map { $0.label }.joined(separator: ", ")
                self.statusBanner = "Yeni kritik durum tespit edildi: \(labels)"
            }
            self.statusBoard = loaded.board
            self.statusBoardStale = loaded.isStale
        } else if let daemonBoard = payload.statusBoard {
            var sorted = daemonBoard
            sorted.sections = daemonBoard.sections.map { sec in
                var copy = sec
                copy.rows = sec.sortedRows
                return copy
            }
            self.statusBoard = sorted
            self.statusBoardStale = sorted.isStale()
        } else {
            self.statusBoard = nil
            self.statusBoardStale = false
        }
    }

    public func copyIssuesOnlySummary() {
        guard let board = statusBoard else { return }
        let text = board.buildIssuesOnlySummary(mutedRowKeys: mutedRowKeys)
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        statusBanner = "Açık sorun özeti panoya kopyalandı."
    }

    public func copySummaryToPasteboard() {
        let text: String
        if let report = payload.markdownReport, !report.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            text = report
        } else if let board = statusBoard {
            text = board.buildMarkdownSummary(isStale: statusBoardStale)
        } else {
            text = "# Keyflip Kontrol Merkezi\nEtkin Hesap: \(menuBarAccountTitle)\n"
        }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        statusBanner = "Durum özeti panoya kopyalandı."
    }

    public func refresh() {
        reloadStatusBoard()
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
                        if let sf = prefs.statusFile, !sf.isEmpty {
                            self.prefStatusFile = sf
                            UserDefaults.standard.set(sf, forKey: "menubar.statusFile")
                        }
                        if let ef = prefs.extraStatusFiles {
                            self.prefExtraStatusFiles = ef
                            UserDefaults.standard.set(ef, forKey: "menubar.extraStatusFiles")
                        }
                        self.preferencesLoaded = true
                    }
                    self.reloadStatusBoard()
                    self.lastError = nil
                } else {
                    self.reloadStatusBoard()
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

    public var isFocusSnoozed: Bool {
        payload.preferences?.snoozed ?? false
    }

    public var ownerNeededBadgeCount: Int {
        statusBoard?.ownerNeededCount ?? 0
    }

    // MARK: - Confirmation Flow

    public func requestSwitchAccount(_ accountName: String) {
        pendingConfirmation = .switchAccount(account: accountName)
    }

    public func requestSwitchAccountBySlot(_ slotIndex: Int) {
        let enabled = payload.accounts.filter { $0.enabled }
        guard slotIndex >= 0 && slotIndex < enabled.count else { return }
        let target = enabled[slotIndex]
        guard !target.active else { return }
        pendingConfirmation = .switchAccount(account: target.name)
    }

    public func requestToggleFailover(enable: Bool) {
        pendingConfirmation = .toggleFailover(enable: enable)
    }

    public func requestRestartService(label: String, title: String) {
        pendingConfirmation = .restartService(label: label, title: title)
    }

    public func requestTriggerDaemonJob(job: String, title: String) {
        pendingConfirmation = .triggerDaemonJob(job: job, title: title)
    }

    public func requestToggleFocusSnooze() {
        let enable = !isFocusSnoozed
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime]
        let untilStr = enable ? fmt.string(from: Date().addingTimeInterval(60 * 60)) : ""
        pendingConfirmation = .toggleFocusSnooze(enable: enable, snoozeUntil: untilStr)
    }

    public func requestSavePreferences() {
        let cleanedPath = prefStatusFile.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectivePath = cleanedPath.isEmpty ? StatusBoardPayload.defaultRelativePath : cleanedPath
        prefStatusFile = effectivePath
        UserDefaults.standard.set(effectivePath, forKey: "menubar.statusFile")
        reloadStatusBoard(overridePath: effectivePath)

        pendingConfirmation = .savePreferences(
            threshold: Int(prefThresholdPct.rounded()),
            refreshIntervalSec: prefRefreshIntervalSec,
            notify: prefNotify,
            statusFile: effectivePath
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
                case .triggerDaemonJob(let job, _):
                    try clientRef.sendConfirmedCommand([
                        "cmd": "run-now",
                        "job": job,
                        "confirm": true
                    ])
                case .toggleFocusSnooze(_, let snoozeUntil):
                    try clientRef.sendConfirmedCommand([
                        "cmd": "config",
                        "confirm": true,
                        "set": [
                            "desktop.snoozeUntil": snoozeUntil
                        ]
                    ])
                case .savePreferences(let threshold, let refreshIntervalSec, let notify, let statusFile):
                    try clientRef.sendConfirmedCommand([
                        "cmd": "config",
                        "confirm": true,
                        "set": [
                            "autoswitch.threshold": threshold,
                            "daemon.autoswitchIntervalSeconds": refreshIntervalSec,
                            "notify.desktop": notify,
                            "menubar.statusFile": statusFile
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
                    self.reloadStatusBoard()
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
                    self.reloadStatusBoard()
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
