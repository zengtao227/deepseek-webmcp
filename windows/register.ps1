# Registers DeepSeek WebMCP (installed inside WSL) with Chrome and Edge on Windows.
# Run by the WebMCP Setup after install.sh succeeded inside WSL. Windows PowerShell 5.1.
param(
  [Parameter(Mandatory = $true)][string]$Distro,
  [Parameter(Mandatory = $true)][string]$AdapterPath,
  [Parameter(Mandatory = $true)][string]$Launcher,
  [Parameter(Mandatory = $true)][string]$ExtensionId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'The extension id is invalid.' }
$HostName = 'com.deepseek.webmcp.native'
$App = Join-Path $env:LOCALAPPDATA 'WebMCP\DeepSeek'
New-Item -ItemType Directory -Force -Path $App | Out-Null

# The relay is compiled on this computer from the source shipped in the release.
$source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'native-host-relay.cs')
$source = $source.Replace('__DEEPSEEK_WEBMCP_DISTRO__', $Distro.Replace('\', '\\').Replace('"', '\"'))
$source = $source.Replace('__DEEPSEEK_WEBMCP_LAUNCHER__', $Launcher.Replace('\', '\\').Replace('"', '\"'))
$relay = Join-Path $App 'deepseek-webmcp-host.exe'
if (Test-Path -LiteralPath $relay) { Remove-Item -LiteralPath $relay -Force }
Add-Type -TypeDefinition $source -OutputAssembly $relay -OutputType ConsoleApplication

# Browsers load the extension from a Windows folder; the WSL copy stays the source.
$extension = Join-Path $App 'extension'
if (Test-Path -LiteralPath $extension) { Remove-Item -LiteralPath $extension -Recurse -Force }
$wslExtension = "\\wsl.localhost\$Distro" + ($AdapterPath.TrimEnd('/') + '/extension').Replace('/', '\')
Copy-Item -LiteralPath $wslExtension -Destination $extension -Recurse

$manifest = Join-Path $App "$HostName.json"
$json = @{
  name = $HostName
  description = 'DeepSeek WebMCP isolated local runtime'
  path = $relay
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
# Written without a byte-order mark, which the browser's manifest parser does not accept.
[System.IO.File]::WriteAllText($manifest, $json, (New-Object System.Text.UTF8Encoding $false))

foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\$HostName"
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifest
}

Write-Output "EXTENSION_FOLDER $extension"
