#!/usr/bin/env bash
# Build a minimal zip for release. Only include files Chrome needs to run the
# extension after the user unzips it and loads the folder.
set -euo pipefail

cd "$(dirname "$0")"

OUT_NAME="happysubs"

VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' manifest.json \
  | sed 's/.*"\([^"]*\)"$/\1/')
echo "Building ${OUT_NAME} v${VERSION}"

# Every build keeps its own name, so an earlier one is never overwritten by a
# later one. `rm -rf dist` used to take the previous release's zip with it —
# which is how v2.0.1 stopped existing, having never been committed either.
STAGE_DIR="dist/${OUT_NAME}"
ZIP_PATH="dist/${OUT_NAME}-${VERSION}.zip"

rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}/icons"

cp manifest.json i18n.js platform.js live.js content.js background.js \
   inject-youtube.js inject-vimeo.js overlay.css \
   popup.html popup.js welcome.html welcome.js \
   "${STAGE_DIR}/"
cp icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png "${STAGE_DIR}/icons/"
cp -R _locales "${STAGE_DIR}/_locales"

rm -f "${ZIP_PATH}"
( cd dist && zip -r -q "${OUT_NAME}-${VERSION}.zip" "${OUT_NAME}" )

# Chrome Web Store upload: same files, but manifest.json must sit at the
# zip root (no wrapping folder).
UPLOAD_ZIP="dist/${OUT_NAME}-${VERSION}-upload.zip"
rm -f "${UPLOAD_ZIP}"
( cd "${STAGE_DIR}" && zip -r -q "../${OUT_NAME}-${VERSION}-upload.zip" . )
rm -rf "${STAGE_DIR}"

SIZE=$(du -h "${ZIP_PATH}" | cut -f1)
echo "Wrote ${ZIP_PATH} (${SIZE})"
SIZE=$(du -h "${UPLOAD_ZIP}" | cut -f1)
echo "Wrote ${UPLOAD_ZIP} (${SIZE})"
