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
# Windows PowerShell 5.1 network defaults: allow TLS 1.2 (GitHub requires it) and
# skip the download progress bar, which makes large downloads crawl under 5.1.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 returns .Content as a byte[] for octet-stream responses
# (that is how GitHub serves release files); decode those to text explicitly.
function Get-WebText($resp) {
  $c = $resp.Content
  if ($c -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($c) }
  return [string]$c
}

# ──────────────────────────────────────────────────────────────────────────────
# Terminal capability detection for animated banner
# Returns $true if animation should run, $false if static fallback should be used
function Test-TerminalAnimationSupport {
  # Check if stdout is redirected/piped
  try {
    $null = [Console]::CursorLeft  # Will throw if not a console
  } catch {
    return $false
  }
  # Check TERM environment variable (if set via WSLENV or similar)
  $term = [Environment]::GetEnvironmentVariable('TERM', 'Process')
  if ($term -and $term -eq 'dumb') { return $false }
  # Respect NO_COLOR and CI environment variables
  if ([Environment]::GetEnvironmentVariable('NO_COLOR', 'Process')) { return $false }
  if ([Environment]::GetEnvironmentVariable('CI', 'Process')) { return $false }
  # Check for ANSI-capable terminal types
  if ($term) {
    $ansiTerms = @('*color*', '*xterm*', '*screen*', '*tmux*', '*vt100*', '*vt220*', '*rxvt*', '*konsole*', '*gnome*', '*alacritty*', '*kitty*', '*wezterm*', '*foot*', '*wt*', '*windowsterminal*')
    foreach ($pattern in $ansiTerms) {
      if ($term -like $pattern) { return $true }
    }
  }
  # Check if we're in Windows Terminal / modern console host
  $wt = [Environment]::GetEnvironmentVariable('WT_SESSION', 'Process')
  if ($wt) { return $true }
  # Conservative: prefer static if uncertain
  return $false
}

# Global temp stage directory for cleanup
$script:StageDir = ''

# Cleanup function - called on EXIT and interrupt
function Invoke-Cleanup {
  # Restore cursor visibility
  try { [Console]::CursorVisible = $true } catch {}
  # Clean up temp directory
  if ($script:StageDir -and (Test-Path $script:StageDir)) {
    Remove-Item -Recurse -Force $script:StageDir -ErrorAction SilentlyContinue
  }
}

# Register cleanup on exit and Ctrl+C
$script:CleanupRegistered = $false
function Register-Cleanup {
  if (-not $script:CleanupRegistered) {
    # Register for normal exit
    Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Invoke-Cleanup } | Out-Null
    # Register for Ctrl+C
    [Console]::CancelKeyPress.Add({ Invoke-Cleanup; exit 1 }) | Out-Null
    $script:CleanupRegistered = $true
  }
}

Register-Cleanup

# ──────────────────────────────────────────────────────────────────────────────
# Component framework: each component the installer manages gets a definition
# and helper functions. This enables the CHECK pass (stage 0) to print a plan
# and then act per-component: SKIP (already present and compatible), INSTALL
# (missing), UPDATE (present but older), or ASK (newer than required).
# ──────────────────────────────────────────────────────────────────────────────

# Global hashtables for component metadata
$script:CompNames = @()
$script:CompInstallPath = @{}
$script:CompVersionCmd = @{}
$script:CompRequiredVersion = @{}
$script:CompFetchUrl = @{}
$script:CompChecksumUrl = @{}
$script:CompIsSystem = @{}
$script:CompStageFn = @{}

# Register a component
function Register-Component {
    param(
        [string]$Key,
        [string]$InstallPath,
        [string]$VersionCmd,
        [string]$RequiredVersion,
        [string]$FetchUrl,
        [string]$ChecksumUrl,
        [bool]$IsSystem,
        [string]$StageFn
    )
    $script:CompNames += $Key
    $script:CompInstallPath[$Key] = $InstallPath
    $script:CompVersionCmd[$Key] = $VersionCmd
    $script:CompRequiredVersion[$Key] = $RequiredVersion
    $script:CompFetchUrl[$Key] = $FetchUrl
    $script:CompChecksumUrl[$Key] = $ChecksumUrl
    $script:CompIsSystem[$Key] = $IsSystem
    $script:CompStageFn[$Key] = $StageFn
}

# Get installed version by running the component's version command
function Get-CompInstalledVersion {
    param([string]$Key)
    $versionCmd = $script:CompVersionCmd[$Key]
    $isSystem = $script:CompIsSystem[$Key]

    if ($isSystem) {
        try {
            $output = Invoke-Expression $versionCmd 2>$null | Select-Object -First 1
            if ($output) {
                $output -replace '^[^0-9]*', '' -split '\s+' | Select-Object -First 1
            } else {
                "missing"
            }
        } catch {
            "missing"
        }
    } else {
        $installPath = $script:CompInstallPath[$Key]
        if (Test-Path $installPath) {
            try {
                $output = Invoke-Expression $versionCmd 2>$null | Select-Object -First 1
                if ($output) {
                    $output -replace '^[^0-9]*', '' -split '\s+' | Select-Object -First 1
                } else {
                    "broken"
                }
            } catch {
                "broken"
            }
        } else {
            "missing"
        }
    }
}

# Get required version - either pinned or fetched dynamically (yt-dlp)
function Get-CompRequiredVersion {
    param([string]$Key)
    $requiredVersion = $script:CompRequiredVersion[$Key]
    $fetchUrl = $script:CompFetchUrl[$Key]

    if ($requiredVersion -eq "latest") {
        try {
            $resp = Invoke-WebRequest -Uri $fetchUrl -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
            $json = $resp.Content | ConvertFrom-Json
            if ($json.tag_name) {
                return $json.tag_name
            }
        } catch {
        }
        return "unknown"
    } else {
        return $requiredVersion
    }
}

# Compare two version strings (semantic-ish).
function Compare-CompVersions {
    param([string]$v1, [string]$v2)

    if ($v1 -in @("missing", "broken", "unknown") -or $v2 -in @("missing", "broken", "unknown")) {
        return 3
    }

    $v1 = $v1.TrimStart('v')
    $v2 = $v2.TrimStart('v')

    if ($v1 -eq $v2) { return 0 }

    try {
        $ver1 = [version]$v1
        $ver2 = [version]$v2
        $cmp = [version]::Compare($ver1, $ver2)
        if ($cmp -lt 0) { return 1 }
        if ($cmp -gt 0) { return 2 }
        return 0
    } catch {
        if ($v1 -lt $v2) { return 1 }
        if ($v1 -gt $v2) { return 2 }
        return 3
    }
}

# Decide action for a component: SKIP, INSTALL, UPDATE, ASK, or FAIL
function Decide-CompAction {
    param([string]$Key)
    $isSystem = $script:CompIsSystem[$Key]

    $installed = Get-CompInstalledVersion $Key
    $required = Get-CompRequiredVersion $Key

    if ($isSystem) {
        if ($installed -in @("missing", "broken")) {
            $script:CompAction = "FAIL"
            $script:CompActionReason = "required system tool not found or not working"
        } else {
            $cmp = Compare-CompVersions $installed $required
            if ($cmp -eq 1) {
                $script:CompAction = "FAIL"
                $script:CompActionReason = "version $installed < required $required"
            } else {
                $script:CompAction = "SKIP"
                $script:CompActionReason = "system tool OK (found $installed, need >= $required)"
            }
        }
        return
    }

    switch ($installed) {
        "missing" {
            $script:CompAction = "INSTALL"
            $script:CompActionReason = "not installed"
        }
        "broken" {
            $script:CompAction = "UPDATE"
            $script:CompActionReason = "installed but broken (version probe failed)"
        }
        default {
            if ($required -eq "unknown") {
                $script:CompAction = "SKIP"
                $script:CompActionReason = "installed version $installed - could not check for updates, keeping it"
            } else {
                $cmp = Compare-CompVersions $installed $required
                switch ($cmp) {
                    0 { $script:CompAction = "SKIP"; $script:CompActionReason = "already at required version $required" }
                    1 { $script:CompAction = "UPDATE"; $script:CompActionReason = "installed $installed < required $required" }
                    2 {
                        $script:CompAction = "SKIP"
                        $script:CompActionReason = "installed $installed > required $required (newer kept; yt-dlp/Deno guarantee backward compat)"
                    }
                    default { $script:CompAction = "ASK"; $script:CompActionReason = "cannot compare versions: installed=$installed required=$required" }
                }
            }
        }
    }
}

# Print the plan for all components
function Print-CompPlan {
    Write-Host ""
    Write-Host "━━━ INSTALL PLAN ━━━" -ForegroundColor White
    foreach ($key in $script:CompNames) {
        Decide-CompAction $key
        $installed = Get-CompInstalledVersion $key
        $required = Get-CompRequiredVersion $key

        $actionCol = switch ($script:CompAction) {
            "SKIP"   { "Green" }
            "INSTALL" { "White" }
            "UPDATE" { "White" }
            "ASK"    { "Magenta" }
            "FAIL"   { "Red" }
            default  { "White" }
        }

        Write-Host ("  {0,-7}  {1}  found={2}  required={3}  {4}" -f $script:CompAction, $key, $installed, $required, $script:CompActionReason) -ForegroundColor $actionCol
    }
    Write-Host "━━━━━━━━━━━━━━━━━" -ForegroundColor White
    Write-Host ""
}

# Download and verify a component to a temp file
function Download-CompAndVerify {
    param([string]$Key)
    $fetchUrl = $script:CompFetchUrl[$Key]
    $checksumUrl = $script:CompChecksumUrl[$Key]

    $tmpfile = [IO.Path]::GetTempFileName()
    $tmpfile = $tmpfile.Replace(".tmp", "-$Key")

    try {
        Write-Host ("[{0}] Downloading {1}..." -f (Stamp), $key) -ForegroundColor White
        Invoke-WebRequest -Uri $fetchUrl -OutFile $tmpfile -UseBasicParsing -TimeoutSec 120 -ErrorAction Stop | Out-Null

        if ($checksumUrl -and $checksumUrl -ne "none") {
            Write-Host ("[{0}] Verifying checksum..." -f (Stamp)) -ForegroundColor White
            $resp = Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
            $expectedSha = (Get-WebText $resp) -split '\s+' | Where-Object { $_ -match '^[a-fA-F0-9]{64}$' } | Select-Object -First 1
            if (-not $expectedSha) {
                throw "Could not fetch expected checksum for $Key from $checksumUrl"
            }
            $actualSha = Get-FileHash -Path $tmpfile -Algorithm SHA256 | Select-Object -ExpandProperty Hash
            if ($actualSha -ne $expectedSha) {
                throw "Checksum mismatch for $Key: expected $expectedSha, got $actualSha"
            }
        }

        $versionCmd = $script:CompVersionCmd[$Key]
        $testCmd = $versionCmd -replace '.*\\(yt-dlp|deno|ffmpeg|ffprobe|python)', $tmpfile
        try {
            Invoke-Expression $testCmd 2>$null | Out-Null
        } catch {
            throw "Downloaded $Key fails version probe (may be corrupt or wrong arch)"
        }

        $script:CompTempFile = $tmpfile
    } catch {
        if (Test-Path $tmpfile) { Remove-Item -Force $tmpfile }
        throw $_
    }
}

# Install component atomically from temp file
function Install-CompComponent {
    param([string]$Key)
    $installPath = $script:CompInstallPath[$Key]

    $dir = Split-Path $installPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    $newPath = $installPath + ".new"
    Copy-Item -Force $script:CompTempFile $newPath
    Move-Item -Force $newPath $installPath

    $installed = Get-CompInstalledVersion $Key
    $stampDir = Split-Path $installPath -Parent
    $installed | Set-Content -Path (Join-Path $stampDir ".umd-version-$Key") -Encoding UTF8
}

# Write stamp only for components that changed this run
function Write-CompStampIfChanged {
    param([string]$Key)
    $installPath = $script:CompInstallPath[$Key]
    $stampDir = Split-Path $installPath -Parent
    $installed = Get-CompInstalledVersion $Key
    $installed | Set-Content -Path (Join-Path $stampDir ".umd-version-$Key") -Encoding UTF8
}

# Byte-compare source and destination, copy only if different
function Sync-CompFile {
    param([string]$Src, [string]$Dst)
    if (Test-Path $Dst) {
        $srcHash = Get-FileHash -Path $Src -Algorithm SHA256 | Select-Object -ExpandProperty Hash
        $dstHash = Get-FileHash -Path $Dst -Algorithm SHA256 | Select-Object -ExpandProperty Hash
        if ($srcHash -eq $dstHash) {
            return $false
        }
    }
    $dir = Split-Path $Dst -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -Force $Src $Dst
    return $true
}

# Check if a folder is recognizably ours (has our marker file)
function Test-CompIsOurFolder {
    param([string]$Folder)
    Test-Path (Join-Path $Folder ".umd-rc")
}

# ──────────────────────────────────────────────────────────────────────────────
# Component registrations for Windows
# ──────────────────────────────────────────────────────────────────────────────

# Paths
$Backend = Join-Path $env:LOCALAPPDATA "universal-media-downloader-rc"
$YtDlpBin = Join-Path $Backend "bin\yt-dlp"
$DenoBin = Join-Path $Backend "bin\deno.exe"
$FfmpegBin = Join-Path $Backend "bin\ffmpeg.exe"
$FfprobeBin = Join-Path $Backend "bin\ffprobe.exe"
$BridgeDir = Join-Path $Backend "bridge"
$Src = Split-Path (Split-Path $MyInvocation.MyCommand.Definition -Parent) -Parent
$DeskDir = Join-Path [Environment]::GetFolderPath('Desktop') "ARYZEN Media Downloader"

# System tools (CHECK-ONLY, never installed by us)
Register-Component -Key "python3" `
    -InstallPath (Get-Command python -ErrorAction SilentlyContinue).Source `
    -VersionCmd "python --version 2>&1" `
    -RequiredVersion "3.11" `
    -FetchUrl "" -ChecksumUrl "" `
    -IsSystem $true -StageFn ""

Register-Component -Key "curl" `
    -InstallPath (Get-Command curl -ErrorAction SilentlyContinue).Source `
    -VersionCmd "curl --version 2>&1 | Select-Object -First 1" `
    -RequiredVersion "7.0" `
    -FetchUrl "" -ChecksumUrl "" `
    -IsSystem $true -StageFn ""

# Our managed components
Register-Component -Key "yt-dlp" `
    -InstallPath $YtDlpBin `
    -VersionCmd "`"$YtDlpBin`" --version" `
    -RequiredVersion "latest" `
    -FetchUrl "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest" `
    -ChecksumUrl "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS" `
    -IsSystem $false -StageFn "stage_ytdlp"

Register-Component -Key "deno" `
    -InstallPath $DenoBin `
    -VersionCmd "`"$DenoBin`" --version 2>&1 | Select-Object -First 1" `
    -RequiredVersion "v2.9.8" `
    -FetchUrl "" -ChecksumUrl "" `
    -IsSystem $false -StageFn "stage_deno"

Register-Component -Key "ffmpeg" `
    -InstallPath $FfmpegBin `
    -VersionCmd "`"$FfmpegBin`" -version 2>&1 | Select-Object -First 1" `
    -RequiredVersion "9.0.2" `
    -FetchUrl "" -ChecksumUrl "" `
    -IsSystem $false -StageFn "stage_ffmpeg"

Register-Component -Key "ffprobe" `
    -InstallPath $FfprobeBin `
    -VersionCmd "`"$FfprobeBin`" -version 2>&1 | Select-Object -First 1" `
    -RequiredVersion "9.0.2" `
    -FetchUrl "" -ChecksumUrl "" `
    -IsSystem $false -StageFn "stage_ffmpeg"

Register-Component -Key "bridge-files" `
    -InstallPath (Join-Path $BridgeDir "umd_host.py") `
    -VersionCmd "if (Test-Path (Join-Path `$BridgeDir 'umd_host.py')) { 'present' } else { 'missing' }" `
    -RequiredVersion "present" `
    -FetchUrl "" -ChecksumUrl "" `
    -IsSystem $false -StageFn "stage_helper"

Register-Component -Key "browser-registration" `
    -InstallPath (Join-Path $env:APPDATA "Google\Chrome\NativeMessagingHosts\com.umd.bridge.rc.json") `
    -VersionCmd "if (Test-Path (Join-Path `$env:APPDATA 'Google\Chrome\NativeMessagingHosts\com.umd.bridge.rc.json')) { 'registered' } else { 'missing' }" `
    -RequiredVersion "registered" `
    -FetchUrl "" -ChecksumUrl "" `
    -IsSystem $false -StageFn "stage_register"

Register-Component -Key "extension-folder" `
    -InstallPath $DeskDir `
    -VersionCmd "if (Test-Path (Join-Path `$DeskDir '.umd-rc')) { 'present' } else { 'missing' }" `
    -RequiredVersion "present" `
    -FetchUrl "" -ChecksumUrl "" `
    -IsSystem $false -StageFn "stage_desktop"

# Deno: the JavaScript runtime current yt-dlp needs for YouTube's JS
# challenges (yt-dlp announcement, github.com/yt-dlp/yt-dlp/issues/14404).
# Pinned to a tested release; verified against the release's own published
# .sha256sum below, same trust model as the engine and FFmpeg downloads.
$DenoTag = 'v2.9.8'

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
    $seg = [int][math]::Floor($i * 5 / [math]::Max($n, 1))
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

# Animated banner - shows a gentle gradient sweep across the AMD logo
# Only runs if terminal supports animation; otherwise falls back to static banner
function Animated-Banner {
  if (-not (Test-TerminalAnimationSupport)) { Banner; return }

  try {
    [Console]::CursorVisible = $false
  } catch {}

  # The ASCII art lines
  $artLines = @(
    '    ___    __  _______',
    '   /   |  /  |/  / __ \',
    '  / /| | / /|_/ / / / /',
    ' / ___ |/ /  / / /_/ /',
    '/_/  |_|/_/  /_/_____/'
  )

  # Animation parameters
  $totalFrames = 35
  $frameDelayMs = 40  # ~40ms per frame = ~1.4s total

  for ($frame = 0; $frame -le $totalFrames; $frame++) {
    # Clear the art area by moving cursor up
    if ($frame -gt 0) {
      $linesToMove = $artLines.Count + 3  # +3 for blank + title + byline
      try {
        $currentRow = [Console]::CursorTop
        [Console]::SetCursorPosition(0, $currentRow - $linesToMove)
      } catch {}
    }

    # Calculate progress (0.0 to 1.0)
    $progress = $frame / $totalFrames

    # Render each line with gradient sweep
    foreach ($line in $artLines) {
      $len = $line.Length
      # Sweep position: how many characters should be "lit up"
      $sweepPos = [int]($progress * $len)
      
      # Print line with gradient up to sweepPos, dark gray after
      for ($charIdx = 0; $charIdx -lt $len; $charIdx++) {
        $ch = $line[$charIdx]
        if ($charIdx -lt $sweepPos) {
          # In gradient zone - use position-based color
          $seg = [int][math]::Floor($charIdx * 5 / [math]::Max($len, 1))
          $color = $Grad[$seg]
          Write-Host $ch -NoNewline -ForegroundColor $color
        } else {
          # Not yet reached - dark gray
          Write-Host $ch -NoNewline -ForegroundColor DarkGray
        }
      }
      Write-Host ''
    }

    # Title and byline (static, full color)
    Write-Host 'ARYZEN Media Downloader' -ForegroundColor White
    Write-Host 'created by Aryzen Nex' -ForegroundColor Magenta

    Start-Sleep -Milliseconds $frameDelayMs
  }

  # Show cursor
  try { [Console]::CursorVisible = $true } catch {}
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
$StageTotal = 7
$script:StepN = 0
$script:HistLines = 0
$CounterTop = 0

function Write-At($row, $text, $color) {
  [Console]::SetCursorPosition(0, $row)
  Write-Host ($text.PadRight([math]::Max(10, [Console]::WindowWidth - 1))) -NoNewline -ForegroundColor $color
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
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
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

$stage = Join-Path $env:TEMP ('umd-stage-' + [guid]::NewGuid().ToString('N'))

Animated-Banner
$CounterTop = [Console]::CursorTop
Write-Host "Currently at step 1/$StageTotal" -ForegroundColor White
Write-Host ''

# Stage 0: Print the install plan (what will be SKIP/INSTALL/UPDATE)
function Invoke-Stage-CheckPlan {
    Print-CompPlan
    foreach ($key in $script:CompNames) {
        Decide-CompAction $key
        if ($script:CompAction -eq "FAIL") {
            $installed = Get-CompInstalledVersion $key
            $required = Get-CompRequiredVersion $key
            throw "$key: $($script:CompActionReason) (found=$installed required=$required)"
        }
        if ($script:CompAction -eq "ASK") {
            $installed = Get-CompInstalledVersion $key
            $required = Get-CompRequiredVersion $key
            Write-Host ("[{0}] ! {1}: installed {2} > required {3}. Keep newer (k) or install pinned (i)? " -f (Stamp), $key, $installed, $required) -NoNewline -ForegroundColor Magenta
            $choice = Read-Host
            switch ($choice.ToLower()) {
                "k" { $script:CompAction = "SKIP"; $script:CompActionReason = "user chose to keep newer version $installed" }
                "i" { $script:CompAction = "INSTALL"; $script:CompActionReason = "user chose to install pinned version $required" }
                default { throw "Invalid choice. Run again and choose k or i." }
            }
        }
    }
}

Invoke-Stage 'Checking what''s already installed' { Invoke-Stage-CheckPlan }

Invoke-Stage 'Checking your setup' {
  $py = $null
  foreach ($cand in @('py -3', 'python')) {
    try {
      $v = Invoke-Expression "$cand -c `"import sys; print('%d.%d' % sys.version_info[:2])`"" 2>$null
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
  Decide-CompAction "yt-dlp"
  if ($script:CompAction -eq "SKIP") { $script:Detail = "SKIP: yt-dlp already at required version ($($script:CompActionReason))"; return }
  if ($script:CompAction -ne "INSTALL" -and $script:CompAction -ne "UPDATE") { $script:Detail = "SKIP: yt-dlp ($($script:CompActionReason))"; return }

  try { $rel = Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest' }
  catch { throw 'could not reach GitHub - check your internet connection and run this again.' }
  $tag = $rel.tag_name
  $sums = Get-WebText (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "https://github.com/yt-dlp/yt-dlp/releases/download/$tag/SHA256SUMS")
  $want = @($sums -split "`r?`n" | Where-Object { $_ -match '\syt-dlp$' } | ForEach-Object { ($_ -split '\s+')[0] })[0]
  if (-not $want) { throw 'could not read the official yt-dlp checksum' }
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -OutFile "$stage\yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/download/$tag/yt-dlp"
  $got = (Get-FileHash "$stage\yt-dlp" -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want.ToLower()) { throw 'yt-dlp checksum mismatch - nothing was installed' }
  $script:Detail = "yt-dlp $tag downloaded and SHA-256 verified"
}

Invoke-Stage 'Downloading FFmpeg (latest gyan.dev essentials build)' {
  Decide-CompAction "ffmpeg"
  Decide-CompAction "ffprobe"
  if ($script:CompAction -eq "SKIP") {
    $script:Detail = "SKIP: ffmpeg already at required version ($($script:CompActionReason))"
    Decide-CompAction "ffprobe"
    if ($script:CompAction -eq "SKIP") { $script:Detail += "; ffprobe SKIP" }
    return
  }
  if ($script:CompAction -ne "INSTALL" -and $script:CompAction -ne "UPDATE") { $script:Detail = "SKIP: ffmpeg ($($script:CompActionReason))"; return }

  $ffzip = Join-Path $stage 'umd-ffmpeg.zip'
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -OutFile $ffzip 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  $wantFf = ((Get-WebText (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256')) -split '\s+')[0].Trim()
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

Invoke-Stage 'Downloading the Deno JavaScript runtime (needed for YouTube)' {
  Decide-CompAction "deno"
  if ($script:CompAction -eq "SKIP") { $script:Detail = "SKIP: deno already at required version ($($script:CompActionReason))"; return }
  if ($script:CompAction -ne "INSTALL" -and $script:CompAction -ne "UPDATE") { $script:Detail = "SKIP: deno ($($script:CompActionReason))"; return }

  $darch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
  $durl = "https://github.com/denoland/deno/releases/download/$DenoTag/deno-$darch-pc-windows-msvc.zip"
  $dzip = Join-Path $stage 'umd-deno.zip'
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -OutFile $dzip $durl
  $wantD = [regex]::Match((Get-WebText (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$durl.sha256sum")), '[0-9a-fA-F]{64}').Value
  $gotD = (Get-FileHash $dzip -Algorithm SHA256).Hash.ToLower()
  if (-not $wantD -or $gotD -ne $wantD.ToLower()) {
    Remove-Item $dzip -Force -ErrorAction SilentlyContinue
    throw 'Deno checksum mismatch - nothing was installed'
  }
  Expand-Archive -Force $dzip (Join-Path $stage 'umd-deno')
  $de = Get-ChildItem -Recurse -Filter deno.exe (Join-Path $stage 'umd-deno') | Select-Object -First 1
  if (-not $de) { throw 'could not unpack the Deno runtime - nothing was installed' }
  Remove-Item -Force $dzip -ErrorAction SilentlyContinue
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -OutFile (Join-Path $stage 'deno.LICENSE.txt') "https://raw.githubusercontent.com/denoland/deno/$DenoTag/LICENSE.md"
  if (-not (Select-String -Path (Join-Path $stage 'deno.LICENSE.txt') -Pattern 'MIT License' -Quiet)) { throw 'could not fetch the Deno license text - nothing was installed' }
  $script:DenoExe = $de.FullName
  $script:Detail = "Deno $DenoTag runtime downloaded and verified against the publisher SHA-256"
}

Invoke-Stage 'Installing the local helper' {
  Decide-CompAction "bridge-files"
  if ($script:CompAction -eq "SKIP") { $script:Detail = "SKIP: bridge-files already present ($($script:CompActionReason))" }
  else {
    New-Item -ItemType Directory -Force -Path "$Backend\bridge", "$Backend\bin" | Out-Null
    if (Sync-CompFile "$Src\bridge\umd_host.py" "$Backend\bridge\umd_host.py") { $script:Detail += " updated: umd_host.py" }
    if (Sync-CompFile "$Src\bridge\run-host.bat" "$Backend\bridge\run-host.bat") { $script:Detail += " updated: run-host.bat" }
  }

  Decide-CompAction "yt-dlp"
  if ($script:CompAction -eq "INSTALL" -or $script:CompAction -eq "UPDATE") {
    Copy-Item -Force "$stage\yt-dlp" "$Backend\bin\yt-dlp"
    Write-CompStampIfChanged "yt-dlp"
    $script:Detail += " installed: yt-dlp"
  }

  Decide-CompAction "ffmpeg"
  if ($script:CompAction -eq "INSTALL" -or $script:CompAction -eq "UPDATE") {
    Copy-Item -Force $script:FfExe "$Backend\bin\ffmpeg.exe"
    Copy-Item -Force $script:FpExe "$Backend\bin\ffprobe.exe"
    Write-CompStampIfChanged "ffmpeg"
    Write-CompStampIfChanged "ffprobe"
    $script:Detail += " installed: ffmpeg, ffprobe"
  }

  Decide-CompAction "deno"
  if ($script:CompAction -eq "INSTALL" -or $script:CompAction -eq "UPDATE") {
    Copy-Item -Force $script:DenoExe "$Backend\bin\deno.exe"
    Copy-Item -Force (Join-Path $stage 'deno.LICENSE.txt') "$Backend\bin\deno.LICENSE.txt"
    Write-CompStampIfChanged "deno"
    $script:Detail += " installed: deno"
  }

  if (-not (Test-Path (Join-Path $Backend '.umd-rc'))) {
    New-Item -ItemType File -Force -Path (Join-Path $Backend '.umd-rc') | Out-Null
  }
  $script:Detail = 'helper installed in %LOCALAPPDATA%\universal-media-downloader-rc'
}

Invoke-Stage 'Connecting the helper to your browser(s)' {
  Decide-CompAction "browser-registration"
  if ($script:CompAction -eq "SKIP") { $script:Detail = "SKIP: browser-registration already present ($($script:CompActionReason))"; return }
  if ($script:CompAction -ne "INSTALL" -and $script:CompAction -ne "UPDATE") { $script:Detail = "SKIP: browser-registration ($($script:CompActionReason))"; return }

  $launcher = ($Backend + '\bridge\run-host.bat') -replace '\\', '\\\\'
  $manifest = (Get-Content "$Src\bridge\com.umd.bridge.rc.json" -Raw).Replace('HOST_LAUNCHER_PATH', $launcher)
  [IO.File]::WriteAllText("$Backend\bridge\com.umd.bridge.rc.json", $manifest, (New-Object Text.UTF8Encoding($false)))
  foreach ($key in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.umd.bridge.rc',
                     'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.umd.bridge.rc')) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -PropertyType String -Name '(Default)' -Value "$Backend\bridge\com.umd.bridge.rc.json" -Force | Out-Null
  }
  $script:Detail = 'registered with Chrome and Brave (com.umd.bridge.rc)'
}

Invoke-Stage 'Creating your project folder on the Desktop' {
  Decide-CompAction "extension-folder"
  if ($script:CompAction -eq "SKIP") {
    if (Test-Path $DeskDir -and (Test-CompIsOurFolder $DeskDir)) {
      $script:Detail = "SKIP: extension-folder already present ($($script:CompActionReason))"
      return
    }
  }
  if ($script:CompAction -ne "INSTALL" -and $script:CompAction -ne "UPDATE") { $script:Detail = "SKIP: extension-folder ($($script:CompActionReason))"; return }

  New-Item -ItemType Directory -Force -Path $DeskDir | Out-Null
  $extensionSrc = Join-Path $Src "extension"
  Get-ChildItem $extensionSrc | ForEach-Object {
    $dst = Join-Path $DeskDir $_.Name
    if ($_.PSIsContainer) {
      if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Force -Path $dst | Out-Null }
      Get-ChildItem $_.FullName | ForEach-Object {
        $dstFile = Join-Path $dst $_.Name
        if (Sync-CompFile $_.FullName $dstFile) { $script:Detail += " updated: $($_.Name)" }
      }
    } else {
      if (Sync-CompFile $_.FullName $dst) { $script:Detail += " updated: $($_.Name)" }
    }
  }
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
  if (-not (Test-Path (Join-Path $DeskDir '.umd-rc'))) {
    New-Item -ItemType File -Force -Path (Join-Path $DeskDir '.umd-rc') | Out-Null
  }
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
