#!/bin/bash
# DeepSeek WebMCP installer for macOS, and for Windows inside WSL (run by the WebMCP Setup).
# Usage: install.sh [--workspace <folder>]   (the WebMCP Setup passes the folder it asked for)
set -euo pipefail

# The installer downloads one pinned, checksum-verified adapter release; the adapter pins
# the webmcp-runtime release it installs. No Git and no source checkout are needed.
ADAPTER_URL="${DEEPSEEK_WEBMCP_ADAPTER_URL:-https://github.com/zengtao227/deepseek-webmcp/releases/download/v0.7.1/deepseek-webmcp-8cf114fe504e9be0e35f493fa9151d65c50e5e82.tar.gz}"
ADAPTER_SHA256="${DEEPSEEK_WEBMCP_ADAPTER_SHA256:-61ddf772fcde8011eef1a1f08e235774be67ca541c0a284307be821ffdb594da}"
DIR="$HOME/deepseek-webmcp"
REPORT="$HOME/deepseek-webmcp-install-report.txt"
WORK="$(mktemp -d)"
FAILED=0
MOVED=0
CREATED=0
CHECKS=""
STEP="preflight"
WORKSPACE_ARG=""
if [ "${1:-}" = "--workspace" ] && [ -n "${2:-}" ]; then WORKSPACE_ARG="$2"; fi

say() { printf '\n==> %s\n' "$1"; }
# One line per check; ENV marks a machine or network condition, not a product defect.
check() { # id PASS|WARN|FAIL [ENV] detail
  local line="CHECK $*"
  echo "$line"
  CHECKS="$CHECKS$line"$'\n'
  [ "$2" = "FAIL" ] && FAILED=1
  return 0
}
report() {
  {
    echo "DeepSeek WebMCP install report $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "failed-step: $STEP"
    echo "macos: $(sw_vers -productVersion 2>/dev/null) $(uname -m)"
    echo "node: $(node -v 2>/dev/null || echo missing)"
    echo "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable)"
    printf '%s' "$CHECKS"
    echo "--- last output ---"
    tail -n 40 "$WORK/step.log" 2>/dev/null
  } | sed -e "s|$HOME|~|g" > "$REPORT"
  # The adapter's secret scanner is used once it is on disk; nothing here should hold a secret.
  if [ -f "$DIR/gateway/secret-scanner/index.js" ]; then
    node --input-type=module -e "const { redactSecrets } = await import(process.argv[1]); const fs = await import('node:fs'); fs.writeFileSync(process.argv[2], redactSecrets(fs.readFileSync(process.argv[2], 'utf8')).text);" "$DIR/gateway/secret-scanner/index.js" "$REPORT" 2>/dev/null || true
  fi
  printf '\nA report was saved to %s. Send that file to whoever asked you to test.\n' "~/deepseek-webmcp-install-report.txt"
}
# Puts the previous install back, but only if this run moved it aside.
restore_previous() {
  [ "$MOVED" = 1 ] || return 0
  rm -rf "$DIR"; mv "$DIR.previous" "$DIR"; MOVED=0
  echo "The previous version was put back."
}
# A fresh install that fails removes the program folder it created, after the report (which
# uses that folder's secret scanner) is written.
remove_created() {
  [ "$CREATED" = 1 ] || return 0
  rm -rf "$DIR"; CREATED=0
}
stop() { trap - ERR; printf '\n%s\n' "$1"; cd "$HOME"; restore_previous; report || true; remove_created; rm -rf "$WORK"; exit 1; }
# Host part of a URL for messages, without any user:password@ prefix.
host_of() { printf '%s' "$1" | cut -d/ -f3 | sed 's/.*@//'; }

# Any unexpected top-level failure still produces the report instead of a silent exit.
# No errtrace (-E): the trap must not fire inside the $(curl ...) probes below.
trap 'stop "Unexpected failure during step: $STEP."' ERR

case "$(uname)" in
  Darwin) KIND=macos ;;
  Linux) if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then KIND=wsl; else stop "DeepSeek WebMCP runs on macOS, or on Windows inside WSL."; fi ;;
  *) stop "DeepSeek WebMCP runs on macOS, or on Windows inside WSL." ;;
esac

# Non-interactive shells do not load Homebrew or nvm, where Node.js usually lives.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true; fi

say "Checking requirements (nothing is changed on this computer until every check passes)"
if [ "$KIND" = macos ]; then
  # Docker Desktop supports only the current and two previous macOS releases.
  MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
  if [ "$MACOS_MAJOR" -ge 15 ]; then check macos PASS "$(sw_vers -productVersion) $(uname -m)"; else check macos FAIL "$(sw_vers -productVersion) is older than macOS 15 Sequoia, which current Docker Desktop requires. Update macOS in System Settings > General > Software Update, then run this again."; fi
else
  check wsl PASS "${WSL_DISTRO_NAME:-WSL} $(uname -m)"
fi
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then check node PASS "$(node -v)"; else check node FAIL "Node.js 22 or newer is required: https://nodejs.org/en/download"; fi
if ! command -v docker >/dev/null 2>&1; then
  check docker FAIL "Docker Desktop is required: https://www.docker.com/products/docker-desktop/"
elif ! docker info >/dev/null 2>&1; then
  if [ "$KIND" = macos ]; then
    open -a Docker >/dev/null 2>&1 || true
    check docker FAIL "Docker Desktop is installed but not running. It is starting now; wait until it says it is running, then run this again."
  else
    check docker FAIL "Docker is not reachable from WSL. Start Docker Desktop on Windows and turn on WSL integration for this Linux distribution (Settings > Resources > WSL integration), then run this again."
  fi
else
  check docker PASS "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
fi
[ -n "$ADAPTER_URL" ] && [ -n "$ADAPTER_SHA256" ] || check adapter-pin FAIL "This installer has no pinned release yet."

# Reachability of each service a first install needs. An HTTP answer of any status proves
# the host is reachable; only a connection or DNS failure counts as blocked. The release
# download is required (it follows redirects to the host that serves the file). Docker Hub
# and Debian are probed from this Mac only: Docker Desktop may use its own proxy or
# registry mirror, so for them the image build is the real test and a probe only warns.
reach() { # id url FAIL|WARN [curl option]
  local code
  code="$(curl -sS -o /dev/null -m 15 -r 0-0 ${4:-} -w '%{http_code}' "$2" 2>"$WORK/reach.err")" || code=000
  if [ "$code" != "000" ]; then check "net:$1" PASS "$(host_of "$2") HTTP $code"; else check "net:$1" "$3" ENV "$(host_of "$2") unreachable: $(tr '\n' ' ' < "$WORK/reach.err" | cut -c1-120)"; fi
}
case "$ADAPTER_URL" in https://*) reach release-download "$ADAPTER_URL" FAIL -L ;; esac
reach docker-hub-registry "https://registry-1.docker.io/v2/" WARN
reach docker-hub-auth "https://auth.docker.io/token" WARN
reach docker-hub-blobs "https://production.cloudflare.docker.com/" WARN
reach debian "https://deb.debian.org/debian/dists/bookworm/Release" WARN
[ "$FAILED" = 0 ] || stop "Some requirements are not met (see the CHECK lines above). Nothing was changed."

UPDATE=0
if [ -d "$DIR/.git" ]; then
  stop "$DIR is a Git checkout from an older installer. Uninstall DeepSeek WebMCP from the extension first, or move the folder away, then run this again."
elif [ -f "$DIR/.deepseek-webmcp-installed" ]; then
  UPDATE=1
elif [ -e "$DIR" ]; then
  stop "$DIR already exists and is not a DeepSeek WebMCP download. Move it away and run again."
fi

# Both release archives are fetched here, so there is one download path with one timeout
# and proxy behaviour. A local file path is accepted for offline rehearsals.
fetch_to() { # source destination
  case "$1" in
    https://*) curl -fsSL -m 300 -o "$2" "$1" > "$WORK/step.log" 2>&1 || stop "Download failed from $(host_of "$1") (network). Nothing was changed." ;;
    *) cp "$1" "$2" ;;
  esac
}

STEP="download"
say "Downloading DeepSeek WebMCP"
ARCHIVE="$WORK/adapter.tar.gz"
fetch_to "$ADAPTER_URL" "$ARCHIVE"
[ "$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)" = "$ADAPTER_SHA256" ] || stop "The download does not match its pinned checksum. Nothing was changed."
mkdir "$WORK/adapter"
tar -xzf "$ARCHIVE" -C "$WORK/adapter" --no-same-owner
# The adapter pins the runtime release it needs; the installer verifies its checksum.
RUNTIME_URL="${DEEPSEEK_WEBMCP_RUNTIME_ARCHIVE:-$(node -p 'require(process.argv[1]).url ?? ""' "$WORK/adapter/runtime.lock.json")}"
[ -n "$RUNTIME_URL" ] || stop "This release does not name a runtime download. Nothing was changed."
fetch_to "$RUNTIME_URL" "$WORK/runtime.tar.gz"
if [ "$UPDATE" = 1 ]; then rm -rf "$DIR.previous"; mv "$DIR" "$DIR.previous"; MOVED=1; fi
mv "$WORK/adapter" "$DIR"
[ "$UPDATE" = 1 ] || CREATED=1
# Marks a program folder created by this installer; only such a folder is deleted by Uninstall.
touch "$DIR/.deepseek-webmcp-installed"

STEP="runtime"
say "Installing the local runtime (first time takes a few minutes)"
cd "$DIR"
if ! DEEPSEEK_WEBMCP_INSTALLER=1 node scripts/install-p2-native-host.mjs --runtime-archive "$WORK/runtime.tar.gz" ${WORKSPACE_ARG:+--workspace "$WORKSPACE_ARG"} 2>&1 | tee "$WORK/step.log"; then
  stop "The local runtime could not be installed."
fi
rm -rf "$DIR.previous" "$WORK"
CREATED=0

# Under WSL the Windows setup registers Chrome and Edge and shows the browser steps.
[ "$KIND" = wsl ] && exit 0

say "Last step in the browser"
if [ "$UPDATE" = 1 ]; then
  echo "1. On the browser extensions page, click the reload icon of DeepSeek WebMCP."
  echo "2. Close and reopen your chat.deepseek.com tabs."
else
  echo "1. The browser extensions page and the 'extension' folder are opening."
  echo "2. Turn on Developer mode (top right), then drag the 'extension' folder onto the page."
  echo "3. Click the DeepSeek WebMCP icon on any webpage: the side panel opens and a DeepSeek window is created. Log in to DeepSeek there if asked, and keep a strip of that window visible."
  open -R "$DIR/extension" || true
fi
for browser in "Google Chrome" "Comet"; do
  if open -Ra "$browser" >/dev/null 2>&1; then open -a "$browser" "chrome://extensions" >/dev/null 2>&1 || true; break; fi
done
