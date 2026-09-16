# NSEB installer for Windows.
# Usage: irm https://raw.githubusercontent.com/tmih06/NSEB/main/scripts/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Repo    = 'tmih06/NSEB'
$ApiUrl  = "https://api.github.com/repos/$Repo/releases/latest"
$AppName = 'NSEB'
$InstallDir = Join-Path $env:LOCALAPPDATA $AppName

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# Find the .exe asset in the latest release.
$release = Invoke-RestMethod -Uri $ApiUrl -Headers @{ 'User-Agent' = 'NSEB-Installer' }
$asset = $release.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1
if (-not $asset) { Write-Error 'No .exe asset found in the latest release.'; exit 1 }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$exePath = Join-Path $InstallDir "$AppName.exe"

Info "Downloading $($asset.name)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exePath -UseBasicParsing

# Desktop shortcut.
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "$AppName.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Description = 'Safe Exam Browser'
$shortcut.Save()

Info "Installed to $exePath"
Info "Desktop shortcut created: $shortcutPath"
