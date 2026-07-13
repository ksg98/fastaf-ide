$ErrorActionPreference = "Stop"

$repo = "sstraus/tuicommander"
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"

Write-Host "Fetching latest fastestAF release..." -ForegroundColor Cyan

$release = Invoke-RestMethod -Uri $apiUrl
$asset = $release.assets | Where-Object { $_.name -like '*x64-setup.exe' } | Select-Object -First 1

if (-not $asset) {
    Write-Host "Error: Windows installer not found in latest release" -ForegroundColor Red
    exit 1
}

$version = $release.tag_name
$outFile = Join-Path $env:TEMP "fastestAF-setup.exe"

Write-Host "Downloading fastestAF $version..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $outFile

Write-Host "Running installer..." -ForegroundColor Cyan
Start-Process -FilePath $outFile -Wait

Write-Host "fastestAF $version installed successfully!" -ForegroundColor Green
