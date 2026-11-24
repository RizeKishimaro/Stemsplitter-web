#!/bin/bash
# SonicLab 10.0 — Kermit the Frog 🐸
# One-file macOS bootstrapper for https://github.com/RizeKishimaro/Stemsplitter-web

set -Eeuo pipefail
REPO_URL="https://github.com/RizeKishimaro/Stemsplitter-web.git"
PROJECT_DIR="${SONICLAB_DIR:-$HOME/Projects/Stemsplitter-web}"
BRANCH="main"
APP_VERSION="10.0.0"
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
say(){ printf "${CYAN}%s${RESET}\n" "$*"; }
good(){ printf "${GREEN}✓ %s${RESET}\n" "$*"; }
warn(){ printf "${YELLOW}! %s${RESET}\n" "$*"; }
die(){ printf "${RED}ERROR: %s${RESET}\n" "$*" >&2; exit 1; }
ask(){ local answer; read -r -p "$1 [y/N] " answer; [[ "$answer" =~ ^[Yy]$ ]]; }
on_error(){ local code=$?; printf "\n${RED}Setup stopped (exit %s).${RESET}\n" "$code" >&2; read -r -p "Press Enter to close..." || true; exit "$code"; }
trap on_error ERR

clear || true
printf "${GREEN}SonicLab 10.0 — KERMIT THE FROG 🐸${RESET}\n\n"
[[ "$(uname -s)" == "Darwin" ]] || die "This installer is for macOS only."
command -v xcode-select >/dev/null 2>&1 || die "Install Xcode Command Line Tools first: xcode-select --install"
if ! xcode-select -p >/dev/null 2>&1; then xcode-select --install || true; die "Complete Xcode Command Line Tools installation, then rerun setup."; fi
good "macOS command-line tools detected"

# Homebrew
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"; elif [[ -x /usr/local/bin/brew ]]; then eval "$(/usr/local/bin/brew shellenv)"; fi
fi
command -v brew >/dev/null 2>&1 || die "Homebrew install failed; see https://brew.sh"
good "Homebrew ready"

# Node 22+
if ! command -v node >/dev/null 2>&1; then say "Installing Node.js..."; brew install node; fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 22 )) || die "Node.js 22+ required; found $(node --version). Run: brew upgrade node"
good "Node.js $(node --version)"

# pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then corepack enable && corepack prepare pnpm@latest --activate; else npm install --global pnpm; fi
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm installation failed"
good "pnpm $(pnpm --version)"

mkdir -p "$(dirname "$PROJECT_DIR")"
if [[ -d "$PROJECT_DIR/.git" ]]; then
  say "Found existing checkout: $PROJECT_DIR"
  git -C "$PROJECT_DIR" fetch origin "$BRANCH"
  if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    warn "Working tree contains local changes; not pulling to avoid overwriting them."
  else
    git -C "$PROJECT_DIR" pull --ff-only origin "$BRANCH"
  fi
elif [[ -e "$PROJECT_DIR" ]]; then
  die "$PROJECT_DIR exists but is not a Git checkout. Move it or set SONICLAB_DIR to a different path."
else
  say "Cloning Stemsplitter-web..."
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$PROJECT_DIR"
fi
cd "$PROJECT_DIR"
[[ -f package.json && -f pnpm-lock.yaml ]] || die "Expected package.json and pnpm-lock.yaml were not found."
PKG_NAME="$(node -p 'require("./package.json").name')"
[[ "$PKG_NAME" == "soniclab-web" ]] || warn "Repository package name is '$PKG_NAME' (expected soniclab-web)."
PKG_VERSION="$(node -p 'require("./package.json").version')"
if [[ "$PKG_VERSION" != "$APP_VERSION" ]]; then
  warn "Current package version is $PKG_VERSION, expected $APP_VERSION."
  if ask "Set package.json version to $APP_VERSION?"; then npm pkg set "version=$APP_VERSION"; fi
else good "Version $PKG_VERSION already set"; fi

say "Installing dependencies from pnpm-lock.yaml..."
pnpm install --frozen-lockfile
good "Dependencies installed"

cat > "$PROJECT_DIR/Start-SonicLab.command" <<'LAUNCHER'
#!/bin/bash
set -Eeuo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
printf '\033[0;32mSonicLab 10.0 — Kermit the Frog 🐸\033[0m\n\n'
command -v node >/dev/null 2>&1 || { echo 'Node.js missing; rerun Setup-SonicLab.command.'; read -r; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo 'pnpm missing; rerun Setup-SonicLab.command.'; read -r; exit 1; }
[[ -d node_modules ]] || pnpm install --frozen-lockfile
if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo 'Port 5173 is already in use:'; lsof -nP -iTCP:5173 -sTCP:LISTEN
  echo 'Stop that process or use the existing server.'; read -r -p 'Press Enter to close...'; exit 1
fi
URL='http://127.0.0.1:5173'
( sleep 2; open "$URL" ) >/dev/null 2>&1 &
echo "Opening $URL"
echo 'Vite provides the required cross-origin isolation headers for audio workers.'
echo 'Press Ctrl+C to stop SonicLab.'
echo
pnpm dev
LAUNCHER
chmod +x "$PROJECT_DIR/Start-SonicLab.command"
good "Created Start-SonicLab.command"

say "Running production build..."
pnpm build
good "Production build passed"
say "Running ESLint..."
pnpm lint
good "ESLint passed"

echo
good "SonicLab 10.0 setup completed"
echo "Project: $PROJECT_DIR"
echo "Launcher: $PROJECT_DIR/Start-SonicLab.command"
echo
echo 'Git status:'
git status --short
if ask "Create release commit 'SonicLab 10.0 — Kermit the Frog'?"; then
  # Stage only release/setup files, not unrelated work.
  git add package.json Start-SonicLab.command
  if ! git diff --cached --quiet; then
    git commit -m "release: SonicLab 10.0 — Kermit the Frog"
    good "Release commit created"
  else warn "No release changes to commit."; fi
else warn "Skipped commit; changes remain in your working tree."; fi

echo
echo 'Double-click Start-SonicLab.command to launch SonicLab.'
read -r -p 'Press Enter to close...'
