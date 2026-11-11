#!/bin/sh
# ARYZEN Media Downloader (release candidate) - one-time setup for Linux (Brave or Chrome).
#
# What this script does, in order:
#   1. checks you have what it needs: python3 3.11+, curl, ffmpeg, and
#      an internet connection (the engine is downloaded and checksum-verified)
#   2. downloads the latest official yt-dlp release and verifies its SHA-256
#      against the checksums published with that release
#   3. installs the bridge + engine to a fixed hidden folder
#      (~/.universal-media-downloader-rc) so the browser can always find them
#   4. registers the native-messaging host "com.umd.bridge.rc" for Chrome,
#      Brave and Chromium
#   5. puts the extension itself in "ARYZEN Media Downloader" on your
#      Desktop - that folder IS the extension; move it anywhere before you
#      import it, moving never breaks the connection
#
# It never touches an existing install (host name com.umd.bridge.rc is
# separate from the original com.umd.bridge) and never overwrites a folder
# it did not create.

set -eu

ESC=$(printf '\033')
RESET="$ESC[0m"; BOLD="$ESC[1m"
# bright palette: white = work in progress, green = success, red = error,
# purple = Aryzen Nex, gray = timestamps/details
WHITE="$ESC[97m"; GREEN="$ESC[92m"; RED="$ESC[91m"; PURPLE="$ESC[95m"; DIM="$ESC[90m"
# title gradient: cyan -> blue -> violet (also the rotating loader colors)
G1="$ESC[38;5;51m"; G2="$ESC[38;5;45m"; G3="$ESC[38;5;39m"; G4="$ESC[38;5;63m"; G5="$ESC[38;5;99m"

# Each stage stays on screen at least this long (seconds), with a spinner,
# so fast steps read as deliberate work instead of a flicker. Real work
# always runs first - the wait is pacing, not pretend progress.
MIN_STAGE=2

stamp() { date +%H:%M:%S; }
err()  { printf '%s[%s]%s %sx%s %s\n' "$DIM" "$(stamp)" "$RESET" "$RED" "$RESET" "$RED$1$RESET" >&2; }
die()  { err "$*"; exit 1; }

# paint one art row with a left-to-right gradient
gradline() {
  line=$1; i=0; n=${#line}
  while [ $i -lt $n ]; do
    seg=$(( i * 5 / n ))
    case $seg in
      0) c=$G1 ;; 1) c=$G2 ;; 2) c=$G3 ;; 3) c=$G4 ;; *) c=$G5 ;;
    esac
    printf '%s%s' "$c" "$(printf '%s' "$line" | cut -c $((i+1)))"
    i=$((i+1))
  done
  printf '%s\n' "$RESET"
}

banner() {
  printf '\n'
  gradline "    ___    __  _______"
  gradline "   /   |  /  |/  / __ \\"
  gradline "  / /| | / /|_/ / / / /"
  gradline " / ___ |/ /  / / /_/ /"
  gradline "/_/  |_/_/  /_/_____/"
  printf '\n'
  printf '%s%sARYZEN Media Downloader%s\n' "$BOLD" "$WHITE" "$RESET"
  printf '%screated by Aryzen Nex%s\n' "$PURPLE" "$RESET"
  printf '\n'
}

# Live layout:
#   Currently at step k/N   <- one line under the banner, updates after each
#                              successful step (clamped at N)
#   <rotating circle> label <- the active step, directly below the counter
#   + label / details       <- completed steps accumulate below, newest last
# The circle (◐◓◑◒, colored with the AMD gradient) turns the whole time the
# real work runs; every stage also stays up at least MIN_STAGE seconds so
# fast steps never flicker. Visual inspiration: the "loading" circle
# animation the author linked (lottiefiles.com/free-animation/loading-99FrBcVjYZ);
# no Lottie asset, code or license material is used - the spinner is a plain
# terminal convention drawn from scratch in the AMD gradient colors.
STAGE_TOTAL=5
STEPN=0
HIST=0
SAVE="$ESC"7
REST="$ESC"8

up()   { printf '%s[%sA' "$ESC" "$1"; }
clrl() { printf '\r%s[2K' "$ESC"; }

counter() { # $1 = step number now in progress
  printf '%s' "$SAVE"
  up $((HIST + 2))
  clrl
  printf '%s%sCurrently at step %s/%s%s' "$WHITE" "$BOLD" "$1" "$STAGE_TOTAL" "$RESET"
  printf '%s' "$REST"
}

stage() {
  _label=$1; shift
  STEPN=$((STEPN+1))
  _out=$(mktemp)
  _t0=$(date +%s)
  _s0=$(stamp)
  ( "$@" ) >"$_out" 2>&1 &
  _pid=$!
  _rc=0; _done=0; _i=0
  while :; do
    if [ "$_done" = 0 ] && ! kill -0 "$_pid" 2>/dev/null; then
      wait "$_pid" || _rc=$?
      _done=1
    fi
    _el=$(( $(date +%s) - _t0 ))
    [ "$_done" = 1 ] && [ "$_el" -ge "$MIN_STAGE" ] && break
    case $((_i % 4)) in
      0) _c='◐';; 1) _c='◓';; 2) _c='◑';; *) _c='◒';;
    esac
    case $((_i % 5)) in
      0) _g=$G1;; 1) _g=$G2;; 2) _g=$G3;; 3) _g=$G4;; *) _g=$G5;;
    esac
    printf '%s' "$SAVE"
    up $((HIST + 1))
    clrl
    printf '%s[%s]%s %s%s%s %s%s%s' "$DIM" "$_s0" "$RESET" "$_g" "$_c" "$RESET" "$WHITE" "$_label" "$RESET"
    printf '%s' "$REST"
    sleep 0.15
    _i=$((_i+1))
  done
  # free the active slot
  printf '%s' "$SAVE"; up $((HIST + 1)); clrl; printf '%s' "$REST"
  if [ "$_rc" -eq 0 ]; then
    printf '%s[%s]%s %s+%s %s%s%s\n' "$DIM" "$(stamp)" "$RESET" "$GREEN" "$RESET" "$GREEN" "$_label" "$RESET"
    HIST=$((HIST+1))
    while IFS= read -r _l; do
      if [ -n "$_l" ]; then
        printf '             %s%s%s\n' "$DIM" "$_l" "$RESET"
        HIST=$((HIST+1))
      fi
    done < "$_out"
    if [ "$STEPN" -lt "$STAGE_TOTAL" ]; then counter $((STEPN+1)); fi
  else
    printf '%s[%s]%s %sx%s %s%s%s\n' "$DIM" "$(stamp)" "$RESET" "$RED" "$RESET" "$RED" "$_label" "$RESET" >&2
    while IFS= read -r _l; do
      [ -n "$_l" ] && printf '             %s%s%s\n' "$RED" "$_l" "$RESET" >&2
    done < "$_out"
    rm -f "$_out"
    exit 1
  fi
  rm -f "$_out"
}

SRC="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$HOME/.universal-media-downloader-rc"
DESKDIR="$HOME/Desktop/ARYZEN Media Downloader"
TMPWORK=$(mktemp -d)
trap 'rm -rf "$TMPWORK"' EXIT

stage_check() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found. Install it with your package manager (e.g. sudo apt install python3) and run this again."
    return 1
  fi
  if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then
    echo "Python is too old; current yt-dlp releases require Python 3.11 or newer (yt-dlp 2026.10.26 exits with an error on older versions). Install a newer python3 and run this again."
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found. Install it with your package manager and run this again."
    return 1
  fi
  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "ffmpeg not found. Install your distribution's package first (Debian/Ubuntu: sudo apt install ffmpeg; Fedora: sudo dnf install ffmpeg; Arch: sudo pacman -S ffmpeg) and run this again. This installer does not download unverified FFmpeg builds."
    return 1
  fi
  if ! command -v ffprobe >/dev/null 2>&1; then
    echo "ffprobe not found. It ships in your distribution's ffmpeg package (Debian/Ubuntu: sudo apt install ffmpeg; Fedora: sudo dnf install ffmpeg; Arch: sudo pacman -S ffmpeg) - install that and run this again."
    return 1
  fi
  if [ -e "$DESKDIR" ]; then
    echo "$DESKDIR already exists. Move or rename it first - I never overwrite a folder that isn't mine."
    return 1
  fi
  if [ -e "$BACKEND" ] && [ ! -f "$BACKEND/.umd-rc" ]; then
    echo "$BACKEND exists and was not created by this installer. Not touching it."
    return 1
  fi
  echo "python3 $(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])') + curl + ffmpeg"
}

stage_download() {
  TAG=$(curl -fsSL https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) || return 1
  if [ -z "$TAG" ]; then
    echo "could not reach GitHub - check your internet connection and run this again."
    return 1
  fi
  WANT=$(curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/$TAG/SHA2-256SUMS" | awk '$2=="yt-dlp"{print $1}') || return 1
  if [ -z "$WANT" ]; then
    echo "could not read the official yt-dlp checksum."
    return 1
  fi
  if ! curl -fsSL -o "$TMPWORK/yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/download/$TAG/yt-dlp"; then
    echo "engine download failed - check your internet connection."
    return 1
  fi
  GOT=$(sha256sum "$TMPWORK/yt-dlp" | awk '{print $1}')
  if [ "$GOT" != "$WANT" ]; then
    echo "yt-dlp checksum mismatch - nothing was installed."
    return 1
  fi
  echo "yt-dlp $TAG downloaded and SHA-256 verified"
}

stage_helper() {
  [ ! -e "$BACKEND" ] || rm -rf "$BACKEND"
  mkdir -p "$BACKEND/bridge" "$BACKEND/bin"
  cp "$SRC/bridge/umd_host.py" "$SRC/bridge/run-host.sh" "$BACKEND/bridge/"
  chmod +x "$BACKEND/bridge/run-host.sh"
  cp "$TMPWORK/yt-dlp" "$BACKEND/bin/yt-dlp"
  chmod +x "$BACKEND/bin/yt-dlp"
  ln -sf "$(command -v ffmpeg)" "$BACKEND/bin/ffmpeg"
  ln -sf "$(command -v ffprobe)" "$BACKEND/bin/ffprobe"
  touch "$BACKEND/.umd-rc"
  echo "helper installed in ~/.universal-media-downloader-rc"
}

stage_register() {
  for D in "$HOME/.config/google-chrome/NativeMessagingHosts" \
           "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
           "$HOME/.config/chromium/NativeMessagingHosts"; do
    mkdir -p "$D"
    sed "s|HOST_LAUNCHER_PATH|$BACKEND/bridge/run-host.sh|" "$SRC/bridge/com.umd.bridge.rc.json" > "$D/com.umd.bridge.rc.json"
  done
  echo "registered with Chrome, Brave and Chromium (com.umd.bridge.rc)"
}

stage_desktop() {
  mkdir -p "$HOME/Desktop"
  mkdir -p "$DESKDIR"
  cp -R "$SRC/extension/." "$DESKDIR/"
  cat > "$DESKDIR/README-FIRST.txt" <<'NOTE'
ARYZEN Media Downloader - created by Aryzen Nex

This folder is the browser extension. The download engine and bridge were
installed separately in ~/.universal-media-downloader-rc, so moving THIS
folder never breaks anything.

1. Cut and paste this folder anywhere you like (Documents, etc.).
2. Open brave://extensions or chrome://extensions in your browser.
3. Turn on Developer mode (top right).
4. Click "Load unpacked" and choose this folder itself (the one this
   file is in) - it is the extension, with manifest.json at its root.
5. Open a supported site (YouTube, Instagram, Reddit, Twitch, SoundCloud,
   Streamable, TED) and look for the glass Download button.

To uninstall later: remove ~/.universal-media-downloader-rc, delete
com.umd.bridge.rc.json from your browser's NativeMessagingHosts folder, and
remove the extension from brave://extensions / chrome://extensions.
NOTE
  echo "project folder ready on your Desktop"
}

banner
printf '%s%sCurrently at step 1/%s%s\n\n' "$WHITE" "$BOLD" "$STAGE_TOTAL" "$RESET"
stage "Checking your setup" stage_check
stage "Downloading the yt-dlp engine (latest official release)" stage_download
stage "Installing the local helper" stage_helper
stage "Connecting the helper to your browser(s)" stage_register
stage "Creating your project folder on the Desktop" stage_desktop

printf '\n%s[%s]%s %s%s Installation complete %s\n' "$DIM" "$(stamp)" "$RESET" "$GREEN" "$BOLD" "$RESET"
printf '%sNext:%s\n' "$WHITE" "$RESET"
printf '%s  1.%s Move the %sARYZEN Media Downloader%s folder from your Desktop wherever you want it.%s\n' "$WHITE" "$RESET" "$BOLD" "$RESET$WHITE" "$RESET"
printf '%s  2.%s Open brave://extensions or chrome://extensions, turn on Developer mode.%s\n' "$WHITE" "$RESET" "$RESET"
printf '%s  3.%s Click "Load unpacked" and choose that same folder - it is the extension itself.%s\n' "$WHITE" "$RESET" "$RESET"
printf '%s  4.%s Open YouTube (or any supported site) and look for the glass Download button.%s\n\n' "$WHITE" "$RESET" "$RESET"
