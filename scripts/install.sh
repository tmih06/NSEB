#!/usr/bin/env bash
# NSEB installer for Linux and macOS.
# Usage: curl -fsSL https://raw.githubusercontent.com/tmih06/NSEB/main/scripts/install.sh | bash

set -euo pipefail

REPO="tmih06/NSEB"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
APP_NAME="Safe Exam Browser"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || err "missing required command: $1"; }

require curl

# Fetch download URL for a given asset extension (e.g. ".deb").
asset_url() {
    curl -fsSL "$API_URL" \
        | grep -o '"browser_download_url": *"[^"]*'"$1"'"' \
        | head -1 \
        | sed 's/.*"\(http[^"]*\)"$/\1/'
}

download() {
    local url="$1" dest="$2"
    info "Downloading $(basename "$url")"
    curl -fSL --progress-bar -o "$dest" "$url"
}

install_linux() {
    local tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT

    if command -v apt-get >/dev/null 2>&1; then
        local url
        url="$(asset_url '\.deb')"
        [ -n "$url" ] || err "no .deb asset found in latest release"
        download "$url" "$tmp/nseb.deb"
        info "Installing .deb (sudo required)"
        sudo apt-get install -y "$tmp/nseb.deb"
    elif command -v dnf >/dev/null 2>&1; then
        local url
        url="$(asset_url '\.rpm')"
        [ -n "$url" ] || err "no .rpm asset found in latest release"
        download "$url" "$tmp/nseb.rpm"
        info "Installing .rpm (sudo required)"
        sudo dnf install -y "$tmp/nseb.rpm"
    elif command -v yum >/dev/null 2>&1; then
        local url
        url="$(asset_url '\.rpm')"
        [ -n "$url" ] || err "no .rpm asset found in latest release"
        download "$url" "$tmp/nseb.rpm"
        info "Installing .rpm (sudo required)"
        sudo yum install -y "$tmp/nseb.rpm"
    else
        # Fallback: AppImage into ~/.local/bin (no root needed).
        local url bin
        url="$(asset_url '\.AppImage')"
        [ -n "$url" ] || err "no AppImage asset found in latest release"
        bin="${HOME}/.local/bin"
        mkdir -p "$bin"
        download "$url" "$bin/nseb"
        chmod +x "$bin/nseb"
        info "Installed to $bin/nseb"
        case ":$PATH:" in
            *":$bin:"*) ;;
            *) printf 'Note: add %s to your PATH to run "nseb" from anywhere.\n' "$bin" ;;
        esac
        printf 'Note: AppImage requires FUSE (install "fuse" or "libfuse2" if it fails to launch).\n'
        return
    fi
    info "Done. Launch \"$APP_NAME\" from your applications menu."
}

install_macos() {
    local tmp url app_dir
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT

    url="$(asset_url '\.zip')"
    [ -n "$url" ] || err "no .zip asset found in latest release"
    download "$url" "$tmp/nseb.zip"

    require unzip
    unzip -q "$tmp/nseb.zip" -d "$tmp"

    app_dir="/Applications"
    [ -w "$app_dir" ] || app_dir="${HOME}/Applications"
    mkdir -p "$app_dir"

    info "Installing ${APP_NAME}.app to $app_dir"
    rm -rf "$app_dir/${APP_NAME}.app"
    cp -R "$tmp/${APP_NAME}.app" "$app_dir/"

    # Unsigned build: strip Gatekeeper quarantine so it can launch.
    xattr -dr com.apple.quarantine "$app_dir/${APP_NAME}.app" 2>/dev/null || true

    info "Done. Launch \"$APP_NAME\" from $app_dir."
}

case "$(uname -s)" in
    Linux)  install_linux ;;
    Darwin) install_macos ;;
    *)      err "unsupported OS: $(uname -s). On Windows use install.ps1." ;;
esac
