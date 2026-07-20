#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
app_dir="$project_dir/Woody.app"

[[ -d "$app_dir/Contents/MacOS" ]] || { echo "Woody.app is missing." >&2; exit 1; }

/usr/bin/clang -Os -Wall -Wextra -mmacosx-version-min=12.0 "$script_dir/WoodyLauncher.c" -o "$app_dir/Contents/MacOS/Woody"
/bin/chmod 755 "$app_dir/Contents/MacOS/Woody" "$app_dir/Contents/Resources/Start Woody.command"
/usr/bin/xattr -dr com.apple.provenance "$app_dir" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$app_dir"
/usr/bin/codesign --verify --deep --strict "$app_dir"

echo "Built native Woody launcher: $app_dir"
