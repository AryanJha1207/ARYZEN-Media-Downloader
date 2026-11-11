# ARYZEN Media Downloader (release candidate) - one-time setup for Windows (Brave or Chrome).
# Run from the repo folder, online:
#   powershell -ExecutionPolicy Bypass -File install\install-windows.ps1
#
# Prerequisite: Python 3.11+ on your PATH (https://www.python.org/downloads/ -
# current yt-dlp releases refuse to run on older Python; verified against
# yt-dlp 2026.10.26, which errors out on Python 3.10 and below) -
# tick "Add python.exe to PATH".
#
# Layout: the engine and bridge live in a fixed folder
# (%LOCALAPPDATA%\universal-media-downloader-rc) so the browser can always find
# them; the extension you import lands in "ARYZEN Media Downloader" on your
# Desktop, which you can move anywhere BEFORE importing.
# Isolation promise: registers ONLY the native-messaging host "com.umd.bridge.rc" in HKCU.
$ErrorActionPreference = 'Stop'

# bright palette: white = work in progress, green = success, red = error,
# magenta = Aryzen Nex, dark gray = timestamps and details,
# cyan -> magenta gradient for the title and the rotating loader.

function Stamp { Get-Date -Format 'HH:mm:ss' }
function Die($m)  { Write-Host ('[{0}] ' -f (Stamp)) -NoNewline -ForegroundColor DarkGray; Write-Host 'x ' -NoNewline -ForegroundColor Red; Write-Host $m -ForegroundColor Red; exit 1 }

$Grad = @('Cyan','DarkCyan','Blue','DarkMagenta','Magenta')
function Gradline($line) {
  $colors = $Grad
  $n = $line.Length
  for ($i = 0; $i -lt $n; $i++) {
    $seg = [int]($i * 5 / [math]::Max($n, 1))
    Write-Host $line[$i] -NoNewline -ForegroundColor $colors[$seg]
  }
  Write-Host ''
}
function Banner {
  Write-Host ''
  Gradline '    ___    __  _______'
  Gradline '   /   |  /  |/  / __ \'
  Gradline '  / /| | / /|_/ / / / /'
  Gradline ' / ___ |/ /  / / /_/ /'
  Gradline '/_/  |_|/_/  /_/_____/'
  Write-Host ''
  Write-Host 'ARYZEN Media Downloader' -ForegroundColor White
  Write-Host 'created by Aryzen Nex' -ForegroundColor Magenta
  Write-Host ''
}

# Live layout:
#   Currently at step k/N   <- one line under the banner, updates after each
#                              successful step (clamped at N)
#   <rotating circle> label <- the active step, directly below the counter
#   + label / details       <- completed steps accumulate below, newest last
# The circle (◐◓◑◒, colored with the AMD gradient) turns while work is paced;
# every stage stays up at least 2.5 seconds so fast steps never flicker.
# Visual inspiration: the "loading" circle animation the author linked
# (lottiefiles.com/free-animation/loading-99FrBcVjYZ); no Lottie asset, code
# or license material is used - the spinner is a plain terminal convention
# drawn from scratch in the AMD gradient colors.
$StageTotal = 6
$script:StepN = 0
$script:HistLines = 0
$CounterTop = 0

function Write-At($row, $text, $color) {
  [Console]::SetCursorPosition(0, $row)
  Write-Host ($text.PadRight([Console]::WindowWidth - 1)) -NoNewline -ForegroundColor $color
}
function Update-Counter($n) {
  Write-At $CounterTop "Currently at step $n/$StageTotal" White
  [Console]::SetCursorPosition(0, ($CounterTop + 2 + $script:HistLines))
}

function Invoke-Stage($Label, [scriptblock]$Body) {
  $script:StepN++
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $s0 = Stamp
  $script:Detail = ''
  $failed = $null
  $frames = [char]0x25D0,[char]0x25D3,[char]0x25D1,[char]0x25D2
  try { & $Body } catch { $failed = $_.Exception.Message }
  $i = 0
  while ($sw.Elapsed.TotalSeconds -lt 2.5) {
    Write-At ($CounterTop + 1) ("[{0}] {1} {2}" -f $s0, $frames[$i % 4], $Label) $Grad[$i % 5]
    Start-Sleep -Milliseconds 150
    $i++
  }
  Write-At ($CounterTop + 1) '' DarkGray
  [Console]::SetCursorPosition(0, ($CounterTop + 2 + $script:HistLines))
  if ($failed) {
    Write-Host ('[{0}] x {1}' -f (Stamp), $Label) -ForegroundColor Red
    $script:HistLines++
    Write-Host "             $failed" -ForegroundColor Red
    exit 1
  }
  Write-Host ('[{0}] ' -f (Stamp)) -NoNewline -ForegroundColor DarkGray
  Write-Host '+ ' -NoNewline -ForegroundColor Green
  Write-Host $Label -ForegroundColor Green
  $script:HistLines++
  if ($script:Detail) {
    Write-Host "             $($script:Detail)" -ForegroundColor DarkGray
    $script:HistLines++
  }
  if ($script:StepN -lt $StageTotal) { Update-Counter ($script:StepN + 1) }
}

$Src = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $env:LOCALAPPDATA 'universal-media-downloader-rc'
$DeskDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ARYZEN Media Downloader'
$stage = Join-Path $env:TEMP ('umd-stage-' + [guid]::NewGuid().ToString('N'))

Banner
$CounterTop = [Console]::CursorTop
Write-Host "Currently at step 1/$StageTotal" -ForegroundColor White
Write-Host ''

Invoke-Stage 'Checking your setup' {
  $py = $null
  foreach ($cand in @('py -3', 'python')) {
    try {
      $v = Invoke-Expression "$cand -c `"import sys; print('%d.%d' % sys.version_info[:2])`" 2>$null
      if ($LASTEXITCODE -eq 0 -and $v) {
        $parts = $v.Split('.')
        if ([int]$parts[0] -gt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11)) { $py = $cand; break }
      }
    } catch {}
  }
  if (-not $py) { throw 'Python 3.11+ not found. Current yt-dlp releases need Python 3.11 or newer. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH") and run this again.' }
  if (Test-Path $DeskDir) { throw "$DeskDir already exists. Move or rename it first - I never overwrite a folder that isn't mine." }
  if ((Test-Path $Backend) -and -not (Test-Path (Join-Path $Backend '.umd-rc'))) { throw "$Backend exists and was not created by this installer. Not touching it." }
  $script:Detail = "python ($py)"
}

New-Item -ItemType Directory -Force -Path $stage | Out-Null

# Download and verify everything BEFORE writing anything to the install
# folder, so a failed or tampered download really does leave nothing installed.
Invoke-Stage 'Downloading the yt-dlp engine (latest official release)' {
  try { $rel = Invoke-RestMethod 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest' }
  catch { throw 'could not reach GitHub - check your internet connection and run this again.' }
  $tag = $rel.tag_name
  $sums = (Invoke-WebRequest "https://github.com/yt-dlp/yt-dlp/releases/download/$tag/SHA2-256SUMS").Content
  $want = ($sums -split "`n" | Where-Object { $_ -match '\syt-dlp$' } | ForEach-Object { ($_ -split '\s+')[0] })[0]
  if (-not $want) { throw 'could not read the official yt-dlp checksum' }
  Invoke-WebRequest -OutFile "$stage\yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/download/$tag/yt-dlp"
  $got = (Get-FileHash "$stage\yt-dlp" -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want.ToLower()) { throw 'yt-dlp checksum mismatch - nothing was installed' }
  $script:Detail = "yt-dlp $tag downloaded and SHA-256 verified"
}

Invoke-Stage 'Downloading FFmpeg (latest gyan.dev essentials build)' {
  $ffzip = Join-Path $env:TEMP 'umd-ffmpeg.zip'
  Invoke-WebRequest -OutFile $ffzip 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  $wantFf = ((Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256').Content -split '\s+')[0].Trim()
  $gotFf = (Get-FileHash $ffzip -Algorithm SHA256).Hash.ToLower()
  if (-not $wantFf -or $gotFf -ne $wantFf.ToLower()) {
    Remove-Item $ffzip -Force -ErrorAction SilentlyContinue
    throw 'FFmpeg checksum mismatch - nothing was installed'
  }
  Expand-Archive -Force $ffzip (Join-Path $stage 'umd-ffmpeg')
  $ff = Get-ChildItem -Recurse -Filter ffmpeg.exe (Join-Path $stage 'umd-ffmpeg') | Select-Object -First 1
  $fp = Get-ChildItem -Recurse -Filter ffprobe.exe (Join-Path $stage 'umd-ffmpeg') | Select-Object -First 1
  if (-not $ff -or -not $fp) { throw 'could not unpack FFmpeg and FFprobe - nothing was installed' }
  Remove-Item -Force $ffzip -ErrorAction SilentlyContinue
  $script:FfExe = $ff.FullName
  $script:FpExe = $fp.FullName
  $script:Detail = 'FFmpeg and FFprobe downloaded and verified against the publisher SHA-256'
}

Invoke-Stage 'Installing the local helper' {
  if (Test-Path $Backend) { Remove-Item -Recurse -Force $Backend }
  New-Item -ItemType Directory -Force -Path "$Backend\bridge", "$Backend\bin" | Out-Null
  Copy-Item -Force "$Src\bridge\umd_host.py", "$Src\bridge\run-host.bat" "$Backend\bridge\"
  Copy-Item -Force "$stage\yt-dlp" "$Backend\bin\yt-dlp"
  Copy-Item -Force $script:FfExe "$Backend\bin\ffmpeg.exe"
  Copy-Item -Force $script:FpExe "$Backend\bin\ffprobe.exe"
  New-Item -ItemType File -Force -Path (Join-Path $Backend '.umd-rc') | Out-Null
  $script:Detail = 'helper installed in %LOCALAPPDATA%\universal-media-downloader-rc'
}

Invoke-Stage 'Connecting the helper to your browser(s)' {
  $launcher = ($Backend + '\bridge\run-host.bat') -replace '\\', '\\\\'
  $manifest = (Get-Content "$Src\bridge\com.umd.bridge.rc.json" -Raw).Replace('HOST_LAUNCHER_PATH', $launcher)
  Set-Content -Path "$Backend\bridge\com.umd.bridge.rc.json" -Value $manifest
  foreach ($key in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.umd.bridge.rc',
                     'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.umd.bridge.rc')) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -PropertyType String -Name '(Default)' -Value "$Backend\bridge\com.umd.bridge.rc.json" -Force | Out-Null
  }
  $script:Detail = 'registered with Chrome and Brave (com.umd.bridge.rc)'
}

Invoke-Stage 'Creating your project folder on the Desktop' {
  New-Item -ItemType Directory -Force -Path $DeskDir | Out-Null
  Copy-Item -Recurse -Force "$Src\extension\*" $DeskDir
  @'
ARYZEN Media Downloader - created by Aryzen Nex

This folder is the browser extension. The download engine and bridge were
installed separately in %LOCALAPPDATA%\universal-media-downloader-rc, so
moving THIS folder never breaks anything.

1. Cut and paste this folder anywhere you like (Documents, etc.).
2. Open brave://extensions or chrome://extensions in your browser.
3. Turn on Developer mode (top right).
4. Click "Load unpacked" and choose this folder itself (the one this
   file is in) - it is the extension, with manifest.json at its root.
5. Open a supported site (YouTube, Instagram, Reddit, Twitch, SoundCloud,
   Streamable, TED) and look for the glass Download button.

To uninstall later: remove %LOCALAPPDATA%\universal-media-downloader-rc,
delete the com.umd.bridge.rc registry keys under
HKCU\Software\...\NativeMessagingHosts, and remove the extension from
brave://extensions / chrome://extensions.
'@ | Set-Content -Path (Join-Path $DeskDir 'README-FIRST.txt')
  $script:Detail = 'project folder ready on your Desktop'
}

Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ('[{0}] ' -f (Stamp)) -NoNewline -ForegroundColor DarkGray
Write-Host ' Installation complete ' -ForegroundColor Green
Write-Host 'Next:' -ForegroundColor White
Write-Host '  1. Move the ARYZEN Media Downloader folder from your Desktop wherever you want it.' -ForegroundColor White
Write-Host '  2. Open brave://extensions or chrome://extensions, turn on Developer mode.' -ForegroundColor White
Write-Host '  3. Click "Load unpacked" and choose that same folder - it is the extension itself.' -ForegroundColor White
Write-Host '  4. Open YouTube (or any supported site) and look for the glass Download button.' -ForegroundColor White
Write-Host ''
