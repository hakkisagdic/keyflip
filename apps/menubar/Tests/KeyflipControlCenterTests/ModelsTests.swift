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
            "cap": { "max": 25.0, "spent": 3.4, "remaining": 21.6, "exceeded": false }
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
            "host": "Alastyr",
            "status": "unreadable",
            "load": "okunamadı",
            "memory": "okunamadı",
            "disk": "okunamadı",
            "sites": [],
            "readOnly": true
          },
          "preferences": {
            "thresholdPct": 95,
            "refreshIntervalSec": 120,
            "notify": true,
            "launchAtLogin": true,
            "statusFile": "~/.polyctl/admin/status.json"
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

        precondition(QuotaSeverity.from(usedPct: nil) == .unknown, "nil pct -> unknown")
        precondition(QuotaSeverity.from(usedPct: 45.0) == .normal, "45% -> normal")
        precondition(QuotaSeverity.from(usedPct: 80.0) == .warning, "80% -> warning")
        precondition(QuotaSeverity.from(usedPct: 95.0) == .critical, "95% -> critical")

        let switchConfirm = PendingConfirmationAction.switchAccount(account: "yahoo")
        precondition(switchConfirm.title.contains("yahoo"), "confirmation title must include target account")
        precondition(switchConfirm.message.contains("audit log"), "confirmation message must mention audit log")

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

        let quotaRows = board.sections[0].sortedRows
        precondition(quotaRows.count == 3, "quotaRows.count must be 3")
        precondition(quotaRows[0].status == "bad", "first sorted row must be bad")
        precondition(quotaRows[1].status == "warn", "second sorted row must be warn")
        precondition(quotaRows[2].status == "ok", "third sorted row must be ok")

        // Staleness check: fixture updated is 2026-11-14T18:20:00Z
        let freshNow = StatusBoardPayload.parseISO8601("2026-11-14T18:35:00Z")! // 15 min later -> fresh
        let staleNow = StatusBoardPayload.parseISO8601("2026-11-14T18:45:00Z")! // 25 min later -> stale (>20m)
        precondition(!board.isStale(now: freshNow), "15-minute-old board must NOT be stale")
        precondition(board.isStale(now: staleNow), "25-minute-old board MUST be stale (>20 min)")

        // Missing file must return nil so section is hidden
        precondition(StatusBoardPayload.load(fromFile: "/tmp/definitely-missing-status-board-99999.json") == nil, "missing file must return nil")
    }
}

#if STANDALONE_TEST_RUNNER
@main
struct StandaloneTestMain {
    static func main() throws {
        try ModelsTestSuite.runAll()
        print("✔ KeyflipControlCenter Swift model, statusBoard fixture & confirmation tests passed")
    }
}
#else
final class ModelsTests: XCTestCase {
    func testAll() throws {
        try ModelsTestSuite.runAll()
    }
}
#endif
