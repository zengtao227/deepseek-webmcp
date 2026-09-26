#!/bin/bash
# E1 Task 8: saves everything the migration to the `webmcp` instance changes or removes, before it
# runs. Only shell tools: restoring must work even when WebMCP itself is disconnected.
# Usage: backup.sh <new backup folder>   (outside every WebMCP-mounted folder)
set -euo pipefail
B="${1:?usage: backup.sh <new backup folder>}"
[ ! -e "$B" ] || { echo "$B already exists" >&2; exit 1; }
# The migration creates these; restore.sh moves them aside, so none may exist beforehand.
for p in "$HOME/.config/webmcp/instances/webmcp" "$HOME/.local/share/webmcp/instances/webmcp" "$HOME/.local/share/webmcp/extension"; do
  [ ! -e "$p" ] || { echo "$p already exists; this backup would not restore the state before it" >&2; exit 1; }
done
mkdir -p -m 700 "$B/files"
: > "$B/saved.txt"
save() {
  [ -e "$1" ] || return 0
  mkdir -p "$B/files$(dirname "$1")"
  ditto "$1" "$B/files$1"
  printf '%s\n' "$1" >> "$B/saved.txt"
}
save "$HOME/.config/webmcp/instances/deepseek"
save "$HOME/.local/share/webmcp/instances/deepseek"
save "$HOME/.deepseek-webmcp"
save "$HOME/Applications/WebMCP Menu.app"
while IFS= read -r -d '' manifest; do save "$manifest"; done < <(find "$HOME/Library/Application Support" -maxdepth 5 -name 'com.deepseek.webmcp.native.json' -print0 2>/dev/null)
( cd "$B/files" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 ) > "$B/files.sha256"
echo "Saved $(wc -l < "$B/saved.txt" | tr -d ' ') paths to $B:"
sed "s|$HOME|~|" "$B/saved.txt"
