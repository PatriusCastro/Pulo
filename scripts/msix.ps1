# Builds an MSIX of the current release exe. Run `npm run exe` first.
#
# Local testing (default): signs with a self-signed "CN=Pulo Dev" certificate. The first run
# (or -Setup) creates it and trusts it machine-wide (one UAC prompt). -Install replaces the
# installed dev package (same version can't be reinstalled) and starts it.
#
# Microsoft Store (-Store): builds an unsigned package for Partner Center, which signs it.
# Copy the three values from Partner Center > your app > Product identity:
#   npm run msix -- -Store -Name "12345Pulo.Pulo" -Publisher "CN=..." -PublisherName "Your name"
param(
  [switch]$Setup, [switch]$Install,
  [switch]$Store, [string]$Name, [string]$Publisher, [string]$PublisherName
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$subject = 'CN=Pulo Dev'
if ($Store -and -not ($Name -and $Publisher -and $PublisherName)) {
  throw '-Store needs -Name, -Publisher and -PublisherName from Partner Center > Product identity.'
}

$sdk = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\10.*\x64\makeappx.exe' |
  Sort-Object FullName -Descending | Select-Object -First 1 | ForEach-Object DirectoryName
if (-not $sdk) { throw 'Windows SDK not found (makeappx.exe). Install the Windows 11 SDK.' }

if (-not $Store) {
  $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object Subject -eq $subject | Select-Object -First 1
  if ($Setup -or -not $cert) {
    if (-not $cert) {
      $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
        -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(2)
    }
    $cer = Join-Path $env:TEMP 'pulo-dev.cer'
    Export-Certificate -Cert $cert -FilePath $cer | Out-Null
    # Windows only installs packages signed by a cert in LocalMachine\TrustedPeople.
    Start-Process powershell -Verb RunAs -Wait -ArgumentList `
      "-NoProfile -Command Import-Certificate -FilePath '$cer' -CertStoreLocation Cert:\LocalMachine\TrustedPeople"
  }
}

$exe = Join-Path $root 'src-pulo\target\release\pulo.exe'
if (-not (Test-Path $exe)) { throw "Build the exe first: npm run exe" }
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version + '.0'

$stage = Join-Path $root 'src-pulo\target\msix'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory (Join-Path $stage 'icons') | Out-Null
Copy-Item $exe $stage
foreach ($icon in 'Square150x150Logo.png', 'Square44x44Logo.png', 'StoreLogo.png') {
  Copy-Item (Join-Path $root "src-pulo\icons\$icon") (Join-Path $stage 'icons')
}
$manifest = (Get-Content (Join-Path $root 'packaging\AppxManifest.xml') -Raw) -replace 'Version="0\.0\.0\.0"', "Version=`"$version`""
if ($Store) {
  $esc = { param($s) [Security.SecurityElement]::Escape($s) }
  $manifest = $manifest.Replace('Name="Pulo.Dev" Publisher="CN=Pulo Dev"', "Name=`"$(& $esc $Name)`" Publisher=`"$(& $esc $Publisher)`"").
    Replace('<PublisherDisplayName>Pulo</PublisherDisplayName>', "<PublisherDisplayName>$(& $esc $PublisherName)</PublisherDisplayName>").
    Replace('Pulo (dev)', 'Pulo')
}
[IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $manifest)

$out = Join-Path $root ('src-pulo\target\' + $(if ($Store) { "Pulo_$($version)_x64.msix" } else { 'pulo-dev.msix' }))
& "$sdk\makeappx.exe" pack /o /d $stage /p $out | Out-Null
if ($LASTEXITCODE) { throw "makeappx failed ($LASTEXITCODE)" }
if ($Store) { Write-Host "Built $out (v$version). Upload it in Partner Center; the Store signs it."; return }
& "$sdk\signtool.exe" sign /fd SHA256 /sha1 $cert.Thumbprint $out | Out-Null
if ($LASTEXITCODE) { throw "signtool failed ($LASTEXITCODE)" }
Write-Host "Built $out (v$version)"

if ($Install) {
  Get-AppxPackage Pulo.Dev | Remove-AppxPackage
  Add-AppxPackage $out
  Start-Process "shell:AppsFolder\$((Get-AppxPackage Pulo.Dev).PackageFamilyName)!Pulo"
  Write-Host 'Installed and started'
}
