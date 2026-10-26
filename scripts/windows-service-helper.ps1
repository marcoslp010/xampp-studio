param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadPath
)

$ErrorActionPreference = 'Stop'
$script:payload = $null

function Write-HelperResult {
  param(
    [bool]$Ok,
    [string]$Message,
    [object]$Data = $null
  )

  if (-not $script:payload -or -not $script:payload.resultPath) { return }
  $result = [ordered]@{
    ok = $Ok
    message = $Message
    data = $Data
    completedAt = [DateTime]::UtcNow.ToString('o')
  }
  $json = $result | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText(
    [string]$script:payload.resultPath,
    $json,
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Get-ControlSddl {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  return "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;CCLCSWRPWPLORC;;;$sid)"
}

function Get-DefaultSddl {
  return "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"
}

function Grant-ServiceControl {
  param(
    [string]$ServiceName,
    [bool]$ResetToDefault = $false
  )
  $sddl = if ($ResetToDefault) { Get-DefaultSddl } else { Get-ControlSddl }
  $grant = Invoke-NativeCapture -Executable 'sc.exe' -Arguments @('sdset', $ServiceName, $sddl)
  if ($grant.ExitCode -ne 0 -or $grant.Text -match 'FAILED|FALHA') {
    throw "O Windows não conseguiu atualizar as permissões do serviço: $($grant.Text)"
  }
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [object[]]$Arguments = @()
  )

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $captured = & $Executable @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{
      ExitCode = $exitCode
      Text = (($captured | Out-String).Trim())
    }
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
}

try {
  $script:payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
  Write-HelperResult -Ok $true -Message 'Helper administrativo iniciado.' -Data @{ phase = 'started' }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdministrator) {
    throw 'O helper não foi iniciado com permissão de administrador.'
  }

  switch ([string]$script:payload.action) {
    'integrate-apache' {
      $executable = [string]$script:payload.executable
      $root = [string]$script:payload.root
      $config = [string]$script:payload.config
      $serviceName = [string]$script:payload.serviceName

      $validation = Invoke-NativeCapture -Executable $executable -Arguments @('-t', '-d', $root, '-f', $config)
      if ($validation.ExitCode -ne 0 -or $validation.Text -notmatch 'Syntax OK') {
        throw "A configuração do Apache não passou na validação: $($validation.Text)"
      }

      $install = Invoke-NativeCapture -Executable $executable -Arguments @('-k', 'install', '-n', $serviceName, '-d', $root, '-f', $config)
      if ($install.ExitCode -ne 0) {
        throw "O httpd.exe não registrou o serviço: $($install.Text)"
      }
      if ($script:payload.startAfterInstall -eq $true) {
        $start = Invoke-NativeCapture -Executable 'sc.exe' -Arguments @('start', $serviceName)
        if ($start.ExitCode -ne 0 -or $start.Text -match 'FAILED|FALHA') {
          throw "O serviço Apache foi registrado, mas não iniciou: $($start.Text)"
        }
      }
      Write-HelperResult -Ok $true -Message 'Apache integrado ao Service Control Manager.' -Data @{ serviceName = $serviceName }
    }

    'integrate-mysql' {
      $executable = [string]$script:payload.executable
      $config = [string]$script:payload.config
      $serviceName = [string]$script:payload.serviceName

      $install = Invoke-NativeCapture -Executable $executable -Arguments @('--install', $serviceName, "--defaults-file=$config")
      if ($install.ExitCode -ne 0) {
        throw "O mysqld.exe não registrou o serviço: $($install.Text)"
      }
      if ($script:payload.startAfterInstall -eq $true) {
        $start = Invoke-NativeCapture -Executable 'sc.exe' -Arguments @('start', $serviceName)
        if ($start.ExitCode -ne 0 -or $start.Text -match 'FAILED|FALHA') {
          throw "O serviço MySQL/MariaDB foi registrado, mas não iniciou: $($start.Text)"
        }
      }
      Write-HelperResult -Ok $true -Message 'MySQL/MariaDB integrado ao Service Control Manager.' -Data @{ serviceName = $serviceName }
    }

    'grant-control' {
      $serviceName = [string]$script:payload.serviceName
      Grant-ServiceControl -ServiceName $serviceName -ResetToDefault:([bool]$script:payload.resetToDefault)
      Write-HelperResult -Ok $true -Message $(if ($script:payload.resetToDefault) { 'Permissões padrão do serviço restauradas.' } else { 'Permissão de iniciar e parar liberada para o usuário atual.' }) -Data @{ serviceName = $serviceName }
    }

    'restart' {
      $serviceName = [string]$script:payload.serviceName
      $stop = Invoke-NativeCapture -Executable 'sc.exe' -Arguments @('stop', $serviceName)
      $alreadyStopped = $stop.Text -match '1062|not been started|n[aã]o foi iniciado|j[aá] est[aá] em execu[cç][aã]o'
      if (($stop.ExitCode -ne 0 -or $stop.Text -match 'FAILED|FALHA') -and -not $alreadyStopped) {
        throw "O Windows não conseguiu parar o serviço ${serviceName}: $($stop.Text)"
      }
      for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $query = Invoke-NativeCapture -Executable 'sc.exe' -Arguments @('query', $serviceName)
        if ($query.Text -match '(?:STATE|ESTADO)\s*:\s*1\b') { break }
        Start-Sleep -Milliseconds 500
      }
      $start = Invoke-NativeCapture -Executable 'sc.exe' -Arguments @('start', $serviceName)
      if ($start.ExitCode -ne 0 -or $start.Text -match 'FAILED|FALHA') {
        throw "O serviço foi parado, mas não reiniciou: $($start.Text)"
      }
      Write-HelperResult -Ok $true -Message 'Serviço reiniciado.' -Data @{ serviceName = $serviceName }
    }

    'sc' {
      $scAction = [string]$script:payload.scAction
      $serviceName = [string]$script:payload.serviceName

      if ($scAction -eq 'config') {
        # O SCM recusa um ImagePath com espaço inicial ("Parâmetro incorreto")
        # e só passa a usar o novo comando se o sc.exe for acionado — por isso
        # binPath= e o valor vão juntos, sem espaço entre os dois.
        $binPath = [string]$script:payload.binPath
        $serviceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName"
        if (-not (Test-Path -LiteralPath $serviceKey)) {
          throw "O serviço ${serviceName} não existe no registro do Windows."
        }
        $configResult = Invoke-NativeCapture -Executable 'sc.exe' -Arguments @('config', $serviceName, "binPath=$binPath")
        $stored = (Get-ItemProperty -LiteralPath $serviceKey -Name 'ImagePath').ImagePath
        if ([string]$stored -ne $binPath) {
          # Reserva: grava direto no registro e força o SCM a reler o serviço.
          Set-ItemProperty -LiteralPath $serviceKey -Name 'ImagePath' -Value $binPath
          Invoke-NativeCapture -Executable 'sc.exe' -Arguments @('config', $serviceName, 'depend=', 'Tcpip/Afd') | Out-Null
          $stored = (Get-ItemProperty -LiteralPath $serviceKey -Name 'ImagePath').ImagePath
        }
        if ([string]$stored -ne $binPath) {
          throw "O Windows gravou um comando inesperado para ${serviceName}: $stored"
        }
        if ($configResult.ExitCode -ne 0 -and -not (Test-Path -LiteralPath $serviceKey)) {
          throw "O Windows recusou a configuração do serviço ${serviceName}: $($configResult.Text)"
        }
        Write-HelperResult -Ok $true -Message "Ação de serviço concluída: $scAction" -Data @{ serviceName = $serviceName; scAction = $scAction }
        exit 0
      }

      $arguments = switch ($scAction) {
        'start' { @('start', $serviceName) }
        'stop' { @('stop', $serviceName) }
        'delete' { @('delete', $serviceName) }
        'start-type' {
          # "demand" (manual), "disabled" ou "auto" (inicialização automática).
          $startType = [string]$script:payload.startType
          if ($startType -notin @('demand', 'disabled', 'auto')) {
            throw "Tipo de inicialização inválido: $startType"
          }
          @('config', $serviceName, 'start=', $startType)
        }
        default { throw "Ação de serviço não suportada: $scAction" }
      }

      $serviceResult = Invoke-NativeCapture -Executable 'sc.exe' -Arguments $arguments
      if ($serviceResult.ExitCode -ne 0 -or $serviceResult.Text -match 'FAILED|FALHA|Access is denied|Acesso negado') {
        throw "O Windows recusou a ação '$scAction' para $serviceName`: $($serviceResult.Text)"
      }
      Write-HelperResult -Ok $true -Message "Ação de serviço concluída: $scAction" -Data @{ serviceName = $serviceName; scAction = $scAction }
    }

    default { throw "Ação desconhecida: $($script:payload.action)" }
  }

  exit 0
}
catch {
  $message = $_.Exception.Message
  Write-HelperResult -Ok $false -Message $message -Data @{ exception = $_.Exception.ToString() }
  [Console]::Error.WriteLine($message)
  exit 1
}
