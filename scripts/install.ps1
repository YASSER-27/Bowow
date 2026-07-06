$ErrorActionPreference = 'Stop'
Write-Host "Checking for the latest Bowow release..." -ForegroundColor Cyan

$repo = "YASSER-27/Bowow"
$latestRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest"
$asset = $latestRelease.assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1

if (-not $asset) {
    Write-Error "Could not find any .exe installer in the latest release!"
    exit 1
}

$url = $asset.browser_download_url
$dest = Join-Path $env:TEMP $asset.name

Write-Host "Downloading $($asset.name) from GitHub..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $dest

Write-Host "Launching installer, please complete the setup..." -ForegroundColor Cyan
Start-Process -FilePath $dest -Wait

Write-Host "Bowow installation finished successfully!" -ForegroundColor Green