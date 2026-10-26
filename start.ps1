param([switch]$AsAdmin)

$ErrorActionPreference = 'Stop'

if ($AsAdmin) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $adminRole = [Security.Principal.WindowsBuiltInRole]::Administrator
  if (-not $principal.IsInRole($adminRole)) {
    $powershellPath = (Get-Process -Id $PID).Path
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -AsAdmin'
    Start-Process -FilePath $powershellPath -ArgumentList $arguments -Verb RunAs
    exit
  }
}

$serverPath = Join-Path $PSScriptRoot 'server.cjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js nao foi encontrado. Instale Node.js 20 ou mais recente para iniciar o XAMPP Studio.'
}

# Só substitui uma instância comprovada deste projeto. Uma porta ocupada
# por outro programa nunca autoriza encerrar esse processo.
$studioPort = if ($env:XAMPP_STUDIO_PORT) { [int]$env:XAMPP_STUDIO_PORT } else { 43197 }
$listeners = @(Get-NetTCPConnection -LocalPort $studioPort -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  $oldPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($oldPid in $oldPids) {
    if ($oldPid -eq $PID) { continue }
    $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction Stop
    $expectedScript = [regex]::Escape([IO.Path]::GetFullPath($serverPath))
    if ($oldProcess.Name -ne 'node.exe' -or $oldProcess.CommandLine -notmatch ('(?i)(?:"|\s)' + $expectedScript + '(?:"|\s|$)')) {
      throw "A porta $studioPort pertence a outro processo (PID $oldPid). Nenhum processo foi encerrado."
    }
    try {
      Stop-Process -Id $oldPid -Force -ErrorAction Stop
      Write-Host "Instancia anterior encerrada (PID $oldPid)." -ForegroundColor DarkGray
    } catch {
      throw "Nao foi possivel encerrar a instancia anterior (PID $oldPid): $($_.Exception.Message)"
    }
  }
  Start-Sleep -Seconds 2
}

Write-Host "Iniciando o XAMPP Studio em http://127.0.0.1:$studioPort" -ForegroundColor Green
Write-Host 'O servidor le o XAMPP local e grava backups nesta pasta.' -ForegroundColor DarkGray
if ($AsAdmin) { Write-Host 'Modo administrador ativo para controlar servicos e Firewall do Windows.' -ForegroundColor Yellow }
Write-Host 'Abra o endereco acima no navegador. Pressione Ctrl+C para encerrar.' -ForegroundColor DarkGray
node $serverPath
