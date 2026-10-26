# Exercise the actual port-cleanup block with process APIs replaced by stubs.
$ErrorActionPreference = 'Stop'
$serverPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'server.cjs'
$source = Get-Content (Join-Path (Split-Path $PSScriptRoot -Parent) 'start.ps1') -Raw
$begin = $source.IndexOf('$studioPort =')
$end = $source.IndexOf('Write-Host "Iniciando')
if ($begin -lt 0 -or $end -le $begin) { throw 'Startup block not found.' }
$block = [scriptblock]::Create($source.Substring($begin, $end - $begin))

function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) $script:observedPort = $LocalPort; [pscustomobject]@{ OwningProcess = 42424 } }
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) $script:fixture }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) $script:stops++ }
function Start-Sleep { param($Seconds) }

$previousPort = $env:XAMPP_STUDIO_PORT
try {
  $env:XAMPP_STUDIO_PORT = '43207'
  foreach ($scenario in @(
    @{ Name = 'unrelated executable'; Process = 'other.exe'; Command = 'other.exe'; Allowed = $false },
    @{ Name = 'another Node project'; Process = 'node.exe'; Command = 'node.exe C:\other\server.cjs'; Allowed = $false },
    @{ Name = 'missing process metadata'; Process = 'node.exe'; Command = $null; Allowed = $false },
    @{ Name = 'exact Studio script'; Process = 'node.exe'; Command = ('node.exe "' + $serverPath + '"'); Allowed = $true }
  )) {
    $script:stops = 0
    $script:fixture = [pscustomobject]@{ Name = $scenario.Process; CommandLine = $scenario.Command }
    $failed = $false
    try { & $block } catch { $failed = $true }
    if ($scenario.Allowed) {
      if ($failed -or $script:stops -ne 1) { throw "Expected Studio restart: $($scenario.Name)" }
    } elseif (-not $failed -or $script:stops -ne 0) { throw "Unexpected process termination: $($scenario.Name)" }
    if ($script:observedPort -ne 43207) { throw 'Configured port was ignored.' }
    Write-Output "PASS: $($scenario.Name)"
  }
} finally { $env:XAMPP_STUDIO_PORT = $previousPort }
