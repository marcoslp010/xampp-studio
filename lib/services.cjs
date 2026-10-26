'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const { escapeRegExp } = require('./php-compat.cjs');
const { apachePrimaryPort } = require('./apache-config.cjs');
const { normalizeServiceCommand } = require('./service-command.cjs');
const {
  APP_ROOT,
  activeApacheRuntime,
  activeMySqlRuntime,
  readText,
  serviceNameFor,
  writeAtomically
} = require('./runtime-state.cjs');

/**
 * Controle dos serviços do Windows e das portas usadas pelo XAMPP Studio.
 *
 * Decisão de arquitetura: este módulo é autocontido e usa o mesmo
 * promisify(execFile) e o mesmo helper administrativo que já eram usados no
 * servidor. Assim, repairXamppService e as demais funções não dependem do
 * servidor HTTP, não existe require circular e o comportamento não precisa
 * ser reescrito. Importar este arquivo não inicia servidor nem altera serviço.
 */

const execFileAsync = promisify(execFile);
const WINDOWS_SERVICE_HELPER = path.join(APP_ROOT, 'scripts', 'windows-service-helper.ps1');
const SERVICE_HELPER_DIR = path.join(APP_ROOT, 'jobs', 'service-helper');

let windowsAdministratorPromise = null;
let windowsUserSidPromise = null;

function checkPort(port, host = '127.0.0.1', timeout = 350) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = value => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function portListeners(port) {
  if (process.platform !== 'win32') return [];
  const command = `$items=Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue; [pscustomobject]@{ pid=$_.OwningProcess; name=$process.Name; executable=$process.ExecutablePath; commandLine=$process.CommandLine } }; @($items) | ConvertTo-Json -Compress`;
  try {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { timeout: 12000, windowsHide: true, maxBuffer: 64 * 1024 });
    const parsed = JSON.parse((result.stdout || '').trim() || '[]');
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const unique = new Map();
    for (const item of items) {
      if (!item?.pid || unique.has(item.pid)) continue;
      unique.set(item.pid, {
        pid: Number(item.pid),
        name: item.name || null,
        executable: item.executable || null,
        commandLine: item.commandLine || null
      });
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

async function portOwnership(port, component) {
  const listeners = await portListeners(port);
  const runtime = component === 'apache' ? activeApacheRuntime() : activeMySqlRuntime();
  const expected = path.resolve(runtime.executable).toLowerCase();
  const managed = listeners.some(listener => listener.executable && path.resolve(listener.executable).toLowerCase() === expected);
  return {
    active: listeners.length > 0,
    managed,
    listeners,
    summary: listeners.map(listener => listener.name || `PID ${listener.pid}`).join(', ') || null
  };
}

function serviceExecutableFromCommand(command) {
  const value = String(command || '').trim();
  const match = value.match(/^\s*"([^"]+\.exe)"|^\s*(.+?\.exe)(?:\s|$)/i);
  return match ? path.resolve(match[1] || match[2]) : null;
}

function serviceStateCode(output) {
  return Number(output.match(/^\s*(?:STATE|ESTADO)\s*:\s*(\d+)/im)?.[1] || 0) || null;
}

function serviceCommandFromOutput(output) {
  const line = String(output || '').split(/\r?\n/).find(item => /^\s*[^:\r\n]*BIN[^:\r\n]*:\s*\S/i.test(item));
  const separator = line ? line.indexOf(':') : -1;
  return separator >= 0 ? line.slice(separator + 1).trim() : null;
}

async function buildStandaloneModeState(previous) {
  const [apacheService, mysqlService] = await Promise.all([
    inspectXamppService('apache'),
    inspectXamppService('mysql')
  ]);
  return {
    ...previous,
    mode: 'standalone',
    apacheServiceName: apacheService.managed ? apacheService.serviceName : 'XAMPPStudio-Apache',
    mysqlServiceName: mysqlService.managed ? mysqlService.serviceName : 'XAMPPStudio-MySQL'
  };
}

function serviceDefinitions(component) {
  const apache = activeApacheRuntime();
  const mysql = activeMySqlRuntime();
  if (component === 'apache') {
    return {
      label: 'Apache',
      serviceName: serviceNameFor('apache'),
      executable: apache.executable,
      config: apache.config,
      root: apache.root,
      version: apache.version,
      source: apache.source
    };
  }
  if (component === 'mysql') {
    return {
      label: mysql.product === 'mariadb' ? 'MariaDB' : 'MySQL/MariaDB',
      serviceName: serviceNameFor('mysql'),
      executable: mysql.executable,
      config: mysql.config,
      root: mysql.root,
      version: mysql.version,
      product: mysql.product,
      source: mysql.source
    };
  }
  throw new Error('Componente de serviço inválido.');
}

async function isWindowsAdministrator() {
  if (process.platform !== 'win32') return false;
  if (!windowsAdministratorPromise) {
    windowsAdministratorPromise = execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "$identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=[Security.Principal.WindowsPrincipal]::new($identity); Write-Output $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
    ], { timeout: 8000, windowsHide: true, maxBuffer: 4096 })
      .then(result => /true/i.test(`${result.stdout || ''} ${result.stderr || ''}`))
      .catch(() => false);
  }
  return windowsAdministratorPromise;
}

async function currentWindowsUserSid() {
  if (process.platform !== 'win32') return null;
  if (!windowsUserSidPromise) {
    windowsUserSidPromise = execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { timeout: 5000, windowsHide: true, maxBuffer: 4096 })
      .then(result => (result.stdout || '').match(/S-1-\d+(?:-\d+)+/)?.[0] || null)
      .catch(() => null);
  }
  return windowsUserSidPromise;
}

async function serviceControlGranted(serviceName) {
  const sid = await currentWindowsUserSid();
  if (!sid) return false;
  try {
    const result = await execFileAsync('sc.exe', ['sdshow', serviceName], { timeout: 5000, windowsHide: true, maxBuffer: 8192 });
    return new RegExp(`;${escapeRegExp(sid)}\\)`, 'i').test(result.stdout || '');
  } catch {
    return false;
  }
}

function serviceHelperErrorDetails(error) {
  return `${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`.trim();
}

async function runWindowsServiceHelper(action, payload = {}) {
  if (process.platform !== 'win32') throw new Error('O controle de serviço exige Windows.');
  if (!fs.existsSync(WINDOWS_SERVICE_HELPER)) throw new Error('O helper de serviços do Windows não foi encontrado. Reinicie o XAMPP Studio após atualizar os arquivos.');

  fs.mkdirSync(SERVICE_HELPER_DIR, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const payloadPath = path.join(SERVICE_HELPER_DIR, `${token}.payload.json`);
  const resultPath = path.join(SERVICE_HELPER_DIR, `${token}.result.json`);
  const outputPath = path.join(SERVICE_HELPER_DIR, `${token}.stdout.log`);
  const errorPath = path.join(SERVICE_HELPER_DIR, `${token}.stderr.log`);
  const elevated = !(await isWindowsAdministrator());
  const request = { action, ...payload, resultPath };

  try {
    writeAtomically(payloadPath, JSON.stringify(request, null, 2));
    let executionError = null;
    if (elevated) {
      const powerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const helperCommand = `& '${WINDOWS_SERVICE_HELPER.replace(/'/g, "''")}' -PayloadPath '${payloadPath.replace(/'/g, "''")}' *> '${outputPath.replace(/'/g, "''")}'`;
      const encodedCommand = Buffer.from(helperCommand, 'utf16le').toString('base64');
      const launcher = `$process = Start-Process -FilePath '${powerShell.replace(/'/g, "''")}' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encodedCommand}') -Verb RunAs -Wait -PassThru; if(-not $process){exit 1}; exit $process.ExitCode`;
      try {
        await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher], {
          timeout: 180000,
          windowsHide: true,
          maxBuffer: 32 * 1024
        });
      } catch (error) {
        const details = serviceHelperErrorDetails(error);
        if (/1223|cancel(?:ed|ado|amento)|cancelar/i.test(details)) {
          throw new Error('A solicitação de administrador foi cancelada. Clique em Integrar novamente e aceite o aviso do Windows para concluir.');
        }
        executionError = error;
      }
    } else {
      try {
        await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_SERVICE_HELPER, '-PayloadPath', payloadPath], {
          timeout: 180000,
          windowsHide: true,
          maxBuffer: 32 * 1024
        });
      } catch (error) {
        executionError = error;
      }
    }

    let result = null;
    try { result = JSON.parse(readText(resultPath)); } catch {}
    if (result?.ok && result.message === 'Helper administrativo iniciado.') result = null;
    if (result) {
      if (!result.ok) throw new Error(result.message || 'A operação administrativa do Windows falhou.');
      return { ...result.data, elevated, completedAt: result.completedAt };
    }
    if (executionError) {
      const details = serviceHelperErrorDetails(executionError);
      const helperOutput = `${readText(outputPath)}\n${readText(errorPath)}`.trim();
      throw new Error(`O Windows não conseguiu executar a operação de serviço: ${(details || helperOutput).slice(0, 480)}`);
    }
    const helperOutput = `${readText(outputPath)}\n${readText(errorPath)}`.trim();
    throw new Error(`O helper administrativo não retornou um resultado verificável.${helperOutput ? ` Saída: ${helperOutput.slice(0, 320)}` : ''}`);
  } finally {
    fs.rmSync(payloadPath, { force: true });
    fs.rmSync(resultPath, { force: true });
    fs.rmSync(outputPath, { force: true });
    fs.rmSync(errorPath, { force: true });
  }
}

/**
 * Altera o tipo de inicialização de um serviço do Windows.
 *
 * Usado para desativar a inicialização automática dos serviços legados do
 * XAMPP (Apache2.4 e mysql) depois que o Studio passa a usar os próprios
 * (XAMPPStudio-Apache e XAMPPStudio-MySQL). Sem isso, os dois conjuntos
 * disputariam as mesmas portas a cada boot.
 */
async function setServiceStartType(serviceName, startType = 'demand') {
  if (process.platform !== 'win32') throw new Error('O controle de serviço exige Windows.');
  const type = ['demand', 'disabled', 'auto'].includes(startType) ? startType : 'demand';
  const result = await runWindowsServiceHelper('sc', { scAction: 'start-type', serviceName, startType: type });
  return { serviceName, startType: type, changed: true, elevated: Boolean(result?.elevated) };
}

/**
 * Aguarda o serviço alcançar um estado do Windows (1 = parado, 4 = rodando).
 *
 * O SCM ainda responde "START_PENDING"/"STOP_PENDING" durante a transição e
 * recusa um novo comando — iniciar logo após parar faz o serviço falhar.
 */
async function waitForWindowsServiceState(serviceName, expectedState, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    try {
      const result = await execFileAsync('sc.exe', ['query', serviceName], { timeout: 6000, windowsHide: true, maxBuffer: 8192 });
      state = serviceStateCode(result.stdout);
      if (state === expectedState) return state;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`O serviço ${serviceName} não atingiu o estado ${expectedState} no Windows (estado ${state ?? 'desconhecido'}).`);
}

/**
 * Inicia o serviço com novas tentativas.
 *
 * Logo depois de uma parada, o SCM ainda pode recusar o início ("o serviço
 * não está pronto para aceitar comandos"). Repetir few segundos depois
 * resolve sem intervenção do usuário.
 */
async function startWindowsServiceWithRetry(serviceName, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await execFileAsync('sc.exe', ['start', serviceName], { timeout: 15000, windowsHide: true, maxBuffer: 8192 });
    } catch (error) {
      lastError = error;
      const details = `${error.stdout || ''} ${error.stderr || ''} ${error.message || ''}`;
      if (/access is denied|acesso negado|error 5|openservice failed 5/i.test(details)) throw error;
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
  }
  throw lastError;
}

async function restartWindowsService(serviceName) {
  try {
    await execFileAsync('sc.exe', ['stop', serviceName], { timeout: 10000, windowsHide: true, maxBuffer: 8192 });
    await waitForWindowsServiceState(serviceName, 1, 30000);
    return await startWindowsServiceWithRetry(serviceName);
  } catch (error) {
    const details = `${error.stdout || ''} ${error.stderr || ''} ${error.message || ''}`.trim();
    if (/access is denied|acesso negado|error 5|openservice failed 5/i.test(details)) {
      return runWindowsServiceHelper('restart', { serviceName });
    }
    throw new Error(details.slice(0, 320) || `O Windows não conseguiu reiniciar o serviço ${serviceName}.`);
  }
}

async function inspectXamppService(component) {
  const definition = serviceDefinitions(component);
  if (process.platform !== 'win32') return { ...definition, supported: false, registered: false, managed: false, state: null, running: null, reason: 'O controle de serviço só está disponível no Windows.' };
  const candidateNames = [definition.serviceName];
  let lastError = null;
  for (const serviceName of candidateNames) {
    try {
      const config = await execFileAsync('sc.exe', ['qc', serviceName], { timeout: 5000, windowsHide: true, maxBuffer: 8192 });
      const binaryLine = serviceCommandFromOutput(config.stdout);
      if (!binaryLine) return { ...definition, serviceName, supported: true, registered: true, managed: false, state: null, running: null, reason: 'O Windows encontrou o serviço, mas não consegui validar o executável configurado.' };
      const actualExecutable = serviceExecutableFromCommand(binaryLine);
      if (!actualExecutable || path.resolve(actualExecutable).toLowerCase() !== path.resolve(definition.executable).toLowerCase()) {
        return { ...definition, serviceName, supported: true, registered: true, managed: false, state: null, running: null, reason: `O serviço ${serviceName} não aponta para o runtime gerenciado.` };
      }
      const status = await execFileAsync('sc.exe', ['query', serviceName], { timeout: 5000, windowsHide: true, maxBuffer: 8192 });
      const stateCode = serviceStateCode(status.stdout);
      if (!stateCode) return { ...definition, serviceName, supported: true, registered: true, managed: false, state: null, running: null, reason: 'Não consegui interpretar o estado do serviço no Windows.' };
      const controlGranted = await serviceControlGranted(serviceName);
      return { ...definition, serviceName, supported: true, registered: true, managed: true, controlGranted, state: stateCode, running: stateCode === 4, reason: null };
    } catch (error) {
      lastError = error;
      const details = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
      if (/1060|does not exist|n[aã]o existe/i.test(details)) continue;
      const reason = /access is denied|acesso negado|openservice failed 5|error 5/i.test(details)
        ? 'O Windows bloqueou a consulta ao serviço. Abra o agente com a mesma conta que controla o ambiente.'
        : `Não foi possível consultar o Service Control Manager: ${details.trim().slice(0, 220)}`;
      return { ...definition, serviceName, supported: true, registered: null, managed: false, state: null, running: null, reason };
    }
  }
  const details = `${lastError?.stdout || ''}\n${lastError?.stderr || ''}\n${lastError?.message || ''}`;
  return { ...definition, supported: true, registered: false, managed: false, state: null, running: null, reason: `${definition.label} não está registrado como serviço do Windows.` };
}

async function runWindowsServiceAction(action, serviceName) {
  try {
    const result = action === 'start'
      ? await startWindowsServiceWithRetry(serviceName)
      : await execFileAsync('sc.exe', [action, serviceName], { timeout: 10000, windowsHide: true, maxBuffer: 8192 });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (/FAILED|FALHA|ACCESS_DENIED|Acesso negado/i.test(output)) throw new Error(output);
    return output;
  } catch (error) {
    const details = `${error.stdout || ''} ${error.stderr || ''} ${error.message || ''}`.trim();
    if (/access is denied|acesso negado|error 5|openservice failed 5/i.test(details)) {
      return runWindowsServiceHelper('sc', { scAction: action, serviceName });
    }
    throw new Error(details.slice(0, 320) || `O Windows não conseguiu executar ${action} no serviço ${serviceName}.`);
  }
}

async function registerXamppService(component) {
  if (process.platform !== 'win32') throw new Error('O controle integrado exige Windows.');
  const existing = await inspectXamppService(component);
  if (existing.registered) {
    if (existing.managed) return { component, serviceName: existing.serviceName, alreadyRegistered: true };
    throw new Error(existing.reason || `O serviço ${existing.serviceName} já existe e não pertence ao XAMPP configurado.`);
  }
  let helperResult = null;
  if (component === 'apache') {
    const apache = activeApacheRuntime();
    if (!fs.existsSync(apache.executable) || !fs.existsSync(apache.config)) throw new Error('O Apache ativo ou seu arquivo de configuração não foi encontrado.');
    const check = await execFileAsync(apache.executable, ['-t', '-d', apache.root, '-f', apache.config], { cwd: apache.root, timeout: 12000, windowsHide: true, maxBuffer: 16 * 1024 });
    if (!/Syntax OK/i.test(`${check.stdout}\n${check.stderr}`)) throw new Error('A validação da configuração do Apache não retornou “Syntax OK”; não registrei o serviço.');
    helperResult = await runWindowsServiceHelper('integrate-apache', {
      serviceName: existing.serviceName,
      executable: apache.executable,
      root: apache.root,
      config: apache.config
    });
  } else {
    const mysql = activeMySqlRuntime();
    const executable = mysql.executable;
    const defaults = mysql.config;
    if (!fs.existsSync(executable) || !fs.existsSync(defaults)) throw new Error('Não encontrei mysqld.exe e o arquivo de configuração do banco no ambiente configurado.');
    helperResult = await runWindowsServiceHelper('integrate-mysql', {
      serviceName: existing.serviceName,
      executable,
      config: defaults
    });
  }

  const verified = await inspectXamppService(component);
  if (!verified.managed) {
    try { await runWindowsServiceAction('delete', existing.serviceName); } catch {}
    throw new Error(verified.reason || 'O Windows registrou o serviço, mas não consegui confirmar seu executável. A tentativa foi revertida.');
  }
  const port = componentPort(component);
  const ownership = await portOwnership(port, component);
  return {
    component,
    serviceName: verified.serviceName,
    alreadyRegistered: false,
    running: verified.running,
    portActive: ownership.active,
    portManaged: ownership.managed,
    portConflict: ownership.active && !ownership.managed,
    portSummary: ownership.summary,
    migrationRequired: ownership.active && ownership.managed && !verified.running,
    elevated: Boolean(helperResult?.elevated)
  };
}

async function grantXamppServiceControl(component) {
  if (process.platform !== 'win32') throw new Error('O controle de serviço exige Windows.');
  const service = await inspectXamppService(component);
  if (!service.managed) throw new Error(service.reason || `Primeiro integre o serviço ${service.label} ao Studio.`);
  const result = await runWindowsServiceHelper('grant-control', { serviceName: service.serviceName });
  return { component, serviceName: service.serviceName, elevated: Boolean(result.elevated), granted: true };
}

function apacheServiceCommand(runtime, serviceName = serviceNameFor('apache')) {
  return `"${runtime.executable}" -k runservice -n "${serviceName}" -d "${runtime.root}" -f "${runtime.config}"`;
}

async function readServiceCommand(serviceName) {
  const key = `HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${String(serviceName).replace(/'/g, "''")}`;
  const script = `$v=(Get-ItemProperty -LiteralPath '${key}' -Name ImagePath -ErrorAction Stop).ImagePath; Write-Output ('XAMPPSTUDIO<' + $v + '>')`;
  try {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 12000, windowsHide: true, maxBuffer: 8192 });
    const match = String(result.stdout || '').match(/XAMPPSTUDIO<([\s\S]*)>/);
    return match ? match[1] : null;
  } catch { return null; }
}

async function changeApacheServiceCommand(command, serviceName = serviceNameFor('apache')) {
  const expected = String(command).trim();
  if (!(await isWindowsAdministrator())) {
    await runWindowsServiceHelper('sc', { scAction: 'config', serviceName, binPath: expected });
  } else {
    try {
      const result = await execFileAsync('sc.exe', ['config', serviceName, 'binPath=', expected], { timeout: 10000, windowsHide: true, maxBuffer: 8192 });
      if (/FAILED|FALHA/i.test(`${result.stdout} ${result.stderr}`)) throw new Error(`${result.stdout} ${result.stderr}`);
    } catch (error) {
      const details = `${error.stdout || ''} ${error.stderr || ''} ${error.message || ''}`.trim();
      if (/access is denied|acesso negado|error 5/i.test(details)) throw new Error('O Windows negou a troca do executável Apache. Inicie o XAMPP Studio como administrador.');
      throw new Error(`Não foi possível atualizar o serviço Apache: ${details.slice(0, 300)}`);
    }
  }
  // O Windows pode gravar o comando com aspas diferentes; a comparação ignora
  // aspas e espaços extras para detectar apenas comandos realmente diferentes.
  const stored = await readServiceCommand(serviceName);
  if (stored && /^\s/.test(stored)) {
    throw new Error(`O Windows gravou o comando do serviço ${serviceName} com espaço inicial ("${stored}"); o SCM não consegue iniciá-lo assim.`);
  }
  if (!stored || normalizeServiceCommand(stored) !== normalizeServiceCommand(expected)) {
    throw new Error(`O Windows gravou um comando inesperado para o serviço ${serviceName}: "${stored || 'vazio'}".`);
  }
  return { serviceName, command: stored };
}

async function waitForXamppService(component, expectedState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await inspectXamppService(component);
  while (Date.now() < deadline) {
    if (!latest.managed) throw new Error(latest.reason || 'O serviço deixou de ser controlável pelo XAMPP Studio.');
    if (latest.state === expectedState) return latest;
    await new Promise(resolve => setTimeout(resolve, 500));
    latest = await inspectXamppService(component);
  }
  throw new Error(`${latest.label} não atingiu o estado esperado dentro do prazo (estado Windows ${latest.state || 'desconhecido'}).`);
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkPort(port, '127.0.0.1', 700)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Porta em uso pelo componente.
 *
 * O Apache pode escutar em outra porta (por exemplo quando o Docker ocupa a
 * 80), então a porta é sempre lida da configuração ativa em vez de fixada no
 * código. O MySQL continua na 3306.
 */
function componentPort(component, runtime = null) {
  if (component !== 'apache') return 3306;
  const apache = runtime || activeApacheRuntime();
  return apachePrimaryPort(readText(apache.config));
}

async function restartXamppService(component) {
  const service = await inspectXamppService(component);
  if (!service.managed) throw new Error(service.reason || 'O controle de serviço não está disponível para este componente.');
  if (![1, 4].includes(service.state)) throw new Error(`${service.label} está em uma transição do Windows (estado ${service.state}); aguarde e tente novamente.`);

  const port = componentPort(component);
  if (service.state === 1) {
    const ownership = await portOwnership(port, component);
    if (ownership.active && ownership.managed) {
      throw new Error(`A porta ${port} ainda pertence a uma instância do runtime integrado. Pare essa instância uma vez pelo mecanismo que a iniciou e depois inicie pelo Studio.`);
    }
    if (ownership.active) {
      throw new Error(`A porta ${port} está ocupada por ${ownership.summary || 'outro processo'} e não pelo XAMPP Studio. Libere essa porta antes de iniciar o serviço; o Studio não encerra processos externos.`);
    }
  }

  if (component === 'apache') {
    const apache = activeApacheRuntime();
    const check = await execFileAsync(apache.executable, ['-t', '-d', apache.root, '-f', apache.config], { cwd: apache.root, timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 });
    if (!/Syntax OK/i.test(`${check.stdout}\n${check.stderr}`)) throw new Error('A validação da configuração do Apache não retornou “Syntax OK”; o serviço não foi alterado.');
  }

  let action = 'reiniciado';
  if (service.state === 4) {
    await restartWindowsService(service.serviceName);
  } else {
    action = 'iniciado';
    await runWindowsServiceAction('start', service.serviceName);
  }
  const finalState = await waitForXamppService(component, 4, 45000);
  const responding = await waitForPort(port, 20000);
  return { component, label: finalState.label, serviceName: finalState.serviceName, action, running: true, port, responding, verifiedAt: new Date().toISOString() };
}

/**
 * Reaplica o comando de inicialização do serviço no Windows.
 *
 * Útil quando o serviço ficou com um ImagePath antigo em cache no SCM (por
 * exemplo depois de uma troca de runtime): o Studio reescreve o comando, o
 * Windows passa a usar o executável correto e o serviço volta a subir.
 */
async function repairXamppService(component) {
  if (process.platform !== 'win32') throw new Error('O reparo de serviço exige Windows.');
  if (!['apache', 'mysql'].includes(component)) throw new Error('Escolha Apache ou MySQL/MariaDB.');
  const service = await inspectXamppService(component);
  if (!service.managed) throw new Error(service.reason || `Primeiro integre o serviço ${service.label} ao Studio.`);
  let expected = null;
  if (component === 'apache') {
    const apache = activeApacheRuntime();
    expected = apacheServiceCommand(apache);
    const check = await execFileAsync(apache.executable, ['-t', '-d', apache.root, '-f', apache.config], { cwd: apache.root, timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 });
    if (!/Syntax OK/i.test(`${check.stdout}\n${check.stderr}`)) throw new Error('A configuração do Apache não passou na validação; o serviço não foi alterado.');
  } else {
    const runtime = activeMySqlRuntime();
    expected = `"${runtime.executable}" --defaults-file="${runtime.config}"`;
  }
  const before = await readServiceCommand(service.serviceName);
  await changeApacheServiceCommand(expected, service.serviceName);
  const after = await readServiceCommand(service.serviceName);
  return { component, serviceName: service.serviceName, before, after, repaired: true };
}

async function stopXamppService(component) {
  const service = await inspectXamppService(component);
  if (!service.managed) throw new Error(service.reason || `Primeiro integre o serviço ${service.label} ao Studio.`);
  const port = componentPort(component);
  if (service.state === 1) {
    return { component, label: service.label, serviceName: service.serviceName, stopped: true, alreadyStopped: true, port, portActive: await checkPort(port), stoppedAt: new Date().toISOString() };
  }
  await runWindowsServiceAction('stop', service.serviceName);
  const finalState = await waitForXamppService(component, 1, 30000);
  return {
    component,
    label: finalState.label,
    serviceName: finalState.serviceName,
    stopped: true,
    alreadyStopped: false,
    port,
    portActive: await checkPort(port),
    stoppedAt: new Date().toISOString()
  };
}

async function changeServiceCommand(serviceName, command) {
  if (!(await isWindowsAdministrator())) {
    return runWindowsServiceHelper('sc', { scAction: 'config', serviceName, binPath: command });
  }
  try {
    const result = await execFileAsync('sc.exe', ['config', serviceName, 'binPath=', command], { timeout: 10000, windowsHide: true, maxBuffer: 8192 });
    if (/FAILED|FALHA/i.test(`${result.stdout} ${result.stderr}`)) throw new Error(`${result.stdout} ${result.stderr}`);
  } catch (error) {
    const details = `${error.stdout || ''} ${error.stderr || ''} ${error.message || ''}`.trim();
    if (/access is denied|acesso negado|error 5/i.test(details)) throw new Error('O Windows negou a troca do executável do serviço. Inicie o XAMPP Studio como administrador.');
    throw new Error(`Não foi possível atualizar o serviço ${serviceName}: ${details.slice(0, 300)}`);
  }
}

module.exports = {
  apacheServiceCommand,
  buildStandaloneModeState,
  changeApacheServiceCommand,
  changeServiceCommand,
  checkPort,
  componentPort,
  currentWindowsUserSid,
  grantXamppServiceControl,
  inspectXamppService,
  isWindowsAdministrator,
  portListeners,
  portOwnership,
  readServiceCommand,
  registerXamppService,
  repairXamppService,
  restartWindowsService,
  restartXamppService,
  runWindowsServiceAction,
  runWindowsServiceHelper,
  serviceCommandFromOutput,
  serviceControlGranted,
  serviceDefinitions,
  serviceExecutableFromCommand,
  serviceHelperErrorDetails,
  serviceNameFor,
  serviceStateCode,
  setServiceStartType,
  startWindowsServiceWithRetry,
  stopXamppService,
  waitForPort,
  waitForWindowsServiceState,
  waitForXamppService
};
