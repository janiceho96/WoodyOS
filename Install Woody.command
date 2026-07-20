#!/bin/zsh

installer_dir="${0:A:h}"
source_app="$installer_dir/Woody.app"
applications_dir="$HOME/Applications"
target_app="$applications_dir/Woody.app"

if [[ ! -d "$source_app" ]]; then
  echo "Woody.app was not found at: $source_app"
  read "?Press Return to close this window. "
  exit 1
fi

/bin/mkdir -p "$applications_dir"

if [[ -e "$target_app" ]]; then
  backup_name="Woody previous $(/bin/date +%Y%m%d-%H%M%S).app"
  /bin/mv "$target_app" "$HOME/.Trash/$backup_name" || exit 1
  echo "Moved the previous Woody app to Trash."
fi

/usr/bin/ditto "$source_app" "$target_app" || exit 1
/bin/echo "$installer_dir" > "$target_app/Contents/Resources/ProjectRoot" || exit 1
/usr/bin/xattr -dr com.apple.provenance "$target_app" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$target_app" || exit 1
/usr/bin/codesign --verify --deep --strict "$target_app" || exit 1

echo "Woody 1.2 was installed successfully."
echo "If the old Dock icon still shows a question mark, remove it and keep this newly opened Woody in the Dock."
/usr/bin/open "$target_app"
