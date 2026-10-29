#!/usr/bin/env bash
# Build Ami for iOS and upload it to App Store Connect / TestFlight.
#
#   npm run upload -- <build-number>        e.g. npm run upload -- 2
#
# Every upload needs a new, higher build number (the 1.0 marketing version
# can stay the same). Signing is automatic and cloud-managed for team
# GGRA29SH9K, so no device or local distribution certificate is needed; the
# Mac just has to be signed in to that team in Xcode → Settings → Accounts.
set -euo pipefail

BUILD="${1:?usage: npm run upload -- <build-number>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

cd "$ROOT"
npm run sync

# Archive unsigned, then let the export step sign with the App Store profile.
# (An automatically-signed archive would need a registered device for its
# development profile.)
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/Ami.xcarchive" \
  CURRENT_PROJECT_VERSION="$BUILD" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  archive

xcodebuild -exportArchive -archivePath "$OUT/Ami.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist "$ROOT/scripts/ExportOptions.plist" -allowProvisioningUpdates

echo "Uploaded build $BUILD. It appears in App Store Connect → TestFlight after processing (~5–30 min)."
