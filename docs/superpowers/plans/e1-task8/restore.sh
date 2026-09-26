#!/bin/bash
# E1 Task 8 rollback: puts back exactly what backup.sh saved and moves the new install aside
# (nothing is deleted). Only shell tools. Quit the WebMCP App first; reload the old extension after.
# Usage: restore.sh <backup folder>
set -euo pipefail
B="${1:?usage: restore.sh <backup folder>}"
[ -s "$B/saved.txt" ] || { echo "$B has no saved.txt" >&2; exit 1; }
( cd "$B/files" && shasum -a 256 -c --quiet ../files.sha256 ) || { echo "The backup itself changed; nothing was restored." >&2; exit 1; }
ASIDE="$B/moved-aside-$(date +%Y%m%d-%H%M%S)"
aside() {
  [ -e "$1" ] || return 0
  mkdir -p "$ASIDE$(dirname "$1")"
  mv "$1" "$ASIDE$1"
}
# The new install: its instance, program and state, and its browser registrations.
aside "$HOME/.config/webmcp/instances/webmcp"
aside "$HOME/.local/share/webmcp/instances/webmcp"
aside "$HOME/.local/share/webmcp/extension"
while IFS= read -r -d '' manifest; do aside "$manifest"; done < <(find "$HOME/Library/Application Support" -maxdepth 5 -name 'com.webmcp.extension.json' -print0 2>/dev/null)
# Everything saved, byte for byte; whatever is there now is moved aside first.
while IFS= read -r p; do
  aside "$p"
  mkdir -p "$(dirname "$p")"
  ditto "$B/files$p" "$p"
  diff -r "$B/files$p" "$p" > /dev/null || { echo "MISMATCH after restore: $p" >&2; exit 1; }
done < "$B/saved.txt"
echo "Restored $(wc -l < "$B/saved.txt" | tr -d ' ') paths; the new install is in $ASIDE"
