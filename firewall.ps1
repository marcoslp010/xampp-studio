param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('preview', 'block', 'unblock', 'enable', 'disable')]
  [string]$Mode,
  [string]$Ip,
  [string]$RuleName,
  [string]$RangesBase64,
  [string]$DisabledRulesBase64
)

$ErrorActionPreference = 'Stop'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Result($Value) {
  ConvertTo-Json -InputObject $Value -Compress -Depth 8
}

function Get-CloudflarePreview {
  $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object {
    [pscustomobject]@{ Name = [string]$_.Name; DefaultInboundAction = [string]$_.DefaultInboundAction; Enabled = [bool]$_.Enabled }
  })
  $blockers = @()
  foreach ($profile in $profiles) {
    if (-not $profile.Enabled) { $blockers += "O perfil $($profile.Name) do Firewall está desativado." }
    if ($profile.DefaultInboundAction -ne 'Block') { $blockers += "O perfil $($profile.Name) não bloqueia conexões de entrada por padrão." }
  }

  $safeRules = @()
  $persistentNames = @{}
  foreach ($localRule in @(Get-NetFirewallRule -PolicyStore PersistentStore -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue)) { $persistentNames[[string]$localRule.Name] = $true }
  $allowRules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue)
  foreach ($rule in $allowRules) {
    if ([string]$rule.Name -like 'XAMPPStudio_Cloudflare_*') { continue }
    $portFilters = @($rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue)
    if (-not $portFilters.Count) { continue }
    foreach ($filter in $portFilters) {
      $local = @($filter.LocalPort | ForEach-Object { ([string]$_ -split ',') }) | Where-Object { $_ }
      if (-not $local.Count) { continue }
      $touchesWeb = $false
      $isExactWebOnly = $true
      foreach ($port in $local) {
        $value = ([string]$port).Trim().ToLowerInvariant()
        if ($value -in @('80', '443')) { $touchesWeb = $true; continue }
        if ($value -match '^\d+-\d+$') {
          $pair = $value -split '-'
          if ([int]$pair[0] -le 443 -and [int]$pair[1] -ge 80) { $touchesWeb = $true }
        }
        if ($value -eq 'any' -or $value -match 'http|https|^\d+-\d+$') { $touchesWeb = $true }
        $isExactWebOnly = $false
      }
      if (-not $touchesWeb) { continue }
      $protocol = [string]$filter.Protocol
      if ($protocol -notin @('TCP', '6', 'Any', '256')) { continue }
      $tcpRule = $protocol -in @('TCP', '6')
      if ($isExactWebOnly -and $tcpRule -and $persistentNames.ContainsKey([string]$rule.Name)) {
        if (-not ($safeRules | Where-Object { $_.Name -eq $rule.Name })) {
          $safeRules += [pscustomobject]@{ Name = [string]$rule.Name; DisplayName = [string]$rule.DisplayName }
        }
      } else {
        $blockers += "A regra '$($rule.DisplayName)' pode liberar HTTP/HTTPS e não pode ser desativada com segurança; revise-a manualmente."
      }
    }
  }
  $blockRules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Direction Inbound -Enabled True -Action Block -ErrorAction SilentlyContinue)
  foreach ($rule in $blockRules) {
    $portFilters = @($rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue)
    foreach ($filter in $portFilters) {
      $protocol = [string]$filter.Protocol
      if ($protocol -notin @('TCP', '6', 'Any', '256')) { continue }
      $local = @($filter.LocalPort | ForEach-Object { ([string]$_ -split ',') }) | Where-Object { $_ }
      $touchesWeb = $false
      foreach ($port in $local) {
        $value = ([string]$port).Trim().ToLowerInvariant()
        if ($value -in @('any', '80', '443', 'http', 'https')) { $touchesWeb = $true; break }
        if ($value -match '^\d+-\d+$') { $pair = $value -split '-'; if ([int]$pair[0] -le 443 -and [int]$pair[1] -ge 80) { $touchesWeb = $true; break } }
      }
      if ($touchesWeb) { $blockers += "A regra de bloqueio '$($rule.DisplayName)' também pode impedir conexões da Cloudflare."; break }
    }
  }
  return [pscustomobject]@{
    safeToApply = ($blockers.Count -eq 0)
    profiles = $profiles
    blockers = @($blockers | Select-Object -Unique)
    rulesToDisable = $safeRules
    explanation = 'A restrição só pode ser ativada com perfis ligados, bloqueio de entrada por padrão e sem regras amplas que liberem as portas 80/443.'
  }
}

switch ($Mode) {
  'preview' {
    Write-Result (Get-CloudflarePreview)
  }
  'block' {
    if (-not (Test-Administrator)) { throw 'Acesso negado: inicie o XAMPP Studio como administrador.' }
    if (-not $Ip -or -not $RuleName -or $RuleName -notmatch '^XAMPPStudio_Block_[a-f0-9]{20}$') { throw 'Endereço ou identificação de regra inválidos.' }
    $parsedAddress = $null
    if (-not [System.Net.IPAddress]::TryParse($Ip, [ref]$parsedAddress)) { throw 'Endereço IP inválido.' }
    New-NetFirewallRule -Name $RuleName -DisplayName "XAMPP Studio - bloquear $Ip" -Direction Inbound -RemoteAddress $Ip -Protocol Any -Action Block -Profile Any -Enabled True | Out-Null
    Write-Result @{ success = $true; ip = $Ip }
  }
  'unblock' {
    if (-not (Test-Administrator)) { throw 'Acesso negado: inicie o XAMPP Studio como administrador.' }
    if (-not $RuleName -or $RuleName -notmatch '^XAMPPStudio_Block_[a-f0-9]{20}$') { throw 'Identificação de regra inválida.' }
    Get-NetFirewallRule -PolicyStore PersistentStore -Name $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Result @{ success = $true }
  }
  'enable' {
    if (-not (Test-Administrator)) { throw 'Acesso negado: inicie o XAMPP Studio como administrador.' }
    $preview = Get-CloudflarePreview
    if (-not $preview.safeToApply) { throw ('Prévia bloqueada: ' + ($preview.blockers -join ' ')) }
    $ranges = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RangesBase64)) | ConvertFrom-Json)
    if ($ranges.Count -lt 2 -or ($ranges | Where-Object { $_ -notmatch '^[0-9a-fA-F:.]+/\d{1,3}$' }).Count) { throw 'Lista de faixas Cloudflare inválida.' }
    $rangeText = [string]::Join("`n", [string[]]$ranges)
    $sha = [Security.Cryptography.SHA256]::Create()
    $suffix = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($rangeText))).Replace('-', '').Substring(0, 12)).ToLowerInvariant()
    $sha.Dispose()
    $disabled = @()
    $created = @()
    try {
      foreach ($rule in $preview.rulesToDisable) {
        Disable-NetFirewallRule -PolicyStore PersistentStore -Name $rule.Name | Out-Null
        $disabled += $rule
      }
      foreach ($family in @(@{ name = 'v4'; ranges = @($ranges | Where-Object { $_ -match '\.' }) }, @{ name = 'v6'; ranges = @($ranges | Where-Object { $_ -match ':' }) })) {
        if (-not $family.ranges.Count) { throw "Faixas Cloudflare $($family.name) ausentes." }
        foreach ($port in @(80, 443)) {
          $name = "XAMPPStudio_Cloudflare_$($family.name)_$($port)_$suffix"
          New-NetFirewallRule -Name $name -DisplayName "XAMPP Studio - Cloudflare $($family.name) porta $port" -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress $family.ranges -Action Allow -Profile Any -Enabled True | Out-Null
          $created += $name
        }
      }
      $oldRules = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'XAMPPStudio_Cloudflare_*' -and $_.Name -notin $created })
      if ($oldRules.Count) { $oldRules | Remove-NetFirewallRule -ErrorAction Stop }
      Write-Result @{ success = $true; createdRules = $created; disabledRules = $disabled }
    } catch {
      foreach ($name in $created) { Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue }
      foreach ($rule in $disabled) { Enable-NetFirewallRule -PolicyStore PersistentStore -Name $rule.Name -ErrorAction SilentlyContinue | Out-Null }
      throw
    }
  }
  'disable' {
    if (-not (Test-Administrator)) { throw 'Acesso negado: inicie o XAMPP Studio como administrador.' }
    Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'XAMPPStudio_Cloudflare_*' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    $disabled = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($DisabledRulesBase64)) | ConvertFrom-Json)
    foreach ($rule in $disabled) {
      if ($rule.Name -match '^[a-zA-Z0-9{}_-]{1,200}$') { Enable-NetFirewallRule -PolicyStore PersistentStore -Name $rule.Name -ErrorAction SilentlyContinue | Out-Null }
    }
    Write-Result @{ success = $true; restoredRules = $disabled.Count }
  }
}
