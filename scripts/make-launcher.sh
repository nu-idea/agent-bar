#!/bin/sh
# Builds a double-clickable agent-bar.app that starts the widget from this folder.
# Usage: scripts/make-launcher.sh [where]   (default: ~/Desktop)
# The .app holds no code: it runs Electron on this project folder, so after edits
# just quit the widget and launch again. If you move the project, rebuild the launcher.
set -e
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/Desktop}/agent-bar.app"

rm -rf "$DEST"
mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"

# Icon: assets/icon.png -> icon.icns
SET="$(mktemp -d)/icon.iconset"
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$PROJECT/assets/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$PROJECT/assets/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$DEST/Contents/Resources/icon.icns"

cat > "$DEST/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>agent-bar</string>
  <key>CFBundleIdentifier</key><string>local.agent-bar.launcher</string>
  <key>CFBundleExecutable</key><string>agent-bar</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF

# Start Electron detached and exit at once; a second launch quits by itself (single-instance lock).
cat > "$DEST/Contents/MacOS/agent-bar" <<EOF
#!/bin/sh
cd "$PROJECT" || exit 1
nohup ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . </dev/null >/dev/null 2>&1 &
EOF
chmod +x "$DEST/Contents/MacOS/agent-bar"

echo "$DEST"
