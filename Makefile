APP_NAME := KeyflipControlCenter
MENUBAR_DIR := apps/menubar
BUILD_DIR := $(MENUBAR_DIR)/build
APP_BUNDLE := $(BUILD_DIR)/$(APP_NAME).app
SDK_PATH := $(shell if [ -d /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk ]; then echo /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk; else xcrun --show-sdk-path; fi)
TARGET_TRIPLE := $(shell uname -m)-apple-macosx13.0
DEVELOPER_ID ?=
NOTARY_PROFILE ?=

.PHONY: all menubar menubar-test menubar-sign menubar-notarize clean

all: menubar

menubar:
	mkdir -p "$(APP_BUNDLE)/Contents/MacOS" "$(APP_BUNDLE)/Contents/Resources"
	swiftc -O -sdk "$(SDK_PATH)" -target "$(TARGET_TRIPLE)" -parse-as-library \
		$(MENUBAR_DIR)/Sources/KeyflipControlCenter/*.swift \
		-o "$(APP_BUNDLE)/Contents/MacOS/$(APP_NAME)"
	cp "$(MENUBAR_DIR)/Info.plist" "$(APP_BUNDLE)/Contents/Info.plist"
	chmod +x "$(APP_BUNDLE)/Contents/MacOS/$(APP_NAME)"
	@echo "Built unsigned local bundle: $(APP_BUNDLE)"

menubar-test:
	mkdir -p "$(BUILD_DIR)"
	swiftc -sdk "$(SDK_PATH)" -target "$(TARGET_TRIPLE)" -parse-as-library -DSTANDALONE_TEST_RUNNER \
		"$(MENUBAR_DIR)/Sources/KeyflipControlCenter/Models.swift" \
		"$(MENUBAR_DIR)/Sources/KeyflipControlCenter/DaemonClient.swift" \
		"$(MENUBAR_DIR)/Tests/KeyflipControlCenterTests/ModelsTests.swift" \
		-o "$(BUILD_DIR)/KeyflipControlCenterTests"
	"$(BUILD_DIR)/KeyflipControlCenterTests"

menubar-sign: menubar
	@if [ -z "$(DEVELOPER_ID)" ]; then \
		echo "Set DEVELOPER_ID='Developer ID Application: ...' to sign for distribution."; \
		exit 1; \
	fi
	codesign --force --options runtime \
		--entitlements "$(MENUBAR_DIR)/Entitlements.plist" \
		--sign "$(DEVELOPER_ID)" \
		"$(APP_BUNDLE)"

menubar-notarize: menubar-sign
	@if [ -z "$(NOTARY_PROFILE)" ]; then \
		echo "Set NOTARY_PROFILE='<keychain-profile>' to submit for Apple notarization."; \
		exit 1; \
	fi
	ditto -c -k --keepParent "$(APP_BUNDLE)" "$(BUILD_DIR)/$(APP_NAME).zip"
	xcrun notarytool submit "$(BUILD_DIR)/$(APP_NAME).zip" --keychain-profile "$(NOTARY_PROFILE)" --wait
	xcrun stapler staple "$(APP_BUNDLE)"

clean:
	rm -rf "$(MENUBAR_DIR)/.build" "$(BUILD_DIR)"
