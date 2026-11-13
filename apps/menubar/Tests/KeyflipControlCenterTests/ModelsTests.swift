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
            "launchAtLogin": true
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
    }
}

#if STANDALONE_TEST_RUNNER
@main
struct StandaloneTestMain {
    static func main() throws {
        try ModelsTestSuite.runAll()
        print("✔ KeyflipControlCenter Swift model & confirmation tests passed")
    }
}
#else
final class ModelsTests: XCTestCase {
    func testAll() throws {
        try ModelsTestSuite.runAll()
    }
}
#endif
