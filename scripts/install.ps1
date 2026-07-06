# هذا السكربت يحمل النسخة الجاهزة من GitHub Releases
$ErrorActionPreference = 'Stop'
Write-Host "Downloading Bowow..." -ForegroundColor Cyan

# ملاحظة: هذا الرابط سيعمل بعد أن ترفع أول Release لمشروعك
$url = "https://github.com/YASSER-27/Bowow/releases/latest/download/Bowow-Setup.exe"
$dest = "$env:TEMP\Bowow-Setup.exe"

Invoke-WebRequest -Uri $url -OutFile $dest
Start-Process -FilePath $dest -Wait
Write-Host "Installation Finished!" -ForegroundColor Green
