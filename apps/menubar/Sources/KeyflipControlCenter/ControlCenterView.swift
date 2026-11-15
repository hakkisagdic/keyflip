import AppKit
import SwiftUI

public struct ControlCenterView: View {
    @ObservedObject var viewModel: ControlCenterViewModel
    @State private var showPreferences: Bool = false
    @State private var showAuditTimeline: Bool = false
    @State private var collapsedSectionIds: Set<String> = []

    public init(viewModel: ControlCenterViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider()

            if !viewModel.daemonRunning {
                daemonOfflineBanner
                Divider()
            }

            if let confirmAction = viewModel.pendingConfirmation {
                confirmationBanner(confirmAction)
                Divider()
            }

            if let err = viewModel.lastError {
                messageRow(icon: "exclamationmark.triangle.fill", color: .orange, text: err)
                Divider()
            } else if let note = viewModel.statusBanner {
                messageRow(icon: "checkmark.circle.fill", color: .green, text: note)
                Divider()
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let board = viewModel.statusBoard {
                        statusBoardSection(board)
                    }
                    accountsSection
                    failoverSection
                    otherQuotasSection
                    servicesSection
                    fleetAndServerSection
                    auditTimelineSection
                    if showPreferences {
                        preferencesSection
                    }
                }
                .padding(12)
            }

            Divider()
            footerBar
        }
        .frame(width: 400, height: 600)
    }

    // MARK: - Header & Banners

    private var headerBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusDotColor(for: viewModel.menuBarSeverity, online: viewModel.daemonRunning))
                .frame(width: 8, height: 8)

            Text("Keyflip Kontrol Merkezi")
                .font(.system(size: 13, weight: .semibold))

            if viewModel.isFailoverEngaged {
                Text("YEDEK ZİNCİR")
                    .font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.orange.opacity(0.2))
                    .foregroundColor(.orange)
                    .cornerRadius(4)
            }

            if viewModel.ownerNeededBadgeCount > 0 {
                Text("BEKLEYEN: \(viewModel.ownerNeededBadgeCount)")
                    .font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.orange.opacity(0.22))
                    .foregroundColor(.orange)
                    .cornerRadius(4)
            }

            Spacer()

            Button(action: { viewModel.requestToggleFocusSnooze() }) {
                Image(systemName: viewModel.isFocusSnoozed ? "moon.fill" : "moon")
                    .font(.system(size: 11))
                    .foregroundColor(viewModel.isFocusSnoozed ? .purple : .secondary)
            }
            .buttonStyle(.borderless)
            .disabled(!viewModel.daemonRunning || viewModel.isLoading)
            .help(viewModel.isFocusSnoozed ? "Odak Modu etkin (masaüstü restart ertelendi) — kapatmak için tıkla" : "Odak Modu: Otomatik Claude Desktop yeniden başlatmasını 60 dk ertele")

            Button(action: { viewModel.copySummaryToPasteboard() }) {
                Image(systemName: "doc.on.doc")
                    .font(.system(size: 11))
            }
            .buttonStyle(.borderless)
            .keyboardShortcut("c", modifiers: [.command, .shift])
            .help("Gizlilik korumalı durum özetini Markdown olarak kopyala (⌘⇧C)")

            Button(action: { viewModel.refresh() }) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12))
            }
            .buttonStyle(.borderless)
            .disabled(viewModel.isLoading)
            .help("Durumu yenile")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    private var daemonOfflineBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "bolt.slash.fill")
                .foregroundColor(.orange)
                .font(.system(size: 12))
            Text("daemon çalışmıyor — başlat")
                .font(.system(size: 12, weight: .medium))
            Spacer()
            Button("Başlat") {
                viewModel.startDaemonService()
            }
            .controlSize(.small)
            .disabled(viewModel.isLoading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.12))
    }

    private func confirmationBanner(_ action: PendingConfirmationAction) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(action.title)
                .font(.system(size: 12, weight: .semibold))
            Text(action.message)
                .font(.system(size: 11))
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Vazgeç") {
                    viewModel.cancelConfirmation()
                }
                .controlSize(.small)
                Button("Onayla") {
                    viewModel.executeConfirmedAction()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func messageRow(icon: String, color: Color, text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .foregroundColor(color)
                .font(.system(size: 11))
            Text(text)
                .font(.system(size: 11))
                .lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    // MARK: - 0. Durum Panosu (External Status Board - hidden if file missing)

    private func statusBoardSection(_ board: StatusBoardPayload) -> some View {
        let displayedSections = board.orderedSections(
            pinnedIds: viewModel.pinnedSectionIds,
            onlyIssues: viewModel.showOnlyIssuesInStatusBoard,
            searchQuery: viewModel.statusBoardSearchQuery,
            mutedRowKeys: viewModel.mutedRowKeys
        )
        let displayedOwners = board.filteredOwnerNeeded(searchQuery: viewModel.statusBoardSearchQuery)
        let allCollapsed = !displayedSections.isEmpty && displayedSections.allSatisfy { collapsedSectionIds.contains($0.id) }
        let activeIssuesCount = board.unmutedIssueCount(mutedRowKeys: viewModel.mutedRowKeys)
        let healthPct = board.computedHealthPct
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("DURUM PANOSU")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.secondary)

                Text("%\(healthPct) sağlıklı")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background((healthPct >= 85 ? Color.green : (healthPct >= 65 ? Color.orange : Color.red)).opacity(0.18))
                    .foregroundColor(healthPct >= 85 ? .green : (healthPct >= 65 ? .orange : .red))
                    .cornerRadius(3)

                if viewModel.statusBoardStale {
                    HStack(spacing: 3) {
                        Image(systemName: "clock.badge.exclamationmark")
                            .font(.system(size: 9))
                        Text("veri eski")
                            .font(.system(size: 9, weight: .semibold))
                    }
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Color.orange.opacity(0.2))
                    .foregroundColor(.orange)
                    .cornerRadius(3)
                }

                Spacer()

                if !viewModel.mutedRowKeys.isEmpty {
                    Button(action: { viewModel.clearMutedRows() }) {
                        Text("Sessiz (\(viewModel.mutedRowKeys.count))")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Sessize alınan satırları geri aç")
                }

                if !displayedSections.isEmpty {
                    Button(action: {
                        if allCollapsed {
                            collapsedSectionIds.removeAll()
                        } else {
                            collapsedSectionIds = Set(displayedSections.map { $0.id })
                        }
                    }) {
                        Text(allCollapsed ? "Genişlet" : "Daralt")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                }

                if board.totalIssueCount > 0 {
                    Button(action: {
                        viewModel.showOnlyIssuesInStatusBoard.toggle()
                    }) {
                        Text(viewModel.showOnlyIssuesInStatusBoard ? "Tümünü Göster" : "Yalnızca Sorunlar (\(activeIssuesCount))")
                            .font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(viewModel.showOnlyIssuesInStatusBoard ? Color.accentColor.opacity(0.2) : Color.secondary.opacity(0.15))
                            .cornerRadius(3)
                    }
                    .buttonStyle(.plain)
                }

                if let updated = board.updated, !updated.isEmpty {
                    Text(shortIsoTime(updated))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                    TextField("Durum panosunda filtrele…", text: $viewModel.statusBoardSearchQuery)
                        .textFieldStyle(.plain)
                        .font(.system(size: 11))
                    if !viewModel.statusBoardSearchQuery.isEmpty {
                        Button(action: { viewModel.statusBoardSearchQuery = "" }) {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 10))
                                .foregroundColor(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .background(Color.secondary.opacity(0.08))
                .cornerRadius(4)

                if !displayedOwners.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 5) {
                            Image(systemName: "bell.badge.fill")
                                .foregroundColor(.orange)
                                .font(.system(size: 10))
                            Text("Sahipten Bekleyen (\(displayedOwners.count))")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        ForEach(displayedOwners) { item in
                            HStack(alignment: .top, spacing: 6) {
                                Text(item.project)
                                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                    .foregroundColor(.orange)
                                Text(item.text)
                                    .font(.system(size: 11))
                                    .foregroundColor(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.1))
                    .cornerRadius(5)
                }

                ForEach(displayedSections) { sec in
                    let isExpanded = !collapsedSectionIds.contains(sec.id)
                    let isPinned = viewModel.pinnedSectionIds.contains(sec.id)
                    let sorted = sec.sortedRows
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Button(action: {
                                if isExpanded {
                                    collapsedSectionIds.insert(sec.id)
                                } else {
                                    collapsedSectionIds.remove(sec.id)
                                }
                            }) {
                                HStack(spacing: 6) {
                                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundColor(.secondary)
                                        .frame(width: 10)
                                    Text(sec.title)
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundColor(.primary)
                                    Spacer()
                                }
                            }
                            .buttonStyle(.plain)

                            Button(action: { viewModel.togglePinSection(sec.id) }) {
                                Image(systemName: isPinned ? "pin.fill" : "pin")
                                    .font(.system(size: 9))
                                    .foregroundColor(isPinned ? .accentColor : .secondary)
                            }
                            .buttonStyle(.plain)
                            .help(isPinned ? "Sabitlemeyi kaldır" : "Bu bölümü en üste sabitle")

                            if sec.badCount > 0 {
                                Text("\(sec.badCount) kritik")
                                    .font(.system(size: 9, weight: .semibold))
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .background(Color.red.opacity(0.18))
                                    .foregroundColor(.red)
                                    .cornerRadius(3)
                            }
                            if sec.warnCount > 0 {
                                Text("\(sec.warnCount) uyarı")
                                    .font(.system(size: 9, weight: .semibold))
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .background(Color.orange.opacity(0.18))
                                    .foregroundColor(.orange)
                                    .cornerRadius(3)
                            }
                            Text("\(sorted.count)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.secondary)
                        }

                        if isExpanded {
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(sorted) { row in
                                    let isRowMuted = viewModel.isRowMuted(sectionId: sec.id, label: row.label)
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                                            Circle()
                                                .fill(boardRowColor(row.status))
                                                .frame(width: 6, height: 6)
                                            Text(row.label)
                                                .font(.system(size: 11, weight: (row.status == "bad" || row.status == "warn") ? .medium : .regular))
                                                .foregroundColor(isRowMuted ? .secondary : .primary)
                                            Spacer()
                                            Text(row.value)
                                                .font(.system(size: 11, design: .monospaced))
                                                .foregroundColor(isRowMuted ? .secondary : (row.status == "bad" ? .red : (row.status == "warn" ? .orange : .primary)))
                                            if row.status == "bad" || row.status == "warn" {
                                                Button(action: {
                                                    viewModel.toggleMuteRow(sectionId: sec.id, label: row.label)
                                                }) {
                                                    Image(systemName: isRowMuted ? "bell.slash.fill" : "bell.slash")
                                                        .font(.system(size: 9))
                                                        .foregroundColor(isRowMuted ? .orange : .secondary)
                                                }
                                                .buttonStyle(.plain)
                                                .help(isRowMuted ? "Bu satırın uyarısını geri aç" : "Bu satırın uyarısını sessize al")
                                            }
                                        }
                                        if (row.detail != nil && !row.detail!.isEmpty) || (row.since != nil && !row.since!.isEmpty) {
                                            HStack(spacing: 6) {
                                                if let detail = row.detail, !detail.isEmpty {
                                                    Text(detail)
                                                        .font(.system(size: 10))
                                                        .foregroundColor(.secondary)
                                                        .lineLimit(1)
                                                }
                                                if let since = row.since, !since.isEmpty {
                                                    Spacer()
                                                    let ageText = row.formattedSinceDuration()
                                                    Text(ageText != nil ? "\(ageText!) · \(shortIsoTime(since))" : shortIsoTime(since))
                                                        .font(.system(size: 9, design: .monospaced))
                                                        .foregroundColor((row.status == "bad" || row.status == "warn") ? .orange : .secondary)
                                                }
                                            }
                                            .padding(.leading, 12)
                                        }
                                    }
                                }
                            }
                            .padding(.leading, 10)
                            .padding(.top, 2)
                        }
                    }
                    if sec.id != displayedSections.last?.id {
                        Divider()
                    }
                }
            }
            .padding(9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor))
            .cornerRadius(6)
        }
    }

    private func boardRowColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "bad": return .red
        case "warn": return .yellow
        case "ok": return .green
        default: return .secondary
        }
    }

    // MARK: - 1. Hesaplar (Accounts)

    private var accountsSection: some View {
        sectionBox(title: "HESAPLAR") {
            if viewModel.payload.accounts.isEmpty {
                Text("Kayıtlı Claude hesabı bulunamadı")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    if let pool = viewModel.payload.poolReadiness, !pool.summary.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: pool.status == "ok" ? "checkmark.shield.fill" : "exclamationmark.shield.fill")
                                .font(.system(size: 10))
                                .foregroundColor(pool.status == "ok" ? .green : .orange)
                            Text(pool.summary)
                                .font(.system(size: 10, weight: .medium))
                                .foregroundColor(.secondary)
                            if let res = viewModel.payload.poolResilience {
                                Text("· \(res.grade) (\(res.score))")
                                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                    .foregroundColor(res.score >= 80 ? .green : (res.score >= 55 ? .orange : .red))
                            }
                            Spacer()
                            Button("Ön-Isıt") {
                                viewModel.requestTriggerDaemonJob(job: "refresh", title: "OAuth Ön-Isıtma (refresh)")
                            }
                            .controlSize(.mini)
                            .disabled(!viewModel.daemonRunning || viewModel.isLoading)
                        }
                    }

                    if let cal = viewModel.payload.weeklyResetCalendar, let calSummary = cal.summary, !calSummary.isEmpty {
                        HStack(spacing: 5) {
                            Image(systemName: "calendar.badge.clock")
                                .font(.system(size: 10))
                                .foregroundColor(.secondary)
                            Text(calSummary)
                                .font(.system(size: 10))
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }
                    }

                    if let sr = viewModel.payload.sessionReadiness, !sr.summary.isEmpty {
                        HStack(spacing: 5) {
                            Image(systemName: sr.status == "ready" ? "bolt.fill" : "checklist")
                                .font(.system(size: 10))
                                .foregroundColor(sr.status == "ready" ? .green : .orange)
                            Text(sr.summary)
                                .font(.system(size: 10, weight: .medium))
                                .foregroundColor(sr.status == "ready" ? .green : .orange)
                            if let roi = viewModel.payload.subscriptionRoi, !roi.summary.isEmpty {
                                Text("· \(roi.summary)")
                                    .font(.system(size: 10))
                                    .foregroundColor(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }

                    if let rs = viewModel.payload.rotationStability, !rs.summary.isEmpty {
                        HStack(spacing: 5) {
                            Image(systemName: rs.status == "stable" ? "arrow.triangle.2.circlepath.circle.fill" : "exclamationmark.arrow.triangle.2.circlepath")
                                .font(.system(size: 10))
                                .foregroundColor(rs.status == "stable" ? .secondary : .orange)
                            Text(rs.summary)
                                .font(.system(size: 10))
                                .foregroundColor(rs.status == "stable" ? .secondary : .orange)
                                .lineLimit(1)
                        }
                    }

                    if let bw = viewModel.payload.bottleneckWindow, !bw.summary.isEmpty {
                        HStack(spacing: 5) {
                            Image(systemName: "gauge.with.dots.needle.67percent")
                                .font(.system(size: 10))
                                .foregroundColor(.secondary)
                            Text(bw.summary)
                                .font(.system(size: 10))
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }
                    }

                    if let forecast = viewModel.payload.quotaForecast,
                       let rec = forecast.recommendedAccount,
                       !rec.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: "sparkles")
                                .font(.system(size: 10))
                                .foregroundColor(.accentColor)
                            Text("Önerilen: \(rec)")
                                .font(.system(size: 10, weight: .semibold))
                            if let reason = forecast.recommendationReason, !reason.isEmpty {
                                Text("· \(reason)")
                                    .font(.system(size: 10))
                                    .foregroundColor(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                        }
                        .padding(6)
                        .background(Color.accentColor.opacity(0.08))
                        .cornerRadius(4)
                    }

                    ForEach(viewModel.payload.accounts) { acct in
                        let acctForecast = viewModel.payload.quotaForecast?.accounts?.first(where: { $0.name == acct.name })
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 6) {
                                Image(systemName: acct.active ? "checkmark.circle.fill" : "circle")
                                    .foregroundColor(acct.active ? .accentColor : .secondary)
                                    .font(.system(size: 11))

                                Text(acct.name)
                                    .font(.system(size: 12, weight: acct.active ? .semibold : .regular))

                                if !acct.email.isEmpty {
                                    Text(acct.email)
                                        .font(.system(size: 11))
                                        .foregroundColor(.secondary)
                                        .lineLimit(1)
                                }

                                Spacer()

                                if acct.active {
                                    Text("Etkin")
                                        .font(.system(size: 10, weight: .medium))
                                        .foregroundColor(.secondary)
                                } else if acct.enabled {
                                    Button("Geç") {
                                        viewModel.requestSwitchAccount(acct.name)
                                    }
                                    .controlSize(.mini)
                                    .disabled(!viewModel.daemonRunning || viewModel.isLoading)
                                }
                            }

                            HStack(spacing: 10) {
                                quotaMeter(label: "5s", pct: acct.fiveHourPct)
                                quotaMeter(label: "7g", pct: acct.sevenDayPct)
                            }

                            HStack(spacing: 8) {
                                Text("Token: \(acct.token.formattedRemaining)")
                                    .font(.system(size: 10))
                                    .foregroundColor(acct.token.status == "expired" ? .red : .secondary)

                                if let reset = acct.usage?.fiveHour?.resetsAt, !reset.isEmpty {
                                    Text("· Sıfırlama: \(shortIsoTime(reset))")
                                        .font(.system(size: 10))
                                        .foregroundColor(.secondary)
                                }

                                if let f = acctForecast, f.willExhaustBeforeReset, let mins = f.minutesUntilExhaustion {
                                    Text("· ~\(mins) dk sonra dolabilir")
                                        .font(.system(size: 10, weight: .medium))
                                        .foregroundColor(.orange)
                                }
                            }
                        }
                        if acct.id != viewModel.payload.accounts.last?.id {
                            Divider()
                        }
                    }
                }
            }
        }
    }

    private func quotaMeter(label: String, pct: Double?) -> some View {
        HStack(spacing: 5) {
            Text(label)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.secondary)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.secondary.opacity(0.18))
                    if let val = pct {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(quotaBarColor(usedPct: val))
                            .frame(width: max(2, geo.size.width * CGFloat(min(100, max(0, val)) / 100.0)))
                    }
                }
            }
            .frame(height: 5)
            Text(pct != nil ? "%\(Int(pct!.rounded()))" : "okunamadı")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.secondary)
                .frame(width: 54, alignment: .trailing)
        }
    }

    // MARK: - 2. Yedek Zincir (Failover)

    private var failoverSection: some View {
        let fo = viewModel.payload.failover
        return sectionBox(title: "YEDEK ZİNCİR (FAILOVER)") {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Circle()
                        .fill(fo.engaged ? Color.orange : (fo.gatewayReady ? Color.green : Color.secondary))
                        .frame(width: 7, height: 7)
                    Text(fo.engaged ? "Devrede" : (fo.enabled ? "Hazır (Beklemede)" : "Devre dışı"))
                        .font(.system(size: 12, weight: .medium))

                    Spacer()

                    Button(fo.engaged ? "Kapat" : "Aç") {
                        viewModel.requestToggleFailover(enable: !fo.engaged)
                    }
                    .controlSize(.mini)
                    .disabled(!viewModel.daemonRunning || viewModel.isLoading || !fo.enabled)
                }

                HStack(spacing: 12) {
                    if let cap = fo.cap, let maxUsd = cap.max {
                        let spentText = cap.spent != nil ? String(format: "$%.2f", cap.spent!) : "okunamadı"
                        Text("Harcama / Tavan: \(spentText) / \(String(format: "$%.2f", maxUsd))")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    } else {
                        Text("Harcama / Tavan: okunamadı")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }

                    if let alias = fo.alias, !alias.isEmpty {
                        Text("· \(alias)")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }
                }

                if let sim = fo.costEstimate, !sim.summary.isEmpty {
                    Text(sim.summary)
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }

                if let sh = fo.spendHealth, let alert = sh.alertReason, !alert.isEmpty {
                    Text(alert)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(sh.status == "critical" ? .red : .orange)
                }

                if let reason = fo.reason, fo.engaged {
                    Text("Neden: \(reason)")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }
            }
        }
    }

    // MARK: - 3. Diğer Kotalar (Other Quotas)

    private var otherQuotasSection: some View {
        let quotas = viewModel.payload.otherQuotas ?? []
        let cont = viewModel.payload.multiProviderContinuity
        let titleText = cont != nil ? "DİĞER KOTALAR · \(cont!.summary.uppercased())" : "DİĞER KOTALAR"
        return sectionBox(title: titleText) {
            if quotas.isEmpty {
                Text("okunamadı")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(quotas) { item in
                        HStack(alignment: .firstTextBaseline) {
                            Circle()
                                .fill(quotaItemDotColor(item.status))
                                .frame(width: 6, height: 6)
                            Text(item.label)
                                .font(.system(size: 11))
                            Spacer()
                            Text(item.display)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(item.status == "unreadable" ? .secondary : .primary)
                        }
                    }
                }
            }
        }
    }

    // MARK: - 4. Servisler (Services)

    private var servicesSection: some View {
        let services = viewModel.payload.services ?? []
        let sh = viewModel.payload.servicesHealth
        let titleText = sh != nil ? "SERVİSLER · \(sh!.summary.uppercased())" : "SERVİSLER"
        return sectionBox(title: titleText) {
            if services.isEmpty {
                Text("okunamadı")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(services) { svc in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Circle()
                                    .fill(serviceDotColor(svc.state))
                                    .frame(width: 7, height: 7)
                                Text(svc.title)
                                    .font(.system(size: 11, weight: .medium))
                                Text("(\(serviceStateLabel(svc.state)))")
                                    .font(.system(size: 10))
                                    .foregroundColor(.secondary)
                                if let spark = svc.sparkline, !spark.isEmpty {
                                    Text(spark)
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                                if svc.restartable {
                                    Button("Yeniden başlat") {
                                        viewModel.requestRestartService(label: svc.label, title: svc.title)
                                    }
                                    .controlSize(.mini)
                                    .disabled(!viewModel.daemonRunning || viewModel.isLoading)
                                }
                            }
                            if let lastSuccess = svc.lastSuccess, !lastSuccess.isEmpty {
                                Text("Son başarı: \(lastSuccess)")
                                    .font(.system(size: 10))
                                    .foregroundColor(.secondary)
                                    .lineLimit(1)
                            }
                            if let lastErr = svc.lastError, !lastErr.isEmpty {
                                Text("Son hata: \(lastErr)")
                                    .font(.system(size: 10))
                                    .foregroundColor(.orange)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - 5. Filo (Fleet) & 6. Sunucu (Server - Read-Only)

    private var fleetAndServerSection: some View {
        let serverHostTitle = (viewModel.payload.server?.host ?? "UZAK SUNUCU").uppercased()
        return VStack(alignment: .leading, spacing: 14) {
            let fleetEff = viewModel.payload.fleetEfficiency?.summary
            let fleetTitle = (fleetEff != nil && !fleetEff!.isEmpty) ? "FİLO (TRAYCER) · \(fleetEff!.uppercased())" : "FİLO (TRAYCER)"
            sectionBox(title: fleetTitle) {
                if let fleet = viewModel.payload.fleet {
                    HStack {
                        Text("Ajan Durumu:")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                        Spacer()
                        Text(fleet.display)
                            .font(.system(size: 11, design: .monospaced))
                    }
                } else {
                    Text("okunamadı")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
            }

            let srvSla = viewModel.payload.serverSitesHealth?.summary
            let srvTitle = (srvSla != nil && !srvSla!.isEmpty) ? "SUNUCU (\(serverHostTitle) · \(srvSla!.uppercased()))" : "SUNUCU (\(serverHostTitle) · SALT OKUNUR)"
            sectionBox(title: srvTitle) {
                if let srv = viewModel.payload.server {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("Yük / Bellek / Disk:")
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                            Spacer()
                            Text("\(srv.load) · \(srv.memory) · \(srv.disk)")
                                .font(.system(size: 11, design: .monospaced))
                        }
                        ForEach(srv.sites) { site in
                            HStack {
                                Text(site.name)
                                    .font(.system(size: 10))
                                    .foregroundColor(.secondary)
                                Spacer()
                                Text(site.detail)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundColor(site.status == "ok" ? .green : .secondary)
                            }
                        }
                    }
                } else {
                    Text("okunamadı")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
            }
        }
    }

    // MARK: - 6b. Son Olaylar (Mini Audit Timeline)

    private var auditTimelineSection: some View {
        let allEvents = viewModel.payload.auditTimeline ?? []
        let events = allEvents.filter { $0.matchesCategory(viewModel.auditKindFilter) }
        return VStack(alignment: .leading, spacing: 6) {
            Button(action: { showAuditTimeline.toggle() }) {
                HStack(spacing: 5) {
                    Image(systemName: showAuditTimeline ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(.secondary)
                    Text("SON OLAYLAR (DENETİM · \(events.count))")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.secondary)
                    Spacer()
                }
            }
            .buttonStyle(.plain)

            if showAuditTimeline {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 4) {
                        ForEach([("all", "Tümü"), ("switch", "Geçiş"), ("failover", "Failover"), ("service", "Servis")], id: \.0) { item in
                            Button(action: { viewModel.auditKindFilter = item.0 }) {
                                Text(item.1)
                                    .font(.system(size: 9, weight: viewModel.auditKindFilter == item.0 ? .semibold : .regular))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(viewModel.auditKindFilter == item.0 ? Color.accentColor.opacity(0.2) : Color.secondary.opacity(0.12))
                                    .cornerRadius(3)
                            }
                            .buttonStyle(.plain)
                        }
                        Spacer()
                    }
                    if events.isEmpty {
                        Text("Henüz kayıtlı denetim olayı yok")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    } else {
                        ForEach(events) { ev in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Circle()
                                    .fill(boardRowColor(ev.status))
                                    .frame(width: 6, height: 6)
                                Text(ev.summary)
                                    .font(.system(size: 11))
                                    .lineLimit(1)
                                Spacer()
                                if let at = ev.at, !at.isEmpty {
                                    Text(shortIsoTime(at))
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundColor(.secondary)
                                }
                            }
                        }
                    }
                }
                .padding(9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor))
                .cornerRadius(6)
            }
        }
    }

    // MARK: - 7. Tercihler (Preferences)

    private var preferencesSection: some View {
        sectionBox(title: "TERCİHLER") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Geçiş eşiği: %\(Int(viewModel.prefThresholdPct.rounded()))")
                        .font(.system(size: 11))
                    Slider(value: $viewModel.prefThresholdPct, in: 50...100, step: 5)
                }
                HStack {
                    Text("Yenileme aralığı (sn):")
                        .font(.system(size: 11))
                    Spacer()
                    Picker("", selection: $viewModel.prefRefreshIntervalSec) {
                        Text("60 sn").tag(60)
                        Text("120 sn").tag(120)
                        Text("300 sn").tag(300)
                    }
                    .frame(width: 100)
                }
                Toggle("Masaüstü bildirimleri", isOn: $viewModel.prefNotify)
                    .font(.system(size: 11))
                Toggle("Dar menü çubuğu etiketi (yalnızca % + rozet)", isOn: $viewModel.compactMenuBarLabel)
                    .font(.system(size: 11))

                VStack(alignment: .leading, spacing: 3) {
                    Text("Durum panosu dosyası:")
                        .font(.system(size: 11))
                    TextField(StatusBoardPayload.defaultRelativePath, text: $viewModel.prefStatusFile)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 11, design: .monospaced))
                }

                HStack {
                    Text("Oturum açıldığında başlat:")
                        .font(.system(size: 11))
                    Spacer()
                    Text(viewModel.prefLaunchAtLogin ? "Etkin (launchd)" : "Kapalı")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }

                HStack {
                    Spacer()
                    Button("Tercihleri Kaydet") {
                        viewModel.requestSavePreferences()
                    }
                    .controlSize(.small)
                    .disabled(viewModel.isLoading)
                }
            }
        }
    }

    // MARK: - Footer

    private var footerBar: some View {
        HStack {
            Button(showPreferences ? "Tercihleri Gizle" : "Tercihler…") {
                showPreferences.toggle()
            }
            .buttonStyle(.borderless)
            .font(.system(size: 11))

            HStack(spacing: 0) {
                Button("") { viewModel.requestSwitchAccountBySlot(0) }
                    .keyboardShortcut("1", modifiers: [.command])
                Button("") { viewModel.requestSwitchAccountBySlot(1) }
                    .keyboardShortcut("2", modifiers: [.command])
                Button("") { viewModel.requestSwitchAccountBySlot(2) }
                    .keyboardShortcut("3", modifiers: [.command])
            }
            .frame(width: 0, height: 0)
            .opacity(0)

            Spacer()

            Button("Çıkış") {
                NSApplication.shared.terminate(nil)
            }
            .buttonStyle(.borderless)
            .font(.system(size: 11))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: - Visual Helpers

    private func sectionBox<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(.secondary)
            VStack(alignment: .leading, spacing: 6) {
                content()
            }
            .padding(9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor))
            .cornerRadius(6)
        }
    }

    private func statusDotColor(for severity: QuotaSeverity, online: Bool) -> Color {
        guard online else { return .secondary }
        switch severity {
        case .normal: return .green
        case .warning: return .yellow
        case .critical: return .red
        case .unknown: return .secondary
        }
    }

    private func quotaBarColor(usedPct: Double) -> Color {
        switch QuotaSeverity.from(usedPct: usedPct) {
        case .normal: return .green
        case .warning: return .yellow
        case .critical: return .red
        case .unknown: return .secondary
        }
    }

    private func quotaItemDotColor(_ status: String) -> Color {
        switch status {
        case "ok": return .green
        case "warning": return .yellow
        case "exhausted": return .red
        default: return .secondary
        }
    }

    private func serviceDotColor(_ state: String) -> Color {
        switch state {
        case "running", "scheduled": return .green
        case "warning": return .yellow
        case "error": return .red
        default: return .secondary
        }
    }

    private func serviceStateLabel(_ state: String) -> String {
        switch state {
        case "running": return "çalışıyor"
        case "scheduled": return "zamanlanmış"
        case "warning": return "uyarı"
        case "error": return "hata"
        default: return "durdu"
        }
    }

    private func shortIsoTime(_ iso: String) -> String {
        if iso.count >= 16 {
            let start = iso.index(iso.startIndex, offsetBy: 11)
            let end = iso.index(iso.startIndex, offsetBy: 16)
            return String(iso[start..<end])
        }
        return iso
    }
}
