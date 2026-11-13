import Darwin
import Foundation

public enum DaemonClientError: LocalizedError {
    case socketNotFound(String)
    case connectionFailed(String)
    case invalidResponse(String)
    case serverError(String)

    public var errorDescription: String? {
        switch self {
        case .socketNotFound(let path):
            return "Daemon soketi bulunamadı (\(path))"
        case .connectionFailed(let reason):
            return "Daemon bağlantısı kurulamadı: \(reason)"
        case .invalidResponse(let detail):
            return "Geçersiz daemon yanıtı: \(detail)"
        case .serverError(let message):
            return message
        }
    }
}

public final class DaemonClient: Sendable {
    public let customSocketPath: String?

    public init(customSocketPath: String? = nil) {
        self.customSocketPath = customSocketPath
    }

    public func resolveSocketPath() -> String {
        if let custom = customSocketPath, !custom.isEmpty {
            return custom
        }
        if let envSock = ProcessInfo.processInfo.environment["KEYFLIP_DAEMON_SOCKET"], !envSock.isEmpty {
            return envSock
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let primary = (home as NSString).appendingPathComponent(".config/keyflip/daemon.sock")
        if FileManager.default.fileExists(atPath: primary) {
            return primary
        }
        let secondary = (home as NSString).appendingPathComponent(".keyflip/daemon.sock")
        if FileManager.default.fileExists(atPath: secondary) {
            return secondary
        }
        return primary
    }

    public func sendRawCommand(_ payload: [String: Any], timeoutSeconds: Int = 4) throws -> Data {
        let sockPath = resolveSocketPath()
        guard FileManager.default.fileExists(atPath: sockPath) else {
            throw DaemonClientError.socketNotFound(sockPath)
        }

        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw DaemonClientError.connectionFailed("socket() errno=\(errno)")
        }
        defer {
            Darwin.close(fd)
        }

        var tv = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
        withUnsafePointer(to: &tv) { ptr in
            _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, ptr, socklen_t(MemoryLayout<timeval>.size))
            _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, ptr, socklen_t(MemoryLayout<timeval>.size))
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = sockPath.utf8CString
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count <= maxLen else {
            throw DaemonClientError.connectionFailed("Soket yolu çok uzun")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { rawBuf in
            for (idx, b) in pathBytes.enumerated() {
                rawBuf[idx] = UInt8(bitPattern: b)
            }
        }

        let connectRes = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockAddrPtr in
                Darwin.connect(fd, sockAddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectRes == 0 else {
            throw DaemonClientError.connectionFailed("connect() errno=\(errno)")
        }

        var reqData = try JSONSerialization.data(withJSONObject: payload, options: [])
        reqData.append(0x0A) // newline for NDJSON

        try reqData.withUnsafeBytes { rawBuf in
            guard let base = rawBuf.baseAddress else { return }
            var sent = 0
            while sent < rawBuf.count {
                let n = Darwin.write(fd, base.advanced(by: sent), rawBuf.count - sent)
                if n <= 0 {
                    throw DaemonClientError.connectionFailed("write() errno=\(errno)")
                }
                sent += n
            }
        }

        var responseData = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let n = Darwin.read(fd, &buffer, buffer.count)
            if n > 0 {
                responseData.append(contentsOf: buffer[0..<n])
                if buffer[0..<n].contains(0x0A) {
                    break
                }
            } else {
                break
            }
        }

        guard !responseData.isEmpty else {
            throw DaemonClientError.invalidResponse("Boş yanıt")
        }
        return responseData
    }

    public func fetchControlCenter() -> (payload: ControlCenterPayload?, daemonRunning: Bool, error: String?) {
        do {
            let data = try sendRawCommand(["cmd": "control-center"])
            let decoded = try JSONDecoder().decode(ControlCenterPayload.self, from: data)
            var result = decoded
            result.daemonRunning = true
            return (result, true, nil)
        } catch {
            // Fallback to offline CLI snapshot when daemon is not running
            if let fallback = fetchOfflineCliSnapshot() {
                return (fallback, false, nil)
            }
            return (nil, false, error.localizedDescription)
        }
    }

    private func fetchOfflineCliSnapshot() -> ControlCenterPayload? {
        let proc = Process()
        let outPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = Pipe()

        let candidates = [
            "/opt/homebrew/bin/keyflip",
            "/usr/local/bin/keyflip",
            (FileManager.default.homeDirectoryForCurrentUser.path as NSString)
                .appendingPathComponent("Projects/keyflip-control-center/bin/keyflip.js")
        ]
        guard let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return nil
        }

        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        var env = ProcessInfo.processInfo.environment
        let extraPaths = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        env["PATH"] = extraPaths + ":" + (env["PATH"] ?? "")
        proc.environment = env
        proc.arguments = [found, "daemon", "control-center", "--json"]

        do {
            try proc.run()
            proc.waitUntilExit()
            let data = outPipe.fileHandleForReading.readDataToEndOfFile()
            guard !data.isEmpty else { return nil }
            var decoded = try JSONDecoder().decode(ControlCenterPayload.self, from: data)
            decoded.daemonRunning = false
            return decoded
        } catch {
            return nil
        }
    }

    public func sendConfirmedCommand(_ payload: [String: Any]) throws {
        let data = try sendRawCommand(payload)
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let ok = json["ok"] as? Bool, !ok {
                let msg = (json["message"] as? String) ?? (json["error"] as? String) ?? "İşlem başarısız oldu"
                throw DaemonClientError.serverError(msg)
            }
        }
    }

    public func installAndStartDaemon() throws {
        let proc = Process()
        let errPipe = Pipe()
        proc.standardOutput = Pipe()
        proc.standardError = errPipe

        let candidates = [
            "/opt/homebrew/bin/keyflip",
            "/usr/local/bin/keyflip",
            (FileManager.default.homeDirectoryForCurrentUser.path as NSString)
                .appendingPathComponent("Projects/keyflip-control-center/bin/keyflip.js")
        ]
        guard let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw DaemonClientError.serverError("keyflip yürütülebilir dosyası bulunamadı")
        }

        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        proc.environment = env
        proc.arguments = [found, "daemon", "install", "-y"]

        try proc.run()
        proc.waitUntilExit()
        if proc.terminationStatus != 0 {
            let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            let errText = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw DaemonClientError.serverError(errText?.isEmpty == false ? errText! : "Daemon başlatılamadı (kod \(proc.terminationStatus))")
        }
    }
}
