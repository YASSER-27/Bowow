$ErrorActionPreference = 'Stop'

# فرض TLS 1.2 - ضروري باش يخدم Invoke-WebRequest مع GitHub
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolTypes]::Tls12

Write-Host "Downloading Bowow..." -ForegroundColor Cyan

$url = "https://github.com/YASSER-27/Bowow/releases/latest/download/Bowow.Setup.1.5.1.exe"
$dest = "$env:TEMP\Bowow-Setup.exe"

Invoke-WebRequest -Uri $url -OutFile $dest
Start-Process -FilePath $dest -Wait
Write-Host "Installation Finished!" -ForegroundColor Green
