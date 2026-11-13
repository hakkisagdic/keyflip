// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "KeyflipControlCenter",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "KeyflipControlCenter",
            targets: ["KeyflipControlCenter"]
        )
    ],
    targets: [
        .executableTarget(
            name: "KeyflipControlCenter",
            path: "Sources/KeyflipControlCenter"
        ),
        .testTarget(
            name: "KeyflipControlCenterTests",
            dependencies: ["KeyflipControlCenter"],
            path: "Tests/KeyflipControlCenterTests"
        )
    ]
)
