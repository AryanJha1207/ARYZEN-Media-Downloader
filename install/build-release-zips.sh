#!/bin/sh
# ============================================================================
#  ARYZEN Media Downloader - build the four OS release ZIPs from this repo
# ----------------------------------------------------------------------------
#  Run from anywhere:   sh install/build-release-zips.sh [output-dir]
#
#  Reads the version from extension/manifest.json and creates:
#    <output-dir>/v<version>/ARYZEN-Media-Downloader-Windows.zip
#    <output-dir>/v<version>/ARYZEN-Media-Downloader-macOS-AppleSilicon.zip
#    <output-dir>/v<version>/ARYZEN-Media-Downloader-macOS-Intel.zip
#    <output-dir>/v<version>/ARYZEN-Media-Downloader-Linux.zip
#  (default output-dir: release-zips/ in this folder, which is git-ignored)
#  Prints a SHA-256 checksum for each ZIP.
#
#  Needs only zip and shasum - both preinstalled on macOS.
# ============================================================================
set -e
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/extension/manifest.json" | head -1)
if [ -z "$VER" ]; then
  echo "x could not read the version from extension/manifest.json" >&2
  exit 1
fi
OUTBASE=${1:-"$ROOT/release-zips"}
OUT="$OUTBASE/v$VER"
STAGE="$OUT/.staging"
rm -rf "$STAGE"
mkdir -p "$OUT" "$STAGE"
echo "== ARYZEN Media Downloader v$VER - building release ZIPs"

build_one() {  # $1 = OS slug
  OS="$1"
  D="$STAGE/ARYZEN-Media-Downloader-$OS"
  mkdir -p "$D/bridge" "$D/install"
  cp "$ROOT/README.md" "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES" "$D/"
  cp -R "$ROOT/extension" "$D/extension"
  cp "$ROOT/install/install-linux.sh" "$ROOT/install/install-macos.sh" "$ROOT/install/install-windows.ps1" "$D/install/"
  cp "$ROOT/bridge/umd_host.py" "$ROOT/bridge/run-host.bat" "$ROOT/bridge/run-host.sh" "$ROOT/bridge/com.umd.bridge.rc.json" "$D/bridge/"
  write_wrappers "$OS" "$D"
  find "$D" -name '.DS_Store' -delete 2>/dev/null || true
  (cd "$STAGE" && zip -q -r -X "$OUT/ARYZEN-Media-Downloader-$OS.zip" "ARYZEN-Media-Downloader-$OS")
  echo "+ ARYZEN-Media-Downloader-$OS.zip"
}

write_wrappers() {  # $1 = OS slug, $2 = target dir
  case "$1" in
    Windows)
      cat > "$2/START-HERE.txt" <<'AMD_SH_WINDOWS'
ARYZEN Media Downloader - Windows

1. Get and extract the ZIP: download ARYZEN-Media-Downloader-Windows.zip from the
   GitHub Releases page and extract it. Right-click the ZIP -> "Extract All".

2. Prerequisites: Python 3.11+ from python.org, installed first. During its
   setup, tick "Add python.exe to PATH".

3. Run the installer: double-click "Install ARYZEN Media Downloader.bat".
   If Windows SmartScreen warns: click "More info" and, when offered,
   "Run anyway". If no "Run anyway" option appears, close the warning,
   right-click the .bat file -> Properties, tick "Unblock" near the
   bottom, click OK, and double-click it again.

4. The installer opens with live progress (the AMD banner). When it
   finishes it prints the next steps and puts an
   "ARYZEN Media Downloader" folder on your Desktop.

5. Open brave://extensions or chrome://extensions, turn on Developer
   mode, click "Load unpacked", and choose that Desktop folder.

6. Open YouTube (or Instagram, Reddit, Twitch, SoundCloud, Streamable,
   TED) and look for the glass Download button.
AMD_SH_WINDOWS
      cat > "$2/Install ARYZEN Media Downloader.bat" <<'AMD_L_WINDOWS_0'
@echo off
rem Double-click installer for ARYZEN Media Downloader.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "install\install-windows.ps1"
echo.
pause
AMD_L_WINDOWS_0
      ;;
    macOS-AppleSilicon)
      cat > "$2/START-HERE.txt" <<'AMD_SH_MACOS_APPLESILICON'
ARYZEN Media Downloader - macOS (Apple Silicon: M1, M2, M3, M4)

1. Get and extract the ZIP: download ARYZEN-Media-Downloader-macOS-AppleSilicon.zip from the
   GitHub Releases page and extract it. On a Mac, double-clicking the ZIP extracts it.

2. Prerequisites: an Apple Silicon Mac (M1, M2, M3, M4) and an internet
   connection - nothing else. The installer downloads the engine and
   checksum-verifies every piece.

3. Run the installer: double-click "Install ARYZEN Media Downloader.command".
   If macOS blocks it (files downloaded from the internet are often
   restricted):
   - Try right-click -> Open. On many Macs that offers an Open button
     that lets the installer run - but macOS versions differ, and it
     may still refuse.
   - Reliable fallback - the terminal: open Terminal, type  sh  (with
     a space), drag "Install ARYZEN Media Downloader.command" into the
     window, and press Return.

4. The installer opens with live progress (the AMD banner). When it
   finishes it prints the next steps and puts an
   "ARYZEN Media Downloader" folder on your Desktop.

5. Open brave://extensions or chrome://extensions, turn on Developer
   mode, click "Load unpacked", and choose that Desktop folder.

6. Open YouTube (or Instagram, Reddit, Twitch, SoundCloud, Streamable,
   TED) and look for the glass Download button.
AMD_SH_MACOS_APPLESILICON
      cat > "$2/Install ARYZEN Media Downloader.command" <<'AMD_L_MACOS_APPLESILICON_0'
#!/bin/sh
# Double-click installer for ARYZEN Media Downloader.
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
sh install/install-macos.sh
echo
printf '%s' "Press Enter to close this window."
read _
AMD_L_MACOS_APPLESILICON_0
      chmod +x "$2/Install ARYZEN Media Downloader.command"
      ;;
    macOS-Intel)
      cat > "$2/START-HERE.txt" <<'AMD_SH_MACOS_INTEL'
ARYZEN Media Downloader - macOS (Intel)

1. Get and extract the ZIP: download ARYZEN-Media-Downloader-macOS-Intel.zip from the
   GitHub Releases page and extract it. On a Mac, double-clicking the ZIP extracts it.

2. Prerequisites: an Intel Mac and an internet connection - nothing else.
   The installer downloads the engine and checksum-verifies every piece.

3. Run the installer: double-click "Install ARYZEN Media Downloader.command".
   If macOS blocks it (files downloaded from the internet are often
   restricted):
   - Try right-click -> Open. On many Macs that offers an Open button
     that lets the installer run - but macOS versions differ, and it
     may still refuse.
   - Reliable fallback - the terminal: open Terminal, type  sh  (with
     a space), drag "Install ARYZEN Media Downloader.command" into the
     window, and press Return.

4. The installer opens with live progress (the AMD banner). When it
   finishes it prints the next steps and puts an
   "ARYZEN Media Downloader" folder on your Desktop.

5. Open brave://extensions or chrome://extensions, turn on Developer
   mode, click "Load unpacked", and choose that Desktop folder.

6. Open YouTube (or Instagram, Reddit, Twitch, SoundCloud, Streamable,
   TED) and look for the glass Download button.

(The same installer auto-detects your processor; this ZIP is labeled so
nobody has to guess which one to grab.)
AMD_SH_MACOS_INTEL
      cat > "$2/Install ARYZEN Media Downloader.command" <<'AMD_L_MACOS_INTEL_0'
#!/bin/sh
# Double-click installer for ARYZEN Media Downloader.
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
sh install/install-macos.sh
echo
printf '%s' "Press Enter to close this window."
read _
AMD_L_MACOS_INTEL_0
      chmod +x "$2/Install ARYZEN Media Downloader.command"
      ;;
    Linux)
      cat > "$2/START-HERE.txt" <<'AMD_SH_LINUX'
ARYZEN Media Downloader - Linux

1. Get and extract the ZIP: download ARYZEN-Media-Downloader-Linux.zip from the
   GitHub Releases page and extract it. Use your file manager's Extract option, or run:  unzip ARYZEN-Media-Downloader-Linux.zip

2. Prerequisites: python3 (3.11+), curl, and ffmpeg (ffprobe comes with it):
     Debian/Ubuntu:  sudo apt install python3 curl ffmpeg
     Fedora:         sudo dnf install python3 curl ffmpeg
     Arch:           sudo pacman -S python curl ffmpeg

3. Run the installer: two ways:
   a) Desktop launcher (unverified): double-click
      "Install ARYZEN Media Downloader.desktop". On desktops that
      support it, this opens a terminal window with the AMD progress
      animation; GNOME and KDE may first ask you to "Allow Launching" /
      "Trust and Launch" for a downloaded file. Desktop behavior varies
      and this route was not verified on a live desktop - if
      double-click does nothing, opens a text editor, or shows the
      launcher's own fallback message, use option b.
   b) Terminal (the reliable route): open a terminal in this folder and
      run:
        sh "Install ARYZEN Media Downloader.sh"

4. The installer opens with live progress (the AMD banner). When it
   finishes it prints the next steps and puts an
   "ARYZEN Media Downloader" folder on your Desktop.

5. Open brave://extensions or chrome://extensions, turn on Developer
   mode, click "Load unpacked", and choose that Desktop folder.

6. Open YouTube (or Instagram, Reddit, Twitch, SoundCloud, Streamable,
   TED) and look for the glass Download button.
AMD_SH_LINUX
      cat > "$2/Install ARYZEN Media Downloader.sh" <<'AMD_L_LINUX_0'
#!/bin/sh
# Double-click installer for ARYZEN Media Downloader (choose "Run as
# Program" / "Run in Terminal" if your desktop asks), or run:
#   sh "Install ARYZEN Media Downloader.sh"
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
sh install/install-linux.sh
echo
printf '%s' "Press Enter to close this window."
read _
AMD_L_LINUX_0
      chmod +x "$2/Install ARYZEN Media Downloader.sh"
      cat > "$2/Install ARYZEN Media Downloader.desktop" <<'AMD_L_LINUX_1'
[Desktop Entry]
Type=Application
Name=Install ARYZEN Media Downloader
Comment=One-time setup for ARYZEN Media Downloader
Exec=sh -c "d=\$(dirname \"\$1\"); if cd \"\$d\" 2>/dev/null && [ -f ./install/install-linux.sh ]; then sh ./install/install-linux.sh; else echo; echo \"This launcher could not locate the install files next to it.\"; echo \"Open a terminal in the unzipped folder and run:\"; echo \"  sh install/install-linux.sh\"; fi; echo; printf 'Press Enter to close. '; read _" sh %k
Terminal=true
Categories=Utility;
AMD_L_LINUX_1
      chmod +x "$2/Install ARYZEN Media Downloader.desktop"
      ;;
  esac
}

for OS in Windows macOS-AppleSilicon macOS-Intel Linux; do
  build_one "$OS"
done
rm -rf "$STAGE"

echo
echo "== SHA-256"
for OS in Windows macOS-AppleSilicon macOS-Intel Linux; do
  shasum -a 256 "$OUT/ARYZEN-Media-Downloader-$OS.zip" | awk '{n=split($2,a,"/"); print "  " a[n] "  " $1}'
done
echo
echo "Done. Attach these four ZIPs to the GitHub release for v$VER:"
echo "  $OUT"
