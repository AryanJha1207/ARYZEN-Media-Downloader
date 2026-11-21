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
#
# Re-run behavior: checks what's already installed, prints a plan (SKIP/INSTALL/UPDATE),
# and only acts on components that need changes. A repeat run after success is all-SKIP.

set -eu
# Bug fix: ensure pipeline failures are caught
set -o pipefail

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

# Terminal capability detection for animated banner
# Returns 0 if animation should run, 1 if static fallback should be used
term_supports_animation() {
  # Must be interactive TTY on stdout
  [ -t 1 ] || return 1
  # TERM must not be "dumb"
  [ "${TERM:-}" != "dumb" ] || return 1
  # Respect NO_COLOR and CI environment variables
  [ -z "${NO_COLOR:-}" ] || return 1
  [ -z "${CI:-}" ] || return 1
  # Check for ANSI color support (most modern terminals)
  case "${TERM:-}" in
    *color*|*xterm*|*screen*|*tmux*|*vt100*|*vt220*|*rxvt*|*konsole*|*gnome*|*alacritty*|*kitty*|*wezterm*|*foot*)
      return 0
      ;;
    *)
      # Conservative: if we don't know the terminal, prefer static
      return 1
      ;;
  esac
}

stamp() { date +%H:%M:%S; }
err()  { printf '%s[%s]%s %sx%s %s\n' "$DIM" "$(stamp)" "$RESET" "$RED" "$RESET" "$RED$1$RESET" >&2; }
die()  { err "$*"; exit 1; }

# Global temp directory for cleanup
TMPWORK=""

# Cleanup function - called on EXIT, INT, TERM
cleanup() {
  # Restore cursor and terminal state
  printf '%s[?25h' "$ESC" 2>/dev/null || true  # show cursor
  printf '%s' "$RESET" 2>/dev/null || true      # reset colors
  # Clean up temp directory
  if [ -n "$TMPWORK" ] && [ -d "$TMPWORK" ]; then
    rm -rf "$TMPWORK" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ──────────────────────────────────────────────────────────────────────────────
# Component framework: each component the installer manages gets a definition
# and helper functions. This enables the CHECK pass (stage 0) to print a plan
# and then act per-component: SKIP (already present and compatible), INSTALL
# (missing), UPDATE (present but older), or ASK (newer than required).
# ──────────────────────────────────────────────────────────────────────────────

# Global arrays for component metadata (indexed by component name)
COMP_NAMES=""           # space-separated list of component keys
COMP_INSTALL_PATH=""    # associative via eval: COMP_INSTALL_PATH_<key>
COMP_VERSION_CMD=""     # command to get installed version
COMP_REQUIRED_VERSION="" # pinned version or "latest" for dynamic fetch
COMP_FETCH_URL=""       # download URL (or fetch function name for dynamic)
COMP_CHECKSUM_URL=""    # URL to fetch expected checksum
COMP_IS_SYSTEM=""       # "1" = check-only system tool, never installed by us
COMP_STAGE_FN=""        # stage function name to run for INSTALL/UPDATE

# Register a component
# Usage: comp_register key "Install Path" "version_cmd" "required_version" "fetch_url" "checksum_url" "is_system" "stage_fn"
comp_register() {
    key="$1"; install_path="$2"; version_cmd="$3"; required_version="$4"
    fetch_url="$5"; checksum_url="$6"; is_system="$7"; stage_fn="$8"

    COMP_NAMES="$COMP_NAMES $key"
    eval "COMP_INSTALL_PATH_$key=\"$install_path\""
    eval "COMP_VERSION_CMD_$key=\"$version_cmd\""
    eval "COMP_REQUIRED_VERSION_$key=\"$required_version\""
    eval "COMP_FETCH_URL_$key=\"$fetch_url\""
    eval "COMP_CHECKSUM_URL_$key=\"$checksum_url\""
    eval "COMP_IS_SYSTEM_$key=\"$is_system\""
    eval "COMP_STAGE_FN_$key=\"$stage_fn\""
}

# Get installed version by running the component's version command
# Prints version string or "missing" if not found / command fails
comp_get_installed_version() {
    key="$1"
    eval "version_cmd=\$COMP_VERSION_CMD_$key"
    eval "is_system=\$COMP_IS_SYSTEM_$key"

    # For system tools, just run the command; for our components, check install path first
    if [ "$is_system" = "1" ]; then
        # System tool: just run version command
        if eval "$version_cmd" >/dev/null 2>&1; then
            eval "$version_cmd" 2>/dev/null | head -1 | sed 's/^[^0-9]*//' | awk '{print $1}'
        else
            printf "missing"
        fi
    else
        # Our component: check if install path exists
        eval "install_path=\$COMP_INSTALL_PATH_$key"
        if [ -x "$install_path" ] || [ -f "$install_path" ]; then
            if eval "$version_cmd" >/dev/null 2>&1; then
                eval "$version_cmd" 2>/dev/null | head -1 | sed 's/^[^0-9]*//' | awk '{print $1}'
            else
                printf "broken"
            fi
        else
            printf "missing"
        fi
    fi
}

# Get required version - either pinned or fetched dynamically (yt-dlp)
comp_get_required_version() {
    key="$1"
    eval "required_version=\$COMP_REQUIRED_VERSION_$key"
    eval "fetch_url=\$COMP_FETCH_URL_$key"

    if [ "$required_version" = "latest" ]; then
        # Dynamic fetch: try to get latest version from GitHub API (10s timeout)
        if command -v curl >/dev/null 2>&1; then
            latest=$(curl -fsSL --max-time 10 "$fetch_url" 2>/dev/null | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
            if [ -n "$latest" ]; then
                printf "%s" "$latest"
                return
            fi
        fi
        # Could not fetch - will be handled in decide_action
        printf "unknown"
    else
        printf "%s" "$required_version"
    fi
}

# Compare two version strings (semantic-ish).
# Returns: 0 if v1 == v2, 1 if v1 < v2, 2 if v1 > v2, 3 if incomparable
comp_compare_versions() {
    v1="$1"; v2="$2"

    # Handle "missing", "broken", "unknown"
    case "$v1" in missing|broken|unknown) return 3 ;; esac
    case "$v2" in missing|broken|unknown) return 3 ;; esac

    # Strip leading 'v' if present
    v1=${v1#v}; v2=${v2#v}

    # If identical, equal
    [ "$v1" = "$v2" ] && return 0

    # Try sort -V (version sort) if available
    if printf '%s\n%s\n' "$v1" "$v2" | sort -V >/dev/null 2>&1; then
        first=$(printf '%s\n%s\n' "$v1" "$v2" | sort -V | head -1)
        [ "$first" = "$v1" ] && return 1 || return 2
    fi

    # Fallback: lexicographic
    case "$v1" in
        "$v2"*) return 0 ;;
        *) return 3 ;;
    esac
}

# Decide action for a component: SKIP, INSTALL, UPDATE, ASK, or FAIL
# Sets global COMP_ACTION and COMP_ACTION_REASON
comp_decide_action() {
    key="$1"
    eval "is_system=\$COMP_IS_SYSTEM_$key"

    installed=$(comp_get_installed_version "$key")
    required=$(comp_get_required_version "$key")

    # System tools: only CHECK, never install/update
    if [ "$is_system" = "1" ]; then
        case "$installed" in
            missing|broken)
                COMP_ACTION="FAIL"
                COMP_ACTION_REASON="required system tool not found or not working"
                ;;
            *)
                # Check version meets minimum
                comp_compare_versions "$installed" "$required"
                cmp=$?
                if [ $cmp -eq 1 ]; then
                    COMP_ACTION="FAIL"
                    COMP_ACTION_REASON="version $installed < required $required"
                else
                    COMP_ACTION="SKIP"
                    COMP_ACTION_REASON="system tool OK (found $installed, need >= $required)"
                fi
                ;;
        esac
        return
    fi

    # Our managed components
    case "$installed" in
        missing)
            COMP_ACTION="INSTALL"
            COMP_ACTION_REASON="not installed"
            ;;
        broken)
            COMP_ACTION="UPDATE"
            COMP_ACTION_REASON="installed but broken (version probe failed)"
            ;;
        *)
            if [ "$required" = "unknown" ]; then
                # Could not fetch latest version (offline or API fail)
                COMP_ACTION="SKIP"
                COMP_ACTION_REASON="installed version $installed - could not check for updates, keeping it"
            else
                comp_compare_versions "$installed" "$required"
                cmp=$?
                case $cmp in
                    0) COMP_ACTION="SKIP"; COMP_ACTION_REASON="already at required version $required" ;;
                    1) COMP_ACTION="UPDATE"; COMP_ACTION_REASON="installed $installed < required $required" ;;
                    2)
                        # Installed is newer than required - no downgrades
                        # For yt-dlp/Deno, newer is generally compatible (backwards compat policy)
                        # But we should be explicit about this assumption
                        COMP_ACTION="SKIP"
                        COMP_ACTION_REASON="installed $installed > required $required (newer kept; yt-dlp/Deno guarantee backward compat)"
                        ;;
                    *) COMP_ACTION="ASK"; COMP_ACTION_REASON="cannot compare versions: installed=$installed required=$required" ;;
                esac
            fi
            ;;
    esac
}

# Print the plan for all components
comp_print_plan() {
    printf '\n%s%s━━━ INSTALL PLAN ━━━%s\n' "$BOLD" "$WHITE" "$RESET"
    for key in $COMP_NAMES; do
        comp_decide_action "$key"
        eval "install_path=\$COMP_INSTALL_PATH_$key"
        installed=$(comp_get_installed_version "$key")
        required=$(comp_get_required_version "$key")

        # Color the action
        case "$COMP_ACTION" in
            SKIP)   action_col="$GREEN" ;;
            INSTALL) action_col="$WHITE" ;;
            UPDATE) action_col="$WHITE" ;;
            ASK)    action_col="$PURPLE" ;;
            FAIL)   action_col="$RED" ;;
            *)      action_col="$WHITE" ;;
        esac

        printf '  %s%s%-7s%s  %s  found=%s  required=%s  %s\n' \
            "$action_col" "$BOLD" "$COMP_ACTION" "$RESET" \
            "$key" \
            "$installed" \
            "$required" \
            "$DIM($COMP_ACTION_REASON)$RESET"
    done
    printf '%s%s━━━━━━━━━━━━━━━━━%s\n\n' "$BOLD" "$WHITE" "$RESET"
}

# Download and verify a component to a temp file
# Sets COMP_TEMP_FILE to the verified temp file path
comp_download_and_verify() {
    key="$1"
    eval "fetch_url=\$COMP_FETCH_URL_$key"
    eval "checksum_url=\$COMP_CHECKSUM_URL_$key"
    eval "stage_fn=\$COMP_STAGE_FN_$key"

    # Create temp file
    tmpfile=$(mktemp /tmp/umd-dl-XXXXXX)
    trap 'rm -f "$tmpfile"' RETURN

    # Download
    printf '%s[%s]%s %s↓%s Downloading %s...\n' "$DIM" "$(stamp)" "$RESET" "$WHITE" "$RESET" "$key"
    if ! curl -fsSL --max-time 120 "$fetch_url" -o "$tmpfile"; then
        die "Failed to download $key from $fetch_url"
    fi

    # Verify checksum if provided
    if [ -n "$checksum_url" ] && [ "$checksum_url" != "none" ]; then
        printf '%s[%s]%s %s⟳%s Verifying checksum...\n' "$DIM" "$(stamp)" "$RESET" "$WHITE" "$RESET"
        expected_sha=$(curl -fsSL --max-time 10 "$checksum_url" 2>/dev/null | grep -E "^[a-fA-F0-9]{64}" | head -1 | awk '{print $1}')
        if [ -z "$expected_sha" ]; then
            die "Could not fetch expected checksum for $key from $checksum_url"
        fi
        actual_sha=$(sha256sum "$tmpfile" | awk '{print $1}')
        if [ "$actual_sha" != "$expected_sha" ]; then
            die "Checksum mismatch for $key: expected $expected_sha, got $actual_sha"
        fi
    fi

    # Verify it actually runs (version probe)
    chmod +x "$tmpfile" 2>/dev/null || true
    eval "version_cmd=\$COMP_VERSION_CMD_$key"
    # Replace the binary path in version_cmd with our temp file for testing
    test_cmd=$(printf '%s' "$version_cmd" | sed "s|.*/\(yt-dlp\|deno\)|$tmpfile|")
    if ! eval "$test_cmd" >/dev/null 2>&1; then
        die "Downloaded $key fails version probe (may be corrupt or wrong arch)"
    fi

    COMP_TEMP_FILE="$tmpfile"
    trap - RETURN
}

# Install component atomically from temp file
comp_install_component() {
    key="$1"
    eval "install_path=\$COMP_INSTALL_PATH_$key"
    eval "stage_fn=\$COMP_STAGE_FN_$key"

    # Ensure parent dir exists
    mkdir -p "$(dirname "$install_path")"

    # Atomic move: stage to .new then rename
    newpath="${install_path}.new"
    cp "$COMP_TEMP_FILE" "$newpath"
    chmod +x "$newpath" 2>/dev/null || true
    mv -f "$newpath" "$install_path"

    # Write version stamp in install dir
    installed=$(comp_get_installed_version "$key")
    stamp_dir=$(dirname "$install_path")
    printf '%s\n' "$installed" > "$stamp_dir/.umd-version-$key"
}

# Write stamp only for components that changed this run
comp_write_stamp_if_changed() {
    key="$1"
    eval "install_path=\$COMP_INSTALL_PATH_$key"
    stamp_dir=$(dirname "$install_path")
    installed=$(comp_get_installed_version "$key")
    printf '%s\n' "$installed" > "$stamp_dir/.umd-version-$key"
}

# Byte-compare source and destination, copy only if different
comp_sync_file() {
    src="$1"; dst="$2"
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
        return 1  # no change
    fi
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    return 0  # changed
}

# Check if a folder is recognizably ours (has our marker file)
comp_is_our_folder() {
    folder="$1"
    [ -f "$folder/.umd-rc" ]
}

# ──────────────────────────────────────────────────────────────────────────────
# Component registrations for Linux
# ──────────────────────────────────────────────────────────────────────────────

# Paths
BACKEND="$HOME/.universal-media-downloader-rc"
YT_DLP_BIN="$BACKEND/bin/yt-dlp"
DENO_BIN="$BACKEND/bin/deno"
BRIDGE_DIR="$BACKEND/bridge"
SRC="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# Register components in CHECK order (system tools first, then our components)
# System tools (CHECK-ONLY, never installed by us)
comp_register "python3" \
    "$(command -v python3)" \
    "python3 --version 2>&1 | awk '{print \$2}'" \
    "3.11" \
    "" "" \
    "1" ""

comp_register "curl" \
    "$(command -v curl)" \
    "curl --version 2>&1 | head -1 | awk '{print \$2}'" \
    "7.0" \
    "" "" \
    "1" ""

comp_register "ffmpeg" \
    "$(command -v ffmpeg)" \
    "ffmpeg -version 2>&1 | head -1 | awk '{print \$3}'" \
    "4.0" \
    "" "" \
    "1" ""

comp_register "ffprobe" \
    "$(command -v ffprobe)" \
    "ffprobe -version 2>&1 | head -1 | awk '{print \$3}'" \
    "4.0" \
    "" "" \
    "1" ""

# Our managed components
comp_register "yt-dlp" \
    "$YT_DLP_BIN" \
    "$YT_DLP_BIN --version" \
    "latest" \
    "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest" \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA256SUMS" \
    "0" "stage_download"

comp_register "deno" \
    "$DENO_BIN" \
    "$DENO_BIN --version 2>&1 | head -1 | awk '{print \$2}'" \
    "v2.9.8" \
    "https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-unknown-linux-gnu.zip" \
    "https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-unknown-linux-gnu.zip.sha256sum" \
    "0" "stage_deno"

# Bridge files, registration, extension are handled by their stages (no binary version)
# We'll add pseudo-components for them to show in plan
comp_register "bridge-files" \
    "$BRIDGE_DIR/umd_host.py" \
    "test -f $BRIDGE_DIR/umd_host.py && echo present || echo missing" \
    "present" \
    "" "" \
    "0" "stage_helper"

comp_register "browser-registration" \
    "$HOME/.config/google-chrome/NativeMessagingHosts/com.umd.bridge.rc.json" \
    "test -f $HOME/.config/google-chrome/NativeMessagingHosts/com.umd.bridge.rc.json && echo registered || echo missing" \
    "registered" \
    "" "" \
    "0" "stage_register"

comp_register "extension-folder" \
    "$HOME/Desktop/ARYZEN Media Downloader" \
    "test -f $HOME/Desktop/ARYZEN\ Media\ Downloader/.umd-rc && echo present || echo missing" \
    "present" \
    "" "" \
    "0" "stage_desktop"

# Deno: the JavaScript runtime current yt-dlp needs for YouTube's JS
# challenges (yt-dlp announcement, github.com/yt-dlp/yt-dlp/issues/14404).
DENO_TAG="v2.9.8"

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

# Animated banner - shows a gentle gradient sweep across the AMD logo
# Only runs if terminal supports animation; otherwise falls back to static banner
animated_banner() {
  # If animation not supported, use static banner
  term_supports_animation || { banner; return 0; }

  # Hide cursor during animation
  printf '%s[?25l' "$ESC"

  # The ASCII art lines
  art_lines="
    ___    __  _______
   /   |  /  |/  / __ \\
  / /| | / /|_/ / / / /
 / ___ |/ /  / / /_/ /
/_/  |_/_/  /_/_____/
"

  # Gradient colors (same as gradline)
  grad_colors="$G1 $G2 $G3 $G4 $G5"
  # Convert to array
  set -f; IFS=' '; set -- $grad_colors; IFS=' '; set +f
  # We'll use the same 5 colors

  # Animation parameters
  total_frames=35
  frame_delay=0.04  # ~40ms per frame = ~1.4s total

  # Get the art lines into an array
  line_idx=0
  printf '%s' "$art_lines" | while IFS= read -r line; do
    [ -n "$line" ] && eval "art_line_$line_idx=\"$line\"" && line_idx=$((line_idx + 1))
  done
  art_line_count=$line_idx

  # For each frame, progressively reveal the gradient
  frame=0
  while [ $frame -le $total_frames ]; do
    # Clear the art area (move up and clear lines)
    if [ $frame -gt 0 ]; then
      printf '%s[%dA' "$ESC" $((art_line_count + 3))  # +3 for blank + title + byline
    fi

    # Calculate progress (0.0 to 1.0)
    progress=$(awk -v f="$frame" -v t="$total_frames" 'BEGIN { printf "%.3f", f/t }')

    # Render each line with gradient sweep
    i=0
    while [ $i -lt $art_line_count ]; do
      eval "line=\$art_line_$i"
      len=${#line}
      # Sweep position: how many characters should be "lit up"
      sweep_pos=$(awk -v p="$progress" -v l="$len" 'BEGIN { printf "%d", p * l }')
      
      # Print line with gradient up to sweep_pos, dim after
      char_idx=0
      while [ $char_idx -lt $len ]; do
        ch=$(printf '%s' "$line" | cut -c $((char_idx + 1)))
        if [ $char_idx -lt $sweep_pos ]; then
          # In gradient zone - use position-based color
          seg=$(( char_idx * 5 / len ))
          case $seg in
            0) c=$G1 ;; 1) c=$G2 ;; 2) c=$G3 ;; 3) c=$G4 ;; *) c=$G5 ;;
          esac
          printf '%s%s' "$c" "$ch"
        else
          # Not yet reached - dim
          printf '%s%s' "$DIM" "$ch"
        fi
        char_idx=$((char_idx + 1))
      done
      printf '%s\n' "$RESET"
      i=$((i + 1))
    done

    # Title and byline (static, full color)
    printf '%s%sARYZEN Media Downloader%s\n' "$BOLD" "$WHITE" "$RESET"
    printf '%screated by Aryzen Nex%s\n' "$PURPLE" "$RESET"

    frame=$((frame + 1))
    # Sleep using portable method
    sleep "$frame_delay" 2>/dev/null || sleep 1 2>/dev/null || true
  done

  # Show cursor
  printf '%s[?25h' "$ESC"
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
STAGE_TOTAL=7
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

TMPWORK=$(mktemp -d)

# Stage 0: Print the install plan (what will be SKIP/INSTALL/UPDATE)
stage_check_plan() {
    comp_print_plan
    # Check for any FAIL actions (system tools missing or too old)
    for key in $COMP_NAMES; do
        comp_decide_action "$key"
        if [ "$COMP_ACTION" = "FAIL" ]; then
            eval "install_path=\$COMP_INSTALL_PATH_$key"
            installed=$(comp_get_installed_version "$key")
            required=$(comp_get_required_version "$key")
            die "$key: $COMP_ACTION_REASON (found=$installed required=$required)"
        fi
        if [ "$COMP_ACTION" = "ASK" ]; then
            eval "install_path=\$COMP_INSTALL_PATH_$key"
            installed=$(comp_get_installed_version "$key")
            required=$(comp_get_required_version "$key")
            printf '%s[%s]%s %s!%s %s: installed %s > required %s. Keep newer (k) or install pinned (i)? ' \
                "$DIM" "$(stamp)" "$RESET" "$PURPLE" "$RESET" "$key" "$installed" "$required"
            read -r choice
            case "$choice" in
                k|K) COMP_ACTION="SKIP"; COMP_ACTION_REASON="user chose to keep newer version $installed" ;;
                i|I) COMP_ACTION="INSTALL"; COMP_ACTION_REASON="user chose to install pinned version $required" ;;
                *) die "Invalid choice. Run again and choose k or i." ;;
            esac
        fi
    done
}

stage_check() {
  # System tools already checked in stage_check_plan - just verify they still work
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
  # Check Desktop folder - only fail if it exists and is NOT ours
  if [ -e "$DESKDIR" ] && ! comp_is_our_folder "$DESKDIR"; then
    echo "$DESKDIR already exists and was not created by this installer. Move or rename it first - I never overwrite a folder that isn't mine."
    return 1
  fi
  # Check backend folder - only fail if it exists and is NOT ours
  if [ -e "$BACKEND" ] && [ ! -f "$BACKEND/.umd-rc" ]; then
    echo "$BACKEND exists and was not created by this installer. Not touching it."
    return 1
  fi
  echo "python3 $(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])') + curl + ffmpeg"
}

stage_download() {
  # Check plan for yt-dlp
  comp_decide_action "yt-dlp"
  case "$COMP_ACTION" in
    SKIP)
      echo "SKIP: yt-dlp already at required version ($COMP_ACTION_REASON)"
      return 0
      ;;
    INSTALL|UPDATE)
      # Proceed with download
      ;;
    *)
      echo "SKIP: yt-dlp ($COMP_ACTION_REASON)"
      return 0
      ;;
  esac

  TAG=$(curl -fsSL --max-time 10 https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) || return 1
  if [ -z "$TAG" ]; then
    echo "could not reach GitHub - check your internet connection and run this again."
    return 1
  fi
  WANT=$(curl -fsSL --max-time 10 "https://github.com/yt-dlp/yt-dlp/releases/download/$TAG/SHA256SUMS" | awk '$2=="yt-dlp"{print $1}') || return 1
  if [ -z "$WANT" ]; then
    echo "could not read the official yt-dlp checksum."
    return 1
  fi
  if ! curl -fsSL --max-time 60 -o "$TMPWORK/yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/download/$TAG/yt-dlp"; then
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

stage_deno() {
  # Check plan for deno
  comp_decide_action "deno"
  case "$COMP_ACTION" in
    SKIP)
      echo "SKIP: deno already at required version ($COMP_ACTION_REASON)"
      return 0
      ;;
    INSTALL|UPDATE)
      # Proceed with download
      ;;
    *)
      echo "SKIP: deno ($COMP_ACTION_REASON)"
      return 0
      ;;
  esac

  case "$(uname -m)" in
    x86_64) DZIP="deno-x86_64-unknown-linux-gnu.zip" ;;
    aarch64|arm64) DZIP="deno-aarch64-unknown-linux-gnu.zip" ;;
    *) echo "unsupported processor for the Deno runtime: $(uname -m)"; return 1 ;;
  esac
  if ! curl -fsSL --max-time 60 -o "$TMPWORK/deno.zip" "https://github.com/denoland/deno/releases/download/$DENO_TAG/$DZIP"; then
    echo "Deno runtime download failed - check your internet connection."
    return 1
  fi
  WANTD=$(curl -fsSL --max-time 10 "https://github.com/denoland/deno/releases/download/$DENO_TAG/$DZIP.sha256sum" | grep -Eo '[0-9a-fA-F]{64}' | head -1 | tr 'A-F' 'a-f') || true
  if [ -z "$WANTD" ]; then
    echo "could not read the official Deno checksum."
    return 1
  fi
  GOTD=$(sha256sum "$TMPWORK/deno.zip" | awk '{print $1}')
  if [ "$GOTD" != "$WANTD" ]; then
    echo "Deno checksum mismatch - nothing was installed."
    return 1
  fi
  # python3 (already required by this installer) unpacks the zip - no unzip dependency.
  python3 -m zipfile -e "$TMPWORK/deno.zip" "$TMPWORK/deno-x/"
  if [ ! -f "$TMPWORK/deno-x/deno" ]; then
    echo "downloaded Deno archive did not contain the expected binary - nothing was installed."
    return 1
  fi
  # Deno is MIT-licensed; the license text must accompany the binary.
  if ! curl -fsSL --max-time 10 -o "$TMPWORK/deno.LICENSE.txt" "https://raw.githubusercontent.com/denoland/deno/$DENO_TAG/LICENSE.md" || ! grep -q 'MIT License' "$TMPWORK/deno.LICENSE.txt"; then
    echo "could not fetch the Deno license text - nothing was installed."
    return 1
  fi
  echo "Deno $DENO_TAG runtime downloaded and SHA-256 verified"
}

stage_helper() {
  # Check plan for bridge-files
  comp_decide_action "bridge-files"
  case "$COMP_ACTION" in
    SKIP)
      echo "SKIP: bridge-files already present ($COMP_ACTION_REASON)"
      # Still need to ensure binaries are in place if they were just downloaded
      ;;
    INSTALL|UPDATE)
      # Proceed with installation
      ;;
    *)
      echo "SKIP: bridge-files ($COMP_ACTION_REASON)"
      ;;
  esac

  mkdir -p "$BACKEND/bridge" "$BACKEND/bin"
  # Copy bridge files only if changed (byte-compare)
  comp_sync_file "$SRC/bridge/umd_host.py" "$BACKEND/bridge/umd_host.py" && echo "  updated: umd_host.py"
  comp_sync_file "$SRC/bridge/run-host.sh" "$BACKEND/bridge/run-host.sh" && echo "  updated: run-host.sh"
  chmod +x "$BACKEND/bridge/run-host.sh"

  # Install yt-dlp if it was downloaded (INSTALL/UPDATE)
  comp_decide_action "yt-dlp"
  if [ "$COMP_ACTION" = "INSTALL" ] || [ "$COMP_ACTION" = "UPDATE" ]; then
    cp "$TMPWORK/yt-dlp" "$BACKEND/bin/yt-dlp"
    chmod +x "$BACKEND/bin/yt-dlp"
    comp_write_stamp_if_changed "yt-dlp"
    echo "  installed: yt-dlp"
  fi

  # Link system ffmpeg/ffprobe (always recreate links)
  ln -sf "$(command -v ffmpeg)" "$BACKEND/bin/ffmpeg"
  ln -sf "$(command -v ffprobe)" "$BACKEND/bin/ffprobe"

  # Install deno if it was downloaded (INSTALL/UPDATE)
  comp_decide_action "deno"
  if [ "$COMP_ACTION" = "INSTALL" ] || [ "$COMP_ACTION" = "UPDATE" ]; then
    cp "$TMPWORK/deno-x/deno" "$BACKEND/bin/deno"
    cp "$TMPWORK/deno.LICENSE.txt" "$BACKEND/bin/deno.LICENSE.txt"
    chmod +x "$BACKEND/bin/deno"
    comp_write_stamp_if_changed "deno"
    echo "  installed: deno"
  fi

  touch "$BACKEND/.umd-rc"
  echo "helper installed in ~/.universal-media-downloader-rc"
}

stage_register() {
  # Check plan for browser-registration
  comp_decide_action "browser-registration"
  case "$COMP_ACTION" in
    SKIP)
      echo "SKIP: browser-registration already present ($COMP_ACTION_REASON)"
      return 0
      ;;
    INSTALL|UPDATE)
      # Proceed with registration
      ;;
    *)
      echo "SKIP: browser-registration ($COMP_ACTION_REASON)"
      return 0
      ;;
  esac

  for D in "$HOME/.config/google-chrome/NativeMessagingHosts" \
           "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
           "$HOME/.config/chromium/NativeMessagingHosts"; do
    mkdir -p "$D"
    sed "s|HOST_LAUNCHER_PATH|$BACKEND/bridge/run-host.sh|" "$SRC/bridge/com.umd.bridge.rc.json" > "$D/com.umd.bridge.rc.json"
  done
  echo "registered with Chrome, Brave and Chromium (com.umd.bridge.rc)"
}

stage_desktop() {
  # Check plan for extension-folder
  comp_decide_action "extension-folder"
  case "$COMP_ACTION" in
    SKIP)
      # Check if folder exists but is not ours - already checked in stage_check
      if [ -e "$DESKDIR" ] && comp_is_our_folder "$DESKDIR"; then
        echo "SKIP: extension-folder already present ($COMP_ACTION_REASON)"
        return 0
      fi
      # Folder doesn't exist or is not ours - proceed
      ;;
    INSTALL|UPDATE)
      # Proceed with installation
      ;;
    *)
      echo "SKIP: extension-folder ($COMP_ACTION_REASON)"
      return 0
      ;;
  esac

  mkdir -p "$HOME/Desktop"
  mkdir -p "$DESKDIR"
  # Copy extension files only if changed (byte-compare)
  # We need to copy recursively but only changed files
  for src in "$SRC/extension/"*; do
    [ -e "$src" ] || continue
    base=$(basename "$src")
    dst="$DESKDIR/$base"
    if [ -d "$src" ]; then
      mkdir -p "$dst"
      for f in "$src/"*; do
        [ -e "$f" ] || continue
        fb=$(basename "$f")
        comp_sync_file "$f" "$dst/$fb"
      done
    else
      comp_sync_file "$src" "$dst"
    fi
  done
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
  # Ensure marker exists
  touch "$DESKDIR/.umd-rc"
  echo "project folder ready on your Desktop"
}

animated_banner
printf '%s%sCurrently at step 1/%s%s\n\n' "$WHITE" "$BOLD" "$STAGE_TOTAL" "$RESET"
stage "Checking what's already installed" stage_check_plan
stage "Checking your setup" stage_check
stage "Downloading the yt-dlp engine (latest official release)" stage_download
stage "Downloading the Deno JavaScript runtime (needed for YouTube)" stage_deno
stage "Installing the local helper" stage_helper
stage "Connecting the helper to your browser(s)" stage_register
stage "Creating your project folder on the Desktop" stage_desktop

printf '\n%s[%s]%s %s%s Installation complete %s\n' "$DIM" "$(stamp)" "$RESET" "$GREEN" "$BOLD" "$RESET"
printf '%sNext:%s\n' "$WHITE" "$RESET"
printf '%s  1.%s Move the %sARYZEN Media Downloader%s folder from your Desktop wherever you want it.%s\n' "$WHITE" "$RESET" "$BOLD" "$RESET$WHITE" "$RESET"
printf '%s  2.%s Open brave://extensions or chrome://extensions, turn on Developer mode.%s\n' "$WHITE" "$RESET" "$RESET"
printf '%s  3.%s Click "Load unpacked" and choose that same folder - it is the extension itself.%s\n' "$WHITE" "$RESET" "$RESET"
printf '%s  4.%s Open YouTube (or any supported site) and look for the glass Download button.%s\n\n' "$WHITE" "$RESET" "$RESET"
