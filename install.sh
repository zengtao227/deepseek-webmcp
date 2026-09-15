#!/bin/bash
# DeepSeek WebMCP one-line installer for macOS. The README shows the exact command.
set -euo pipefail

REPO="https://github.com/zengtao227/deepseek-webmcp.git"
DIR="$HOME/deepseek-webmcp"

say() { printf '\n==> %s\n' "$1"; }
stop() { printf '\n%s\n' "$1"; exit 1; }

[ "$(uname)" = "Darwin" ] || stop "DeepSeek WebMCP currently supports macOS only."

# Non-interactive shells do not load Homebrew or nvm, where Node.js usually lives.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true; fi

say "Checking requirements"
command -v git >/dev/null 2>&1 || { xcode-select --install >/dev/null 2>&1 || true; stop "Git is missing. Finish the Apple developer tools install that just opened, then run this command again."; }
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  open "https://nodejs.org/en/download" || true
  stop "Node.js 22 or newer is required. Install it from nodejs.org (page opened), then run this command again."
fi
if ! command -v docker >/dev/null 2>&1; then
  open "https://www.docker.com/products/docker-desktop/" || true
  stop "Docker Desktop is required. Install it (page opened), start it, then run this command again."
fi
if ! docker info >/dev/null 2>&1; then
  open -a Docker >/dev/null 2>&1 || true
  stop "Docker Desktop is not running. It is starting now; wait until it says it is running, then run this command again."
fi

UPDATE=0
if [ -d "$DIR/.git" ]; then
  UPDATE=1
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  [ -e "$DIR" ] && stop "$DIR already exists and is not a DeepSeek WebMCP download. Move it away and run again."
  say "Downloading to $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi
# Marks a program folder created by this installer; only such a folder is deleted by Uninstall.
touch "$DIR/.deepseek-webmcp-installed"

say "Building the local runtime (first time takes a few minutes)"
cd "$DIR"
DEEPSEEK_WEBMCP_INSTALLER=1 node scripts/install-p2-native-host.mjs

say "Last step in the browser"
if [ "$UPDATE" = 1 ]; then
  echo "1. On the browser extensions page, click the reload icon of DeepSeek WebMCP."
  echo "2. Close and reopen your chat.deepseek.com tabs."
else
  echo "1. The browser extensions page and the 'extension' folder are opening."
  echo "2. Turn on Developer mode (top right), then drag the 'extension' folder onto the page."
  echo "3. Open chat.deepseek.com, click the DeepSeek WebMCP icon, click Work, and type your task."
  open -R "$DIR/extension" || true
fi
for browser in "Google Chrome" "Comet"; do
  if open -Ra "$browser" >/dev/null 2>&1; then open -a "$browser" "chrome://extensions" >/dev/null 2>&1 || true; break; fi
done
