# NSEB — Safe Exam Browser

A cross-platform Safe Exam Browser build. The app lives in `seb-linux/` (Electron) and is released for Linux, Windows, and macOS. `seb-mac`, `seb-win-refactoring`, and `seb-server` are upstream reference trees used for development and local testing.

## Install

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/tmih06/NSEB/main/scripts/install.sh | bash
```

- **Debian/Ubuntu** — downloads and installs the `.deb` via `apt` (sudo).
- **Fedora/RHEL** — downloads and installs the `.rpm` via `dnf`/`yum` (sudo).
- **Other distros** — falls back to the AppImage in `~/.local/bin` (no root; requires FUSE).
- **macOS** — downloads the `.zip`, installs `Safe Exam Browser.app` to `/Applications` (or `~/Applications`), and removes the Gatekeeper quarantine attribute (the build is unsigned).

### Windows

```powershell
irm https://raw.githubusercontent.com/tmih06/NSEB/main/scripts/install.ps1 | iex
```

Downloads the portable `.exe` to `%LOCALAPPDATA%\NSEB` and creates a Desktop shortcut.

### Manual download

Grab the assets directly from [Releases](https://github.com/tmih06/NSEB/releases/latest):

| Platform | Assets |
|---|---|
| Linux | `.deb`, `.rpm`, `.AppImage`, `.tar.gz` |
| Windows | `.exe` (portable) |
| macOS | `.dmg`, `.zip` (arm64, unsigned) |

> **macOS note:** the app is not signed/notarized. The install script removes the quarantine flag; if you install manually, run `xattr -dr com.apple.quarantine "/Applications/Safe Exam Browser.app"` or right-click → Open.

## Build from source

```bash
make install        # clone sibling source trees + npm install seb-linux
make dev            # run with hot reload
make start          # run normally
make test           # run seb-linux tests
```

Package locally (from `seb-linux/`):

```bash
npm run build:deb        # .deb
npm run build:appimage   # AppImage
npx electron-builder --mac    # macOS dmg/zip (on a Mac)
npx electron-builder --win    # Windows portable exe
```

Releases are built by CI (`.github/workflows/release.yml`) on `v*` tags — matrix of Ubuntu, Windows, and macOS runners.

## Local exam server

```bash
make serve        # rebuild + boot local seb-server test stack (docker)
make serve-down   # tear it down
```

## Repo layout

| Path | Contents |
|---|---|
| `seb-linux/` | The Electron app that ships in releases |
| `seb-mac/` | Upstream SEB macOS source (reference) |
| `seb-win-refactoring/` | Upstream SEB Windows source (reference) |
| `seb-server/` | Upstream SEB Server (local test stack) |
| `scripts/` | Install scripts + local-exam tooling |
| `config.seb` | Sample exam config |
