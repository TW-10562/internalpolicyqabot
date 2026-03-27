$ErrorActionPreference = 'Stop'

$HostName = 'policybot.twave.co.jp'
$ServerIp = '172.30.140.148'
$BootstrapBase = "http://$ServerIp/bootstrap"
$CaPath = Join-Path $env:TEMP 'hrbot-root-ca.crt'
$HostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$HostsLine = "$ServerIp $HostName"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this PowerShell script as Administrator.'
}

Invoke-WebRequest -Uri "$BootstrapBase/hrbot-root-ca.crt" -OutFile $CaPath

if (-not (Select-String -Path $HostsPath -Pattern "^\s*172\.30\.140\.148\s+policybot\.twave\.co\.jp(\s|$)" -Quiet -ErrorAction SilentlyContinue)) {
  Add-Content -Path $HostsPath -Value "`r`n$HostsLine"
}

Import-Certificate -FilePath $CaPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
ipconfig /flushdns | Out-Null

Write-Host "Open: https://$HostName"
