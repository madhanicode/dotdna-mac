#!/usr/bin/env bash
set -euo pipefail

TARGET_TRIPLE="aarch64-apple-darwin"
BUNDLE_ROOT="target/${TARGET_TRIPLE}/release/bundle"
APP_PATH="${BUNDLE_ROOT}/macos/DOTDNA.app"
DMG_DIRECTORY="${BUNDLE_ROOT}/dmg"
VERSION="$(/usr/bin/plutil -extract version raw -o - src-tauri/tauri.conf.json)"
OUTPUT_PATH="${DMG_DIRECTORY}/DOTDNA_${VERSION}_aarch64.dmg"

if [[ ! -d "${APP_PATH}" ]]; then
  echo "DOTDNA.app was not found at ${APP_PATH}. Build the app bundle first." >&2
  exit 1
fi

# Rust emits a linker-signed executable even when no local Developer ID is
# available. Seal the whole bundle for local builds so macOS can validate its
# Info.plist and resources; CI's Tauri build applies the Developer ID signature.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  /usr/bin/codesign --force --deep --sign - "${APP_PATH}"
fi
/usr/bin/codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

mkdir -p "${DMG_DIRECTORY}"
TASK_TMP_ROOT="${TMPDIR:-/tmp}"
STAGING_DIRECTORY="$(mktemp -d "${TASK_TMP_ROOT%/}/dotdna-dmg.XXXXXX")"
cleanup() {
  rm -rf "${STAGING_DIRECTORY}"
}
trap cleanup EXIT

/usr/bin/ditto "${APP_PATH}" "${STAGING_DIRECTORY}/DOTDNA.app"
ln -s /Applications "${STAGING_DIRECTORY}/Applications"

/usr/bin/hdiutil create \
  -volname "DOTDNA" \
  -srcfolder "${STAGING_DIRECTORY}" \
  -format UDZO \
  -ov \
  "${OUTPUT_PATH}"

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  /usr/bin/codesign --force --sign "${APPLE_SIGNING_IDENTITY}" "${OUTPUT_PATH}"
fi

if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  /usr/bin/xcrun notarytool submit "${OUTPUT_PATH}" \
    --apple-id "${APPLE_ID}" \
    --password "${APPLE_PASSWORD}" \
    --team-id "${APPLE_TEAM_ID}" \
    --wait
  /usr/bin/xcrun stapler staple "${OUTPUT_PATH}"
fi

/usr/bin/hdiutil verify "${OUTPUT_PATH}"
echo "Created ${OUTPUT_PATH}"
