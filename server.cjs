'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomBytes } = require('node:crypto');
const { JobManager } = require('./lib/jobs.cjs');
const { logSources, readFirewallFilters, readFirewallPage, editorLogPath } = require('./lib/firewall-logs.cjs');
const { extensionName, parsePeclBuilds, searchExtensionCatalog } = require('./lib/extension-catalog.cjs');
const { listExtensionDownloads } = require('./lib/extension-downloads.cjs');
const { listDatabaseReleases } = require('./lib/database-catalog.cjs');
const { readPeImports, readPeImportSymbols, readPeExports } = require('./lib/pe-imports.cjs');
const {
  PHP_CORE_DLL,
  apacheConfigFiles,
  apacheErrorLogPath,
  apacheErrorLogSize,
  apacheExtensionLoadFailures,
  apacheStartupLogDetail,
  apacheStartupLibraries,
  describeApacheConflicts,
  escapeRegExp,
  extensionDllName,
  isBuiltinOpcache,
  phpExtensionDirectives,
  phpRuntimeApacheConflicts,
  phpRuntimeDependencyDlls,
  rewriteXamppPhpConfig
} = require('./lib/php-compat.cjs');
const {
  quoteServiceCommand,
  serviceCommandMatches
} = require('./lib/service-command.cjs');
const {
  apacheDirectives,
  fileInfo,
  phpIniHighlights,
  renderDiagnosticsMarkdown,
  tailFile
} = require('./lib/diagnostics.cjs');
const {
  APP_ROOT,
  ENVIRONMENT_STATE,
  WORKSPACE_ROOT,
  XAMPP_ROOT,
  activeApacheRuntime,
  activeMySqlRuntime,
  canWrite,
  getConfig,
  isInside,
  isStandaloneMode,
  readEnvironmentState,
  readText,
  runtimeMode,
  samePath,
  serviceNameFor,
  writeAtomically,
  writeEnvironmentState
} = require('./lib/runtime-state.cjs');
const {
  APACHE_PORT_TIMEOUT_MS,
  APACHE_START_TIMEOUT_MS,
  apacheServiceCommand,
  buildStandaloneModeState,
  changeApacheServiceCommand,
  changeServiceCommand,
  checkPort,
  componentPort,
  grantXamppServiceControl,
  inspectXamppService,
  isWindowsAdministrator,
  portOwnership,
  readServiceCommand,
  registerXamppService,
  repairXamppService,
  restartWindowsService,
  restartXamppService,
  runWindowsServiceAction,
  runWindowsServiceHelper,
  serviceCommandFromOutput,
  setServiceStartType,
  stopXamppService,
  waitForPort,
  waitForXamppService
} = require('./lib/services.cjs');
const { apacheDenyRules, apachePrimaryPort, apacheServerName, rewriteApacheListenPort } = require('./lib/apache-config.cjs');

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.XAMPP_STUDIO_PORT || 43197);
const BACKUP_ROOT = path.join(APP_ROOT, 'backups');
const PERFORMANCE_STATE = path.join(APP_ROOT, 'performance-state.json');
const FIREWALL_STATE = path.join(APP_ROOT, 'firewall-state.json');
const BODY_CAPTURE_SCRIPT = path.join(APP_ROOT, 'request-body-log.php');
const BODY_CAPTURE_LOG = path.join(APP_ROOT, 'logs', 'request-bodies.jsonl');
const DLL_REGISTRY = path.join(APP_ROOT, 'dll-registry.json');
const JOB_STATE = path.join(APP_ROOT, 'jobs', 'job-state.json');
const jobManager = new JobManager({ file: JOB_STATE });
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/js/app.js', ['js/app.js', 'text/javascript; charset=utf-8']],
  ['/js/core.js', ['js/core.js', 'text/javascript; charset=utf-8']],
  ['/js/api.js', ['js/api.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const MAX_BODY = 2 * 1024 * 1024;
let phpActivationInProgress = false;
const editingPhpRoots = new Set();

async function withPhpRuntimeEdit(root, edit) {
  const key = path.resolve(root).toLowerCase();
  if (phpActivationInProgress || editingPhpRoots.has(key)) {
    throw new Error('O Studio já está alterando este ambiente PHP. Aguarde a conclusão.');
  }
  editingPhpRoots.add(key);
  try { return await edit(); }
  finally { editingPhpRoots.delete(key); }
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

const XAMPP_ACTION_COMPONENTS = new Set(['apache', 'mysql', 'php']);

function xamppLogsFolder(component) {
  const config = getConfig();
  if (component === 'apache') {
    const root = activeApacheRuntime().root;
    const candidate = path.join(root, 'logs');
    return fs.existsSync(candidate) ? candidate : root;
  }
  if (component === 'mysql') {
    const root = activeMySqlRuntime().root;
    const candidate = path.join(root, 'logs');
    if (fs.existsSync(candidate)) return candidate;
    const data = path.join(root, 'data');
    return fs.existsSync(data) ? data : root;
  }
  if (component === 'php') {
    const candidate = path.join(config.phpRoot, 'logs');
    if (fs.existsSync(candidate)) return candidate;
  }
  const globalLogs = path.join(XAMPP_ROOT, 'logs');
  return fs.existsSync(globalLogs) ? globalLogs : XAMPP_ROOT;
}

function resolveXamppAction(action, component) {
  const config = getConfig();
  const apache = activeApacheRuntime();
  const mysql = activeMySqlRuntime();
  const key = typeof component === 'string' && XAMPP_ACTION_COMPONENTS.has(component) ? component : null;

  if (action === 'shell') {
    const root = key === 'apache' ? apache.root : key === 'mysql' ? mysql.root : key === 'php' ? config.phpRoot : XAMPP_ROOT;
    return { type: 'shell', target: root, label: key ? `Shell · ${key}` : 'Shell' };
  }
  if (action === 'explorer') return { type: 'folder', target: XAMPP_ROOT, label: 'Explorer' };
  if (action === 'logs') return { type: 'folder', target: xamppLogsFolder(key), label: key ? `Logs · ${key}` : 'Logs' };
  if (action === 'config') {
    const file = key === 'apache' ? apache.config : key === 'mysql' ? mysql.config : key === 'php' ? path.join(config.phpRoot, 'php.ini') : null;
    if (!file) throw new Error('Escolha Apache, MySQL/MariaDB ou PHP para abrir um arquivo de configuração.');
    return { type: 'file', target: file, label: `Config · ${key}` };
  }
  if (action === 'admin') {
    const adminBase = `http://localhost:${componentPort('apache', apache)}`;
    if (key === 'apache') return { type: 'url', target: `${adminBase}/`, label: 'Admin · Apache' };
    if (key === 'mysql') {
      const admin = path.join(XAMPP_ROOT, 'phpMyAdmin');
      if (!fs.existsSync(admin)) throw new Error('O phpMyAdmin não está presente nesta instalação do XAMPP.');
      return { type: 'url', target: `${adminBase}/phpmyadmin/`, label: 'Admin · MySQL/MariaDB' };
    }
    throw new Error('Escolha Apache ou MySQL/MariaDB para abrir o painel administrativo.');
  }
  throw new Error('Ação do XAMPP não reconhecida.');
}

function assertAllowedXamppTarget(target) {
  const resolved = path.resolve(target);
  if (!isInside(XAMPP_ROOT, resolved) && !isInside(APP_ROOT, resolved)) {
    throw new Error('O destino está fora das pastas permitidas do XAMPP Studio.');
  }
  return resolved;
}

function launchDetached(file, args, options = {}) {
  const { waitForExit = false, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, ...spawnOptions });
    let settled = false;
    child.once('error', error => { if (!settled) { settled = true; reject(new Error(`Não foi possível abrir ${file}: ${error.message}`)); } });
    if (waitForExit) {
      child.once('exit', code => {
        if (settled) return;
        settled = true;
        child.unref();
        if (code === 0) resolve(child.pid);
        else reject(new Error(`O Windows não conseguiu abrir a janela (código ${code}).`));
      });
    } else {
      child.once('spawn', () => { if (!settled) { settled = true; child.unref(); resolve(child.pid); } });
    }
  });
}

async function openXamppAction(target) {
  const resolved = assertAllowedXamppTarget(target.target);
  if (target.type === 'file') {
    if (!fs.existsSync(resolved)) throw new Error(`Arquivo de configuração não encontrado: ${resolved}`);
    await launchDetached('notepad.exe', [resolved]);
    return { ...target, target: resolved, openedWith: 'Bloco de Notas' };
  }
  if (target.type === 'folder') {
    if (!fs.existsSync(resolved)) throw new Error(`Pasta não encontrada: ${resolved}`);
    await launchDetached('explorer.exe', [resolved]);
    return { ...target, target: resolved, openedWith: 'Explorer' };
  }
  if (target.type === 'shell') {
    if (!fs.existsSync(resolved)) throw new Error(`Pasta não encontrada: ${resolved}`);
    await launchDetached('cmd.exe', ['/d', '/c', `start "XAMPP Studio Shell" /D "${resolved}" cmd.exe /k`], { windowsVerbatimArguments: true, waitForExit: true });
    return { ...target, target: resolved, openedWith: 'Prompt de comando' };
  }
  if (target.type === 'url') {
    await launchDetached('rundll32.exe', ['url.dll,FileProtocolHandler', target.target]);
    return { ...target, openedWith: 'Navegador padrão' };
  }
  throw new Error('Destino inválido para esta ação.');
}

async function performXamppAction(action, component) {
  if (process.platform !== 'win32') throw new Error('As ações do XAMPP exigem Windows.');
  const target = resolveXamppAction(action, component);
  return openXamppAction(target);
}

async function listNetstatEntries() {
  if (process.platform !== 'win32') return { entries: [], generatedAt: new Date().toISOString(), counts: { listening: 0, total: 0 } };
  const snapshotCommand = `$services=@(Get-CimInstance Win32_Service | Select-Object ProcessId,Name,State,StartMode); $processes=@(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine); [pscustomobject]@{ services=$services; processes=$processes } | ConvertTo-Json -Compress -Depth 4`;
  let processes = new Map();
  let services = new Map();
  try {
    const snapshot = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', snapshotCommand], { timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const parsed = JSON.parse((snapshot.stdout || '').trim() || '{}');
    for (const item of parsed.processes || []) {
      if (!item?.ProcessId) continue;
      processes.set(Number(item.ProcessId), { name: item.Name || null, executable: item.ExecutablePath || null, commandLine: item.CommandLine || null });
    }
    for (const item of parsed.services || []) {
      if (!item?.ProcessId) continue;
      services.set(Number(item.ProcessId), { name: item.Name || null, state: item.State || null, startMode: item.StartMode || null });
    }
  } catch {}

  const apacheExe = path.resolve(activeApacheRuntime().executable).toLowerCase();
  const mysqlExe = path.resolve(activeMySqlRuntime().executable).toLowerCase();
  const apacheService = serviceNameFor('apache').toLowerCase();
  const mysqlService = serviceNameFor('mysql').toLowerCase();

  let netstat = '';
  try {
    const result = await execFileAsync('netstat.exe', ['-ano'], { timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    netstat = result.stdout || '';
  } catch {}

  const entries = [];
  for (const line of netstat.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || (parts[0] !== 'TCP' && parts[0] !== 'UDP')) continue;
    const protocol = parts[0];
    const local = parts[1] || '';
    const remote = parts[2] || '';
    const state = protocol === 'TCP' ? (parts[3] || null) : null;
    const pid = Number(protocol === 'TCP' ? parts[4] : parts[3]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const separator = local.lastIndexOf(':');
    if (separator <= 0) continue;
    const port = Number(local.slice(separator + 1));
    if (!Number.isFinite(port)) continue;
    const process = processes.get(pid) || null;
    const service = services.get(pid) || null;
    const executable = process?.executable ? path.resolve(process.executable).toLowerCase() : null;
    let managed = null;
    if (service?.name && service.name.toLowerCase() === apacheService) managed = 'apache';
    else if (service?.name && service.name.toLowerCase() === mysqlService) managed = 'mysql';
    else if (executable === apacheExe) managed = 'apache';
    else if (executable === mysqlExe) managed = 'mysql';
    entries.push({
      protocol,
      localAddress: local.slice(0, separator),
      localPort: port,
      remoteAddress: remote || null,
      state,
      pid,
      processName: process?.name || null,
      executable: process?.executable || null,
      commandLine: process?.commandLine || null,
      serviceName: service?.name || null,
      serviceState: service?.state || null,
      managed
    });
  }

  const isListening = entry => entry.state === 'LISTENING' || entry.state === 'ESCUTANDO';
  const ordered = [
    ...entries.filter(isListening),
    ...entries.filter(entry => entry.protocol === 'UDP' && !isListening(entry)),
    ...entries.filter(entry => entry.protocol !== 'UDP' && !isListening(entry))
  ].sort((a, b) => a.localPort - b.localPort || a.protocol.localeCompare(b.protocol)).slice(0, 600);
  return {
    entries: ordered,
    counts: { listening: entries.filter(isListening).length, total: entries.length },
    generatedAt: new Date().toISOString()
  };
}

async function scanStatus() {
  const config = getConfig();
  const phpExe = path.join(config.phpRoot, 'php.exe');
  const activePhpRoot = readEnvironmentState().phpRoot;
  let phpCli = null;
  if ((isInside(XAMPP_ROOT, config.phpRoot) || isInside(path.join(APP_ROOT, 'runtimes'), config.phpRoot) || (activePhpRoot && samePath(config.phpRoot, activePhpRoot))) && fs.existsSync(phpExe)) {
    try {
      const result = await execFileAsync(phpExe, ['-r', 'echo PHP_VERSION,"|",(PHP_ZTS?"TS":"NTS"),"|",PHP_INT_SIZE*8,"|",json_encode(get_loaded_extensions());'], { timeout: 3000, windowsHide: true, maxBuffer: 32 * 1024 });
      const [version, threadSafety, architecture, extensionsJson] = result.stdout.trim().split('|');
      phpCli = { version, threadSafety, architecture: `${architecture}-bit`, extensions: JSON.parse(extensionsJson || '[]') };
    } catch (error) {
      phpCli = { error: error.message.slice(0, 180) };
    }
  }
  const apacheRuntime = activeApacheRuntime();
  const apachePortNumber = componentPort('apache', apacheRuntime);
  const [apachePortActive, mysqlPortActive, apacheService, mysqlService] = await Promise.all([
    checkPort(apachePortNumber), checkPort(3306), inspectXamppService('apache'), inspectXamppService('mysql')
  ]);
  const [apachePort, mysqlPort] = await Promise.all([
    portOwnership(apachePortNumber, 'apache'),
    portOwnership(3306, 'mysql')
  ]);
  let apacheVersion = null;
  try {
    const result = await execFileAsync(apacheRuntime.executable, ['-v'], { timeout: 4000, windowsHide: true, maxBuffer: 4096 });
    apacheVersion = result.stdout.match(/Apache\/(\d+\.\d+\.\d+)/)?.[1] || null;
  } catch {}
  const mysqlIdentity = await getMySqlIdentity(config.mysqlRuntime.executable);
  const windowsAdmin = await isWindowsAdministrator();
  return {
    xamppRoot: XAMPP_ROOT,
    phpRoot: config.phpRoot,
    phpIni: path.join(config.phpRoot, 'php.ini'),
    phpCli,
    declaredVersion: config.phpVersion,
    apache: {
      running: apacheService.state === 4,
      portActive: apachePortActive,
      portOwnedByStudio: apachePort.managed,
      port: apachePortNumber,
      url: `http://localhost:${apachePortNumber}`,
      config: apacheRuntime.config,
      phpModule: config.activeModule,
      phpIniDir: config.phpIniDir,
      version: apacheVersion,
      root: apacheRuntime.root,
      source: apacheRuntime.source
    },
    mysql: {
      running: mysqlService.state === 4,
      portActive: mysqlPortActive,
      portOwnedByStudio: mysqlPort.managed,
      port: 3306,
      config: config.mysqlRuntime.config,
      version: config.mysqlRuntime.version || mysqlIdentity.version,
      product: config.mysqlRuntime.product || mysqlIdentity.product,
      root: config.mysqlRuntime.root,
      source: config.mysqlRuntime.source
    },
    mode: runtimeMode(),
    workspaceRoot: WORKSPACE_ROOT,
    serviceControl: {
      apache: { ...apacheService, portActive: apachePort.active, portManaged: apachePort.managed, portListeners: apachePort.listeners, portSummary: apachePort.summary },
      mysql: { ...mysqlService, portActive: mysqlPort.active, portManaged: mysqlPort.managed, portListeners: mysqlPort.listeners, portSummary: mysqlPort.summary }
    },
    writable: {
      phpIni: canWrite(path.join(config.phpRoot, 'php.ini')),
      apacheConfig: canWrite(config.apacheConf)
    },
    platform: `${os.platform()} ${os.arch()}`,
    windowsAdmin,
    elevationAvailable: process.platform === 'win32'
  };
}

/**
 * Diagnóstico do ambiente local: junta as evidências que explicam por que um
 * componente não se comporta como esperado. É somente leitura.
 */
async function collectDiagnostics() {
  const config = getConfig();
  const state = readEnvironmentState();
  const apacheRuntime = activeApacheRuntime();
  const mysqlRuntime = activeMySqlRuntime();
  const apachePortNumber = componentPort('apache', apacheRuntime);
  const [apacheService, mysqlService, apachePort, mysqlPort, windowsAdmin] = await Promise.all([
    inspectXamppService('apache'),
    inspectXamppService('mysql'),
    portOwnership(apachePortNumber, 'apache'),
    portOwnership(3306, 'mysql'),
    isWindowsAdministrator()
  ]);
  const apacheFiles = apacheConfigFiles(apacheRuntime.root, apacheRuntime.config);
  const versions = getVersionsWithDllChecks();
  const phpExecutable = path.join(config.phpRoot, 'php.exe');
  const phpInfo = fileInfo(phpExecutable);
  const apacheInfo = fileInfo(apacheRuntime.executable);
  const mysqlInfo = fileInfo(mysqlRuntime.executable);
  const phpIniContents = readText(path.join(config.phpRoot, 'php.ini')) || '';
  const services = [];
  for (const [component, service] of [['apache', apacheService], ['mysql', mysqlService]]) {
    services.push({
      component,
      serviceName: service.serviceName || null,
      state: service.state ?? null,
      stateLabel: service.state === 4 ? 'RUNNING' : service.state === 1 ? 'STOPPED' : service.state ?? null,
      running: service.state === 4,
      managed: Boolean(service.managed),
      controlGranted: Boolean(service.controlGranted),
      imagePath: service.serviceName ? await readServiceCommand(service.serviceName) : null
    });
  }
  const certificate = readCertificateSummary(apacheRuntime.root);
  const mysqlIdentity = await getMySqlIdentity(mysqlRuntime.executable);
  const mysqlLogRoot = path.join(mysqlRuntime.root, 'data');
  return {
    generatedAt: new Date().toISOString(),
    studio: {
      version: '0.1',
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      port: PORT,
      windowsAdmin,
      pid: process.pid
    },
    environment: {
      mode: runtimeMode(),
      xamppRoot: XAMPP_ROOT,
      workspaceRoot: WORKSPACE_ROOT,
      state
    },
    components: {
      apache: {
        version: apacheRuntime.version || null,
        root: apacheRuntime.root,
        executable: apacheRuntime.executable,
        config: apacheRuntime.config,
        source: apacheRuntime.source,
        running: apachePort.active,
        sha256: apacheInfo?.sha256 || null,
        bytes: apacheInfo?.bytes || null,
        openssl: apacheRuntime.version ? null : null
      },
      php: {
        version: config.phpVersion || null,
        root: config.phpRoot,
        executable: phpExecutable,
        ini: path.join(config.phpRoot, 'php.ini'),
        running: true,
        sha256: phpInfo?.sha256 || null,
        bytes: phpInfo?.bytes || null,
        extensions: phpExtensionDirectives(phpIniContents).map(item => item.dll)
      },
      mysql: {
        version: mysqlRuntime.version || mysqlIdentity.version || null,
        product: mysqlRuntime.product || mysqlIdentity.product || null,
        root: mysqlRuntime.root,
        executable: mysqlRuntime.executable,
        config: mysqlRuntime.config,
        running: mysqlPort.active,
        sha256: mysqlInfo?.sha256 || null,
        bytes: mysqlInfo?.bytes || null
      }
    },
    services,
    ports: {
      [apachePortNumber]: { active: apachePort.active, managed: apachePort.managed, summary: apachePort.summary, listeners: apachePort.listeners },
      3306: { active: mysqlPort.active, managed: mysqlPort.managed, summary: mysqlPort.summary, listeners: mysqlPort.listeners }
    },
    compatibility: versions.versions.map(item => ({
      version: item.version,
      root: item.root,
      current: Boolean(item.current),
      compatible: item.apacheCompatibility.compatible,
      summary: item.apacheCompatibility.summary,
      conflicts: item.apacheCompatibility.conflicts
    })),
    apache: {
      version: apacheRuntime.version || null,
      root: apacheRuntime.root,
      configFiles: apacheFiles,
      directives: apacheDirectives(apacheFiles).filter(item => ['ServerRoot', 'DocumentRoot', 'Listen', 'ErrorLog', 'SSLCertificateFile', 'SSLCertificateKeyFile'].includes(item.directive))
    },
    certificate,
    phpIniHighlights: phpIniHighlights(phpIniContents),
    jobs: jobManager.list({ limit: 12 }).map(job => ({
      id: job.id,
      type: job.type,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
      steps: (job.steps || []).map(step => `${step.label}: ${step.status}`)
    })),
    logs: {
      apacheError: tailFile(apacheErrorLogPath(apacheRuntime.root), 45),
      mysqlError: tailFile(path.join(mysqlLogRoot, `${mysqlRuntime.product || 'mysql'}.log`), 25)
    }
  };
}

/** Resumo do certificado TLS do runtime Apache (chave, titular e validade). */
function readCertificateSummary(apacheRoot) {
  const openssl = path.join(apacheRoot, 'bin', 'openssl.exe');
  const certificate = path.join(apacheRoot, 'conf', 'ssl.crt', 'server.crt');
  if (!fs.existsSync(openssl) || !fs.existsSync(certificate)) return null;
  const status = apacheCertificateStatus(apacheRoot);
  try {
    const result = execFileSync(openssl, ['x509', '-in', certificate, '-noout', '-subject', '-dates'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, OPENSSL_CONF: path.join(apacheRoot, 'conf', 'openssl.cnf') }
    });
    const subject = result.match(/^subject=\s*(.+)$/im)?.[1]?.trim() || null;
    const notAfter = result.match(/^notAfter=(.+)$/im)?.[1]?.trim() || null;
    return { bits: status.bits, ok: status.ok, reason: status.reason || null, subject, notAfter };
  } catch {
    return { bits: status.bits, ok: status.ok, reason: status.reason || null, subject: null, notAfter: null };
  }
}

function getVersions() {
  const current = getConfig();
  const results = [];
  const bundledPhpRoot = path.join(XAMPP_ROOT, 'php');
  if (fs.existsSync(path.join(bundledPhpRoot, 'php.exe'))) {
    const environment = readEnvironmentState();
    let bundledVersion = path.resolve(current.phpRoot).toLowerCase() === path.resolve(bundledPhpRoot).toLowerCase()
      ? current.phpVersion || 'PHP do XAMPP'
      : environment.originalPhpVersion || 'PHP do XAMPP';
    if (bundledVersion === 'PHP do XAMPP') {
      try {
        const result = execFileSync(path.join(bundledPhpRoot, 'php.exe'), ['-r', 'echo PHP_VERSION;'], { timeout: 2500, windowsHide: true, encoding: 'utf8' });
        bundledVersion = result.trim() || bundledVersion;
      } catch {}
    }
    results.push({ version: bundledVersion, root: bundledPhpRoot, current: path.resolve(current.phpRoot).toLowerCase() === path.resolve(bundledPhpRoot).toLowerCase(), source: 'PHP incluído no XAMPP', apacheModule: fs.existsSync(path.join(bundledPhpRoot, 'php8apache2_4.dll')) || fs.existsSync(path.join(bundledPhpRoot, 'php7apache2_4.dll')), threadSafety: null, architecture: null, missingExtensions: [] });
  }
  const runtimesRoot = path.join(APP_ROOT, 'runtimes');
  if (fs.existsSync(runtimesRoot)) {
    for (const item of fs.readdirSync(runtimesRoot, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('.staging-')) continue;
      const root = path.join(runtimesRoot, item.name);
      if (!fs.existsSync(path.join(root, 'php.exe'))) continue;
      let metadata = {};
      try { metadata = JSON.parse(readText(path.join(root, 'studio-runtime.json'))); } catch {}
      results.push({ version: metadata.version || item.name, root, current: path.resolve(root).toLowerCase() === path.resolve(current.phpRoot).toLowerCase(), source: 'XAMPP Studio', threadSafety: metadata.threadSafety || null, architecture: metadata.architecture || null, apacheModule: fs.readdirSync(root).some(name => /^php\d*apache2_4\.dll$/i.test(name)), missingExtensions: metadata.extensions?.missing || [], migratedExtensions: metadata.extensions?.migrated || [] });
    }
  }
  const activeRoot = path.resolve(current.phpRoot);
  if (!results.some(item => samePath(item.root, activeRoot)) && fs.existsSync(path.join(activeRoot, 'php.exe'))) {
    let metadata = {};
    try { metadata = JSON.parse(readText(path.join(activeRoot, 'studio-runtime.json'))); } catch {}
    let version = metadata.version || current.phpVersion || path.basename(activeRoot);
    if (!metadata.version && !current.phpVersion) {
      try { version = execFileSync(path.join(activeRoot, 'php.exe'), ['-r', 'echo PHP_VERSION;'], { timeout: 2500, windowsHide: true, encoding: 'utf8' }).trim() || version; } catch {}
    }
    const names = fs.readdirSync(activeRoot);
    results.push({
      version,
      root: activeRoot,
      current: true,
      source: 'Runtime ativo',
      threadSafety: metadata.threadSafety || (names.some(name => /^php\d+ts\.dll$/i.test(name)) ? 'TS' : 'NTS'),
      architecture: metadata.architecture || null,
      apacheModule: names.some(name => /^php\d*apache2_4\.dll$/i.test(name)),
      missingExtensions: metadata.extensions?.missing || [],
      migratedExtensions: metadata.extensions?.migrated || []
    });
  }
  return results;
}

function inspectRuntime(rawPath) {
  if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) throw new Error('Informe o caminho absoluto de uma pasta PHP instalada.');
  const resolved = fs.realpathSync(rawPath);
  const runtimeRoot = path.join(APP_ROOT, 'runtimes');
  const environment = readEnvironmentState();
  const activePhpRoot = typeof environment.phpRoot === 'string' ? environment.phpRoot : null;
  if (!isInside(XAMPP_ROOT, resolved) && !isInside(runtimeRoot, resolved) && !(activePhpRoot && samePath(resolved, activePhpRoot))) throw new Error('Por segurança, o runtime precisa estar dentro do XAMPP, do runtime ativo ou de runtimes/ do XAMPP Studio.');
  const names = fs.existsSync(resolved) ? fs.readdirSync(resolved) : [];
  const apacheModule = names.find(name => /^php\d*apache2_4\.dll$/i.test(name)) || null;
  const tsRuntime = names.find(name => /^php\d*ts\.dll$/i.test(name)) || null;
  return {
    path: resolved,
    versionLabel: path.basename(resolved),
    hasPhpExe: fs.existsSync(path.join(resolved, 'php.exe')),
    hasPhpIni: fs.existsSync(path.join(resolved, 'php.ini')),
    hasExtensions: fs.existsSync(path.join(resolved, 'ext')),
    apacheModule,
    threadSafeRuntime: tsRuntime,
    filesRequiredForSwitch: [apacheModule, tsRuntime].filter(Boolean),
    readyForSwitch: Boolean(fs.existsSync(path.join(resolved, 'php.exe')) && fs.existsSync(path.join(resolved, 'php.ini')) && apacheModule && tsRuntime)
  };
}

function analyzeSql(sql) {
  const clean = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').replace(/#[^\r\n]*/g, ' ');
  const checks = [
    ['DROP DATABASE', /\bDROP\s+DATABASE\b/ig],
    ['DROP TABLE', /\bDROP\s+TABLE\b/ig],
    ['TRUNCATE TABLE', /\bTRUNCATE\s+(?:TABLE\s+)?[`\w]/ig],
    ['ALTER TABLE ... DROP', /\bALTER\s+TABLE\b[^;]*\bDROP\b/ig],
    ['DELETE sem WHERE', /\bDELETE\s+FROM\s+[^;]+;/ig],
    ['UPDATE sem WHERE', /\bUPDATE\s+[^;]+\bSET\b[^;]*;/ig]
  ];
  const risks = [];
  for (const [label, regex] of checks) {
    for (const match of clean.matchAll(regex)) {
      if (label === 'DELETE sem WHERE' && /\bWHERE\b/i.test(match[0])) continue;
      if (label === 'UPDATE sem WHERE' && /\bWHERE\b/i.test(match[0])) continue;
      risks.push({ operation: label, excerpt: match[0].slice(0, 180) });
    }
  }
  const statements = clean.split(';').map(part => part.trim()).filter(Boolean);
  return { statements: statements.length, risks, preview: statements.slice(0, 30).map(s => s.slice(0, 500)), truncated: statements.length > 30, note: 'Análise heurística; comentários e literais complexos podem exigir revisão manual.' };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Corpo maior que o limite de 2 MB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function trustedLocalRequest(req) {
  // Host com [::1]: o split por ":" clássico quebra em endereços entre
  // colchetes; a URL normaliza os três formatos de loopback.
  let host = '';
  try { host = new URL(`http://${req.headers.host || ''}`).hostname.toLowerCase(); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`];
  // Com a porta 80, o navegador omite a porta padrão no header Origin.
  if (PORT === 80) origins.push('http://127.0.0.1', 'http://localhost', 'http://[::1]');
  return origins.includes(req.headers.origin);
}

async function createBackup() {
  const config = getConfig();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(BACKUP_ROOT, timestamp);
  fs.mkdirSync(destination, { recursive: true });
  const copied = [];
  const apache = activeApacheRuntime();
  const mysql = activeMySqlRuntime();
  const candidates = [
    ['php.ini', path.join(config.phpRoot, 'php.ini')],
    ['httpd-active.conf', config.apacheConf],
    ['properties.ini', path.join(XAMPP_ROOT, 'properties.ini')],
    ['httpd.conf', path.join(apache.root, 'conf', 'httpd.conf')],
    ['my.ini', mysql.config],
    ['environment-state.json', ENVIRONMENT_STATE]
  ];
  for (const [name, source] of candidates) {
    if (!fs.existsSync(source)) continue;
    if (!isInside(XAMPP_ROOT, source) && !isInside(path.join(APP_ROOT, 'runtimes'), source) && !isInside(APP_ROOT, source)) throw new Error(`Arquivo de origem fora das pastas gerenciadas: ${source}`);
    const target = path.join(destination, name);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    copied.push({ name, source, target, bytes: fs.statSync(target).size, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
  }
  if (!copied.length) throw new Error('Não encontrei arquivos de configuração para copiar.');
  const manifest = { createdAt: new Date().toISOString(), xamppRoot: XAMPP_ROOT, files: copied };
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}

function managedPhpRoot(rawRoot) {
  const config = getConfig();
  if (rawRoot === undefined || rawRoot === null || rawRoot === '') return config.phpRoot;
  if (typeof rawRoot !== 'string' || !path.isAbsolute(rawRoot)) throw new Error('Informe o caminho absoluto de um runtime PHP.');
  if (!fs.existsSync(rawRoot)) throw new Error('A pasta do runtime PHP informado não existe.');
  const root = fs.realpathSync(rawRoot);
  const environment = readEnvironmentState();
  const activePhpRoot = typeof environment.phpRoot === 'string' ? environment.phpRoot : null;
  if (!isInside(XAMPP_ROOT, root) && !isInside(path.join(APP_ROOT, 'runtimes'), root) && !(activePhpRoot && samePath(root, activePhpRoot))) throw new Error('Por segurança, a versão precisa estar dentro do XAMPP, do runtime ativo ou de runtimes/ do XAMPP Studio.');
  if (!fs.existsSync(path.join(root, 'php.exe'))) throw new Error('O runtime selecionado não contém php.exe.');
  return root;
}

function createPhpIniBackup(phpRoot, file) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(BACKUP_ROOT, `runtime-${timestamp}`);
  fs.mkdirSync(destination, { recursive: true });
  const target = path.join(destination, 'php.ini');
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  const manifest = {
    createdAt: new Date().toISOString(),
    kind: 'runtime-php-ini',
    phpRoot,
    files: [{ name: 'php.ini', source: file, target, bytes: fs.statSync(target).size, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') }]
  };
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}

const PHP_SETTING_GROUPS = [
  { id: 'errors', title: 'Erros e registros', items: [
    { key: 'display_errors', label: 'Mostrar erros na tela', description: 'Mostra erros durante o desenvolvimento. Desative em sites publicados.', type: 'boolean' },
    { key: 'display_startup_errors', label: 'Mostrar erros ao iniciar', description: 'Ajuda a encontrar problemas de configuração do PHP.', type: 'boolean' },
    { key: 'log_errors', label: 'Salvar erros em arquivo', description: 'Registra erros para consulta posterior sem depender da tela.', type: 'boolean' },
    { key: 'error_reporting', label: 'Nível de detalhes dos erros', description: 'Escolha quais tipos de aviso o PHP deve registrar.', type: 'choice', options: ['E_ALL', 'E_ALL & ~E_DEPRECATED', 'E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED'] },
    { key: 'error_log', label: 'Arquivo de registro', description: 'Local do arquivo em que o PHP guarda os erros.', type: 'path' }
  ]},
  { id: 'runtime', title: 'Execução e memória', items: [
    { key: 'memory_limit', label: 'Memória por execução', description: 'Memória máxima disponível para cada pedido PHP.', type: 'size', min: 8, max: 4096 },
    { key: 'max_execution_time', label: 'Tempo máximo de execução', description: 'Segundos antes de interromper um pedido PHP.', type: 'number', min: 0, max: 3600, suffix: 's' },
    { key: 'max_input_time', label: 'Tempo para receber dados', description: 'Tempo máximo para ler dados enviados ao PHP.', type: 'number', min: -1, max: 3600, suffix: 's' },
    { key: 'max_input_vars', label: 'Campos recebidos por pedido', description: 'Limite de campos em formulários e dados enviados.', type: 'number', min: 100, max: 100000 }
  ]},
  { id: 'uploads', title: 'Envio de arquivos', items: [
    { key: 'upload_max_filesize', label: 'Tamanho máximo do arquivo', description: 'Limite para cada arquivo enviado ao site.', type: 'size', min: 1, max: 2048 },
    { key: 'post_max_size', label: 'Tamanho máximo do envio', description: 'Limite total de cada formulário ou envio. Deve ser maior que o arquivo.', type: 'size', min: 1, max: 4096 }
  ]},
  { id: 'opcache', title: 'OPcache', description: 'Estas opções só têm efeito quando o módulo OPcache está presente e carregado neste PHP.', items: [
    { key: 'opcache.enable', label: 'Ativar OPcache', description: 'Guarda bytecode PHP em memória para acelerar páginas repetidas.', type: 'boolean' },
    { key: 'opcache.enable_cli', label: 'Usar OPcache no terminal', description: 'Aplica o cache também a comandos PHP executados no terminal.', type: 'boolean' },
    { key: 'opcache.memory_consumption', label: 'Memória do OPcache', description: 'Espaço reservado para guardar scripts compilados.', type: 'number', min: 8, max: 2048, suffix: 'MB' },
    { key: 'opcache.interned_strings_buffer', label: 'Memória para textos repetidos', description: 'Compartilha textos repetidos entre os scripts em cache.', type: 'number', min: 1, max: 256, suffix: 'MB' },
    { key: 'opcache.max_accelerated_files', label: 'Quantidade de scripts no cache', description: 'Número máximo de arquivos PHP que podem ficar em cache.', type: 'number', min: 1000, max: 1000000 },
    { key: 'opcache.validate_timestamps', label: 'Detectar alterações nos arquivos', description: 'Atualiza o cache quando você edita um arquivo PHP. Desative só se souber como limpar o cache.', type: 'boolean' }
  ]},
  { id: 'regional', title: 'Região e horário', items: [
    { key: 'date.timezone', label: 'Fuso horário', description: 'Define como datas e horários são interpretados pelo PHP.', type: 'timezone' }
  ]}
];

function iniSectionForKey(key) { return key.startsWith('opcache.') ? 'opcache' : ''; }
function readIniSetting(contents, key) {
  const section = iniSectionForKey(key);
  const name = section ? key.slice(section.length + 1) : key;
  let currentSection = '';
  let value = null;
  for (const line of contents.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) { currentSection = header[1].trim().toLowerCase(); continue; }
    const specialScope = /^(?:host|path)\s*=/i.test(currentSection);
    if ((section ? currentSection !== section : specialScope) || /^\s*[;#]/.test(line)) continue;
    const match = line.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    if (match && match[1].trim().toLowerCase() === name.toLowerCase()) value = match[2].replace(/^['"]|['"]$/g, '');
  }
  return value;
}

function setIniSetting(contents, key, value, targetSection = '') {
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  const section = targetSection.toLowerCase();
  const name = targetSection && key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const active = new RegExp(`^\\s*${escaped}\\s*=`, 'i');
  let currentSection = '';
  let sectionStart = -1;
  let sectionEnd = lines.length;
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[([^\]]+)\]/);
    if (header) {
      if (section && currentSection === section && sectionStart !== -1) { sectionEnd = i; break; }
      currentSection = header[1].trim().toLowerCase();
      if (currentSection === section && sectionStart === -1) sectionStart = i;
      continue;
    }
    const specialScope = /^(?:host|path)\s*=/i.test(currentSection);
    if ((!section ? !specialScope : currentSection === section) && active.test(lines[i])) { lines[i] = `${name} = ${value}`; found = true; }
  }
  if (sectionStart !== -1 && !found) {
    lines.splice(sectionEnd, 0, `${name} = ${value}`);
  } else if (sectionStart === -1 && section) {
    lines.push('', `[${section}]`, `${name} = ${value}`);
  } else if (!found) {
    const firstSection = lines.findIndex(line => /^\s*\[[^\]]+\]/.test(line));
    const insertion = firstSection < 0 ? lines.length : firstSection;
    lines.splice(insertion, 0, `${name} = ${value}`);
  }
  return `${lines.join('\r\n').replace(/[\r\n]*$/, '')}\r\n`;
}

function unsetIniSetting(contents, key, targetSection = '') {
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  const section = targetSection.toLowerCase();
  const active = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'i');
  let currentSection = '';
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[([^\]]+)\]/);
    if (header) { currentSection = header[1].trim().toLowerCase(); continue; }
    const specialScope = /^(?:host|path)\s*=/i.test(currentSection);
    if ((section ? currentSection !== section : specialScope) || /^\s*[;#]/.test(lines[i]) || !active.test(lines[i])) continue;
    lines[i] = `; XAMPP Studio desativou: ${lines[i].trim()}`;
    removed++;
  }
  return { contents: `${lines.join('\r\n').replace(/[\r\n]*$/, '')}\r\n`, removed };
}

function readPhpSettings(rawRoot) {
  const config = getConfig();
  const phpRoot = managedPhpRoot(rawRoot);
  const file = path.join(phpRoot, 'php.ini');
  if (!fs.existsSync(file)) throw new Error('O php.ini desta versão não foi encontrado.');
  let metadata = {};
  try { metadata = JSON.parse(readText(path.join(phpRoot, 'studio-runtime.json'))); } catch {}
  const contents = readText(file);
  return {
    phpRoot,
    phpVersion: metadata.version || (samePath(phpRoot, config.phpRoot) ? config.phpVersion : path.basename(phpRoot)),
    threadSafety: metadata.threadSafety || null,
    architecture: metadata.architecture || null,
    active: samePath(phpRoot, config.phpRoot),
    file,
    groups: PHP_SETTING_GROUPS.map(group => ({ ...group, items: group.items.map(item => {
      const value = readIniSetting(contents, item.key);
      const options = item.options ? [...item.options] : undefined;
      const currentOptionAdded = Boolean(options && value !== null && !options.includes(value));
      if (currentOptionAdded) options.unshift(value);
      return { ...item, value, ...(options ? { options, currentOptionAdded } : {}) };
    }) }))
  };
}

function validatePhpSettings(values, rawRoot) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Envie as opções PHP em formato válido.');
  const phpRoot = managedPhpRoot(rawRoot);
  const currentIni = readText(path.join(phpRoot, 'php.ini'));
  if (!currentIni) throw new Error('O php.ini desta versão não foi encontrado.');
  const known = new Map(PHP_SETTING_GROUPS.flatMap(group => group.items.map(item => [item.key, item])));
  const result = {};
  for (const [key, raw] of Object.entries(values)) {
    const item = known.get(key);
    if (!item) throw new Error(`A opção PHP “${key}” não pode ser alterada pelo Studio.`);
    if (item.type === 'boolean') {
      if (typeof raw !== 'boolean') throw new Error(`${item.label}: escolha ativado ou desativado.`);
      result[key] = raw ? 'On' : 'Off';
    } else if (item.type === 'choice') {
      if (!item.options.includes(raw) && String(raw) !== String(readIniSetting(currentIni, key)) && !/^\d{1,5}$/.test(String(raw))) throw new Error(`${item.label}: escolha uma opção da lista.`);
      if (/^\d+$/.test(String(raw)) && Number(raw) > 32767) throw new Error(`${item.label}: o nível numérico não é válido.`);
      result[key] = raw;
    } else if (item.type === 'number') {
      const number = Number(raw);
      if (!Number.isInteger(number) || number < item.min || number > item.max) throw new Error(`${item.label}: informe um número entre ${item.min} e ${item.max}.`);
      result[key] = String(number);
    } else if (item.type === 'size') {
      const match = String(raw).match(/^(\d{1,5})\s*(M|G)?$/i);
      if (!match) throw new Error(`${item.label}: informe um tamanho em MB, por exemplo 128M.`);
      const size = Number(match[1]) * (match[2]?.toUpperCase() === 'G' ? 1024 : 1);
      if (size < item.min || size > item.max) throw new Error(`${item.label}: o tamanho deve ficar entre ${item.min} MB e ${item.max} MB.`);
      result[key] = `${size}M`;
    } else if (item.type === 'timezone') {
      const zone = String(raw).trim();
      let valid = zone === 'UTC';
      try { valid ||= Intl.supportedValuesOf('timeZone').includes(zone); } catch {}
      if (!valid) throw new Error('Escolha um fuso horário reconhecido, como America/Sao_Paulo ou UTC.');
      result[key] = zone;
    } else if (item.type === 'path') {
      const target = path.resolve(String(raw || '').trim());
      if (!path.isAbsolute(target) || (!isInside(XAMPP_ROOT, target) && !isInside(APP_ROOT, target)) || (path.extname(target).toLowerCase() !== '.log' && path.basename(target).toLowerCase() !== 'php_error_log')) throw new Error('O arquivo de erros deve ser .log e ficar dentro da pasta do XAMPP Studio ou do XAMPP.');
      result[key] = `"${target.replace(/"/g, '')}"`;
    }
  }
  const effective = { upload_max_filesize: readIniSetting(currentIni, 'upload_max_filesize'), post_max_size: readIniSetting(currentIni, 'post_max_size'), ...values, ...result };
  const toMiB = value => { if (/^-1$|^0$/.test(String(value || '').trim())) return Infinity; const match = String(value || '').match(/^(\d+)\s*(K|M|G|T)?$/i); if (!match) return 0; const scale = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[String(match[2] || 'M').toUpperCase()]; return Number(match[1]) * scale; };
  if (effective.upload_max_filesize && effective.post_max_size && toMiB(effective.upload_max_filesize) > toMiB(effective.post_max_size)) throw new Error('O limite total do envio precisa ser igual ou maior que o limite de cada arquivo.');
  return result;
}

async function applyPhpSettings(values, rawRoot) {
  const phpRoot = managedPhpRoot(rawRoot);
  const updates = validatePhpSettings(values, phpRoot);
  if (!Object.keys(updates).length) throw new Error('Nenhuma alteração foi selecionada.');
  const config = getConfig();
  const active = samePath(phpRoot, config.phpRoot);
  const file = path.join(phpRoot, 'php.ini');
  const original = readText(file);
  if (!original) throw new Error('Não foi possível ler o php.ini desta versão.');
  const backup = active ? await createBackup() : createPhpIniBackup(phpRoot, file);
  let updated = original;
  for (const [key, value] of Object.entries(updates)) updated = setIniSetting(updated, key, value, iniSectionForKey(key));
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'error_log') fs.mkdirSync(path.dirname(path.resolve(value.replace(/^"|"$/g, ''))), { recursive: true });
    }
    writeAtomically(file, updated);
    const phpExe = path.join(phpRoot, 'php.exe');
    const keyJson = JSON.stringify(Object.keys(updates));
    const phpProbe = `$keys = json_decode('${keyJson}', true); $values = []; foreach ($keys as $key) { $values[$key] = ini_get($key); } echo "\\nXAMPP_STUDIO_INI:" . json_encode($values);`;
    const probeResult = await execFileAsync(phpExe, ['-c', file, '-r', phpProbe], { cwd: phpRoot, timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 });
    const probeMatch = probeResult.stdout.match(/XAMPP_STUDIO_INI:(\{[^\r\n]*\})/);
    if (!probeMatch) throw new Error('O PHP não retornou a leitura de validação do php.ini.');
    const loaded = JSON.parse(probeMatch[1]);
    const warnings = [];
    for (const [key, expected] of Object.entries(updates)) {
      const actual = String(loaded[key] ?? '');
      if (key.startsWith('opcache.') && (loaded[key] === false || !actual)) { warnings.push(`A opção ${key} foi salva, mas não aparece no PHP CLI; confirme se o módulo OPcache está instalado e carregado.`); continue; }
      if (key === 'error_reporting') continue;
      const isBoolean = PHP_SETTING_GROUPS.flatMap(group => group.items).find(item => item.key === key)?.type === 'boolean';
      const matches = isBoolean ? (expected === 'On' ? /^(?:1|on|true)$/i.test(actual) : /^(?:0|off|false)?$/i.test(actual)) : actual.toLowerCase() === expected.replace(/^"|"$/g, '').toLowerCase();
      if (!matches) throw new Error(`O PHP não carregou o valor selecionado para ${key}.`);
    }
    let apacheRestarted = false;
    if (active) {
      const apacheService = await inspectXamppService('apache');
      const apachePortActive = await checkPort(80);
      if (apacheService.registered && !apacheService.managed) throw new Error(apacheService.reason || 'O serviço Apache não está integrado ao XAMPP Studio.');
      if (apachePortActive && (!apacheService.managed || !apacheService.running)) throw new Error('A porta 80 está ocupada por uma instância fora do controle do Studio. Integre o serviço antes de aplicar.');
      if (apacheService.running && !apacheService.managed) {
        throw new Error('O Apache está ativo fora do controle do Studio. Integre o serviço antes de aplicar e reiniciar.');
      }
      if (apacheService.running) {
        const restarted = await restartXamppService('apache');
        if (!restarted.responding) throw new Error('O Apache reiniciou, mas a porta 80 não respondeu à validação.');
        apacheRestarted = true;
      }
    }
    return { file, phpRoot, active, backup: backup.createdAt, apacheRestarted, changed: Object.keys(updates), warnings };
  } catch (error) {
    writeAtomically(file, original);
    if (active) {
      const service = await inspectXamppService('apache').catch(() => null);
      if (service?.running && service.managed) await restartXamppService('apache').catch(() => {});
    }
    throw new Error(`${error.message} O php.ini anterior foi restaurado.`);
  }
}

function bounded(value, min, max) { return Math.max(min, Math.min(max, value)); }
function performanceLimits(apacheShare) {
  const ramMiB = Math.max(256, Math.floor(os.totalmem() / (1024 * 1024)));
  const cpus = Math.max(1, os.cpus().length);
  const serviceMemory = Math.floor(ramMiB * 0.8);
  const apacheMemory = Math.floor(serviceMemory * apacheShare / 100);
  const mysqlMemory = serviceMemory - apacheMemory;
  const threads = bounded(Math.round(cpus * 8 * (apacheShare / 50)), 8, 192);
  const phpMemory = bounded(Math.floor(Math.floor(apacheMemory / threads * 0.65) / 8) * 8, 16, 512);
  const mysqlBuffer = bounded(Math.floor(mysqlMemory * 0.5), 64, Math.max(64, Math.floor(ramMiB * 0.5)));
  const maxConnections = bounded(Math.floor(mysqlMemory * 0.25 / 8), 10, 500);
  return { totalMemoryMiB: ramMiB, logicalProcessors: cpus, reservedPercent: 20, apacheShare, mysqlShare: 100 - apacheShare, apacheMemoryMiB: apacheMemory, mysqlMemoryMiB: mysqlMemory, apacheThreads: threads, phpMemoryMiB: phpMemory, mysqlBufferPoolMiB: mysqlBuffer, mysqlConnections: maxConnections };
}

function getPerformanceSettings() {
  let state = {};
  try { state = JSON.parse(readText(PERFORMANCE_STATE)) || {}; } catch {}
  const apacheShare = bounded(Number(state.apacheShare) || 50, 20, 80);
  const apache = activeApacheRuntime();
  const mysql = activeMySqlRuntime();
  return { settings: performanceLimits(apacheShare), apacheRoot: apache.root, mysqlRoot: mysql.root, available: fs.existsSync(apache.config) && fs.existsSync(path.join(getConfig().phpRoot, 'php.ini')) && fs.existsSync(mysql.config) };
}

async function applyPerformanceSettings(rawShare) {
  const apacheShare = Number(rawShare);
  if (!Number.isInteger(apacheShare) || apacheShare < 20 || apacheShare > 80) throw new Error('Distribua o orçamento entre 20% e 80% para cada serviço.');
  if (apacheShare + (100 - apacheShare) !== 100) throw new Error('A distribuição de recursos não é válida.');
  if (process.platform !== 'win32') throw new Error('O ajuste automático de serviços está disponível somente no Windows.');
  const apache = activeApacheRuntime();
  const mysql = activeMySqlRuntime();
  const apacheConfig = apache.config;
  const phpConfig = path.join(getConfig().phpRoot, 'php.ini');
  const mysqlConfig = mysql.config;
  const mysqlExe = mysql.executable;
  const phpExe = path.join(getConfig().phpRoot, 'php.exe');
  if (!fs.existsSync(apacheConfig) || !fs.existsSync(phpConfig) || !fs.existsSync(phpExe) || !fs.existsSync(mysqlConfig) || !fs.existsSync(mysqlExe)) throw new Error('Não encontrei os arquivos de configuração PHP, Apache e MySQL do ambiente ativo.');
  const status = await scanStatus();
  const apacheServiceRunning = status.serviceControl.apache.managed && status.serviceControl.apache.running;
  const mysqlServiceRunning = status.serviceControl.mysql.managed && status.serviceControl.mysql.running;
  if (status.serviceControl.apache.registered && !status.serviceControl.apache.managed) throw new Error(status.serviceControl.apache.reason || 'O serviço Apache não está integrado ao XAMPP Studio.');
  if (status.serviceControl.mysql.registered && !status.serviceControl.mysql.managed) throw new Error(status.serviceControl.mysql.reason || 'O serviço MySQL não está integrado ao XAMPP Studio.');
  if (status.apache.running && !apacheServiceRunning) throw new Error('A porta 80 está ocupada por uma instância fora do controle do Studio. Integre o serviço antes de aplicar os ajustes.');
  if (status.mysql.running && !mysqlServiceRunning) throw new Error('A porta 3306 está ocupada por uma instância fora do controle do Studio. Integre o serviço antes de aplicar os ajustes.');
  if (status.serviceControl.apache.running && !status.serviceControl.apache.managed) throw new Error('O Apache está ativo fora do controle do Studio. Integre o serviço antes de aplicar os ajustes.');
  if (status.serviceControl.mysql.running && !status.serviceControl.mysql.managed) throw new Error('O MySQL está ativo fora do controle do Studio. Integre o serviço antes de aplicar os ajustes.');
  const limits = performanceLimits(apacheShare);
  const originalApache = readText(apacheConfig);
  const originalPhp = readText(phpConfig);
  const originalMysql = readText(mysqlConfig);
  const start = '# BEGIN XAMPP STUDIO PERFORMANCE';
  const end = '# END XAMPP STUDIO PERFORMANCE';
  const block = `${start}\n<IfModule mpm_winnt_module>\n    ThreadLimit ${limits.apacheThreads}\n    ThreadsPerChild ${limits.apacheThreads}\n</IfModule>\n${end}`;
  let updatedApache = originalApache;
  const markerStart = updatedApache.indexOf(start);
  const markerEnd = updatedApache.indexOf(end);
  if (markerStart >= 0 && markerEnd > markerStart) updatedApache = `${updatedApache.slice(0, markerStart)}${block}${updatedApache.slice(markerEnd + end.length)}`;
  else updatedApache = `${updatedApache.replace(/[\r\n]*$/, '')}\r\n\r\n${block}\r\n`;
  const updatedPhp = setIniSetting(originalPhp, 'memory_limit', `${limits.phpMemoryMiB}M`);
  let updatedMysql = setIniSetting(originalMysql, 'innodb_buffer_pool_size', `${limits.mysqlBufferPoolMiB}M`, 'mysqld');
  updatedMysql = setIniSetting(updatedMysql, 'max_connections', String(limits.mysqlConnections), 'mysqld');
  const backup = await createBackup();
  try {
    writeAtomically(apacheConfig, updatedApache);
    writeAtomically(phpConfig, updatedPhp);
    writeAtomically(mysqlConfig, updatedMysql);
    const apacheTest = await execFileAsync(apache.executable, ['-t', '-d', apache.root, '-f', apacheConfig], { cwd: apache.root, timeout: 12000, windowsHide: true, maxBuffer: 16 * 1024 });
    if (!/Syntax OK/i.test(`${apacheTest.stdout}\n${apacheTest.stderr}`)) throw new Error('O Apache não aceitou os novos limites.');
    const phpTest = await execFileAsync(phpExe, ['-r', 'echo ini_get("memory_limit");'], { cwd: path.dirname(phpExe), timeout: 5000, windowsHide: true, maxBuffer: 8192 });
    if (phpTest.stdout.trim().toUpperCase() !== `${limits.phpMemoryMiB}M`.toUpperCase()) throw new Error('O PHP não carregou o novo limite de memória.');
    const mysqlTest = await execFileAsync(mysqlExe, [`--defaults-file=${mysqlConfig}`, '--verbose', '--help'], { cwd: path.dirname(mysqlExe), timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    if (mysqlTest.code && mysqlTest.code !== 0) throw new Error('O MySQL não aceitou a nova configuração.');
    if (mysqlServiceRunning && !(await restartXamppService('mysql')).responding) throw new Error('O MySQL reiniciou, mas a porta 3306 não respondeu à validação.');
    if (apacheServiceRunning && !(await restartXamppService('apache')).responding) throw new Error('O Apache reiniciou, mas a porta 80 não respondeu à validação.');
    writeAtomically(PERFORMANCE_STATE, JSON.stringify({ apacheShare, mysqlShare: 100 - apacheShare, appliedAt: new Date().toISOString(), backup: backup.createdAt }, null, 2));
    return { settings: limits, backup: backup.createdAt, apacheRestarted: apacheServiceRunning, mysqlRestarted: mysqlServiceRunning };
  } catch (error) {
    writeAtomically(apacheConfig, originalApache);
    writeAtomically(phpConfig, originalPhp);
    writeAtomically(mysqlConfig, originalMysql);
    if (mysqlServiceRunning) await restartXamppService('mysql').catch(() => {});
    if (apacheServiceRunning) await restartXamppService('apache').catch(() => {});
    throw new Error(`${error.message} As configurações anteriores foram restauradas.`);
  }
}

let firewallProfileCache = null;

function windowsFirewallProfiles() {
  if (!firewallProfileCache || Date.now() >= firewallProfileCache.expires) {
    firewallProfileCache = {
      expires: Date.now() + 60000,
      result: runFirewallScript('log-profiles', [], 5000).then(
        result => Array.isArray(result.profiles) ? result.profiles : null,
        () => null
      )
    };
  }
  return firewallProfileCache.result;
}

async function firewallLogFiles() {
  const profiles = process.platform === 'win32' ? await windowsFirewallProfiles() : null;
  const folder = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'LogFiles', 'Firewall');
  const windowsFiles = profiles?.map(profile => profile.file).filter(file => typeof file === 'string' && path.isAbsolute(file)) || [];
  if (!windowsFiles.length && process.platform === 'win32') {
    windowsFiles.push(path.join(folder, 'pfirewall.log'));
    for (const profile of ['Domain', 'Private', 'Public']) {
      const file = path.join(folder, 'pfirewall_' + profile + '.log');
      if (fs.existsSync(file)) windowsFiles.push(file);
    }
  }
  return {
    ...logSources(activeApacheRuntime(), windowsFiles, BODY_CAPTURE_LOG),
    windowsLogging: profiles?.length ? profiles.some(profile => profile.allowed || profile.dropped) : null
  };
}

function phpSingleQuoted(value) { return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }

function requestBodyCapturePhpSource(logFile) {
  const target = phpSingleQuoted(logFile);
  return `<?php
/* XAMPP Studio filtered local request body capture. Enable explicitly in Firewall settings. */
if (PHP_SAPI === 'cli') { return; }
$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? ''));
if (!in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) { return; }
$contentType = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? ''));
$contentLength = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
$body = '[corpo não capturado]';
$safeRaw = '[corpo não capturado]';
$readBody = static function () { $stream = @fopen('php://input', 'rb'); return $stream ? fread($stream, 16385) : ''; };
if ($contentLength > 16384) {
  $body = '[omitido: corpo maior que 16 KB]';
  $safeRaw = $body;
} elseif (strpos($contentType, 'application/json') !== false || preg_match('/\\+json(?:;|$)/', $contentType)) {
  $input = $readBody();
  if (strlen($input) > 16384) { $body = '[omitido: corpo maior que 16 KB]'; $safeRaw = $body; }
  else {
  $decoded = json_decode((string)$input, true);
  if (json_last_error() === JSON_ERROR_NONE && is_array($decoded)) {
    $redact = function (&$value) use (&$redact) {
      if (!is_array($value)) { if (is_string($value) && strlen($value) > 1024) { $value = substr($value, 0, 1024) . ' [truncado]'; } return; }
      foreach ($value as $key => &$item) {
        if (preg_match('/pass(?:word)?|pwd|secret|token|api[_-]?key|auth|cookie|session|csrf|credential/i', (string)$key)) { $item = '[oculto]'; }
        else { $redact($item); }
      }
      unset($item);
    };
    $redact($decoded);
    $body = $decoded;
    $safeRaw = json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '[json omitido]';
  } else { $body = '[json inválido omitido]'; $safeRaw = $body; }
  }
} elseif (strpos($contentType, 'application/x-www-form-urlencoded') !== false) {
  $input = $readBody();
  if (strlen($input) > 16384) { $body = '[omitido: corpo maior que 16 KB]'; $safeRaw = $body; }
  else {
  $decoded = [];
  parse_str((string)$input, $decoded);
  $redact = function (&$value) use (&$redact) {
    if (!is_array($value)) { if (is_string($value) && strlen($value) > 1024) { $value = substr($value, 0, 1024) . ' [truncado]'; } return; }
    foreach ($value as $key => &$item) {
      if (preg_match('/pass(?:word)?|pwd|secret|token|api[_-]?key|auth|cookie|session|csrf|credential/i', (string)$key)) { $item = '[oculto]'; }
      else { $redact($item); }
    }
    unset($item);
  };
  $redact($decoded);
  $body = $decoded;
  $safeRaw = http_build_query($decoded, '', '&', PHP_QUERY_RFC3986);
  }
} elseif ($contentLength > 0) {
  $body = '[tipo de conteúdo não capturado]';
  $safeRaw = $body;
} else { return; }
$logFile = ${target};
register_shutdown_function(function () use ($logFile, $method, $body, $safeRaw, $contentType) {
  $folder = dirname($logFile);
  if (!is_dir($folder) && !@mkdir($folder, 0775, true) && !is_dir($folder)) { return; }
  if (is_file($logFile) && @filesize($logFile) > 5242880) { @unlink($logFile . '.1'); @rename($logFile, $logFile . '.1'); }
  $requestPath = parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
  $record = [
    'timestamp' => gmdate('c'),
    'ip' => (string)($_SERVER['REMOTE_ADDR'] ?? 'desconhecido'),
    'method' => $method,
    'path' => substr($requestPath, 0, 2048),
    'status' => http_response_code() ?: 200,
    'contentType' => $contentType,
    'body' => $body,
    'raw' => $safeRaw
  ];
  @file_put_contents($logFile, json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL, FILE_APPEND | LOCK_EX);
});
`;
}

function getBodyCaptureStatus() {
  const config = getConfig();
  const directive = readIniSetting(readText(path.join(config.phpRoot, 'php.ini')), 'auto_prepend_file');
  const enabled = Boolean(directive && path.resolve(directive.replace(/^['"]|['"]$/g, '')).toLowerCase() === path.resolve(BODY_CAPTURE_SCRIPT).toLowerCase());
  let bytes = 0;
  try { bytes = fs.statSync(BODY_CAPTURE_LOG).size; } catch {}
  return { active: enabled, pending: Boolean(firewallState().bodyCapture?.pending), script: BODY_CAPTURE_SCRIPT, logFile: BODY_CAPTURE_LOG, bytes, maxBodyBytes: 16384, supportedTypes: ['application/json', 'application/x-www-form-urlencoded'] };
}

async function setBodyCapture(enabled) {
  const config = getConfig();
  const phpIni = path.join(config.phpRoot, 'php.ini');
  const phpExe = path.join(config.phpRoot, 'php.exe');
  if (!fs.existsSync(phpIni) || !fs.existsSync(phpExe)) throw new Error('Não encontrei o PHP ativo para configurar a captura filtrada.');
  const original = readText(phpIni);
  if (!original) throw new Error('Não foi possível ler o php.ini ativo.');
  const configured = readIniSetting(original, 'auto_prepend_file');
  const currentPath = configured ? path.resolve(configured.replace(/^['"]|['"]$/g, '')).toLowerCase() : '';
  const capturePath = path.resolve(BODY_CAPTURE_SCRIPT).toLowerCase();
  const wasEnabled = currentPath === capturePath;
  if (enabled === wasEnabled) return { active: enabled, alreadySet: true, apacheRestarted: false };
  if (enabled && configured && !wasEnabled) throw new Error('O PHP já usa um arquivo automático de inicialização. Não vou substituí-lo; remova ou combine essa configuração manualmente primeiro.');
  if (!enabled && !wasEnabled) throw new Error('O arquivo automático de inicialização foi alterado fora do Studio; nenhuma configuração foi removida.');
  const state = firewallState();
  const previousState = state.bodyCapture;
  const backup = await createBackup();
  let scriptWasCreated = false;
  try {
    if (enabled) {
      if (fs.existsSync(BODY_CAPTURE_SCRIPT) && !readText(BODY_CAPTURE_SCRIPT).includes('XAMPP Studio filtered local request body capture')) throw new Error('Já existe um arquivo request-body-log.php que não pertence ao Studio. Não vou sobrescrevê-lo.');
      fs.mkdirSync(path.dirname(BODY_CAPTURE_LOG), { recursive: true });
      writeAtomically(BODY_CAPTURE_SCRIPT, requestBodyCapturePhpSource(BODY_CAPTURE_LOG));
      scriptWasCreated = true;
      const syntax = await execFileAsync(phpExe, ['-l', BODY_CAPTURE_SCRIPT], { cwd: config.phpRoot, timeout: 5000, windowsHide: true, maxBuffer: 8192 });
      if (!/No syntax errors detected/i.test(`${syntax.stdout}\n${syntax.stderr}`)) throw new Error('O PHP não validou o filtro de captura.');
      state.bodyCapture = { active: true, pending: true, enabledAt: new Date().toISOString(), logFile: BODY_CAPTURE_LOG };
      writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
      writeAtomically(phpIni, setIniSetting(original, 'auto_prepend_file', `"${BODY_CAPTURE_SCRIPT}"`));
    } else {
      state.bodyCapture = { ...(previousState || {}), active: false, pending: true };
      writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
      const removed = unsetIniSetting(original, 'auto_prepend_file');
      if (!removed.removed) throw new Error('Não encontrei a diretiva auto_prepend_file para remover com segurança.');
      writeAtomically(phpIni, removed.contents);
    }
    const probe = await execFileAsync(phpExe, ['-r', 'echo "XAMPP_STUDIO_PREPEND:" . ini_get("auto_prepend_file");'], { cwd: config.phpRoot, timeout: 5000, windowsHide: true, maxBuffer: 8192 });
    const actual = probe.stdout.match(/XAMPP_STUDIO_PREPEND:([^\r\n]*)/)?.[1]?.trim() || '';
    if (enabled ? path.resolve(actual).toLowerCase() !== capturePath : actual !== '') throw new Error('O PHP não carregou a configuração de captura esperada.');
    const apacheService = await inspectXamppService('apache');
    const apachePortActive = await checkPort(80);
    if (apacheService.registered && !apacheService.managed) throw new Error(apacheService.reason || 'O Apache não está integrado ao XAMPP Studio.');
    if (apachePortActive && (!apacheService.managed || !apacheService.running)) throw new Error('A porta 80 está ocupada por uma instância fora do controle do Studio. Integre o serviço antes de ativar a captura.');
    let apacheRestarted = false;
    if (apacheService.running) {
      if (!apacheService.managed) throw new Error('O Apache está ativo fora do controle do Studio.');
      const restarted = await restartXamppService('apache');
      if (!restarted.responding) throw new Error('O Apache reiniciou, mas a porta 80 não respondeu à validação.');
      apacheRestarted = true;
    }
    if (enabled) state.bodyCapture = { active: true, pending: false, enabledAt: new Date().toISOString(), logFile: BODY_CAPTURE_LOG };
    else { delete state.bodyCapture; fs.rmSync(BODY_CAPTURE_SCRIPT, { force: true }); }
    writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
    return { active: enabled, backup: backup.createdAt, apacheRestarted, logFile: BODY_CAPTURE_LOG };
  } catch (error) {
    writeAtomically(phpIni, original);
    if (previousState) state.bodyCapture = previousState; else delete state.bodyCapture;
    writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
    if (enabled && scriptWasCreated && !wasEnabled) fs.rmSync(BODY_CAPTURE_SCRIPT, { force: true });
    const service = await inspectXamppService('apache').catch(() => null);
    if (service?.running && service.managed) await restartXamppService('apache').catch(() => {});
    throw new Error(`${error.message} A configuração PHP anterior foi restaurada.`);
  }
}

function firewallState() {
  try { const value = JSON.parse(readText(FIREWALL_STATE)); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

function validateIp(value) {
  const ip = String(value || '').trim();
  if (net.isIP(ip) !== 4 && net.isIP(ip) !== 6) throw new Error('Informe um endereço IPv4 ou IPv6 válido, sem faixa CIDR.');
  return ip;
}

async function runFirewallScript(mode, args = [], timeout = 30000) {
  if (process.platform !== 'win32') throw new Error('O controle do Firewall do Windows está disponível somente no Windows.');
  const script = path.join(APP_ROOT, 'firewall.ps1');
  if (!fs.existsSync(script)) throw new Error('O módulo do Firewall do Windows não foi encontrado.');
  try {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode, ...args], { cwd: APP_ROOT, timeout, windowsHide: true, maxBuffer: 128 * 1024 });
    const output = (result.stdout || '').trim().split(/\r?\n/).at(-1) || '{}';
    return JSON.parse(output);
  } catch (error) {
    const details = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
    if (/access is denied|acesso negado|administrator|administrador|elevation/i.test(details)) throw new Error('O Windows exige permissão de administrador para alterar o Firewall. Feche o agente e abra start.ps1 -AsAdmin.');
    if (/CIM|MI Error|Management Infrastructure|recurso CIM/i.test(details)) throw new Error('O Windows não disponibilizou a consulta de regras do Firewall. Verifique se o Firewall do Windows está ativo e abra o Studio como administrador.');
    throw new Error(details.trim().slice(0, 700) || 'Não foi possível consultar o Firewall do Windows.');
  }
}

async function fetchCloudflareRanges() {
  const output = [];
  for (const version of ['v4', 'v6']) {
    const response = await fetch(`https://www.cloudflare.com/ips-${version}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Não foi possível consultar as faixas oficiais Cloudflare ${version.toUpperCase()} (HTTP ${response.status}).`);
    const lines = (await response.text()).trim().split(/\s+/).filter(Boolean);
    for (const cidr of lines) {
      const [address, prefixText] = cidr.split('/');
      const family = net.isIP(address);
      const prefix = Number(prefixText);
      if (family !== (version === 'v4' ? 4 : 6) || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw new Error('A lista oficial Cloudflare contém uma faixa inválida; nenhuma alteração foi feita.');
      output.push(cidr);
    }
    if (lines.length < 1) throw new Error(`A lista oficial Cloudflare ${version.toUpperCase()} está vazia.`);
  }
  return output;
}

async function cloudflarePreview() {
  const ranges = await fetchCloudflareRanges();
  const result = await runFirewallScript('preview');
  return { ...result, ranges, rangeCount: ranges.length, checkedAt: new Date().toISOString(), active: Boolean(firewallState().cloudflare?.active) };
}

async function setCloudflareRestriction(enable) {
  if (enable) {
    const preview = await cloudflarePreview();
    if (!preview.safeToApply) throw new Error('A prévia encontrou regras ou perfis que precisam de revisão. Nenhuma alteração foi feita.');
    const rangesBase64 = Buffer.from(JSON.stringify(preview.ranges), 'utf8').toString('base64');
    const state = firewallState();
    const previous = state.cloudflare;
    state.cloudflare = { ...(previous || {}), active: true, pending: true, appliedAt: previous?.appliedAt || new Date().toISOString(), ranges: previous?.ranges || preview.ranges, disabledRules: previous?.disabledRules?.length ? previous.disabledRules : preview.rulesToDisable || [] };
    writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
    try {
      const result = await runFirewallScript('enable', ['-RangesBase64', rangesBase64]);
      state.cloudflare = { active: true, pending: false, appliedAt: new Date().toISOString(), ranges: preview.ranges, createdRules: result.createdRules || [], disabledRules: previous?.disabledRules?.length ? previous.disabledRules : result.disabledRules || [] };
      writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
      return { ...result, active: true, rangeCount: preview.ranges.length };
    } catch (error) {
      if (previous) state.cloudflare = previous; else delete state.cloudflare;
      writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
      throw error;
    }
  }
  const state = firewallState();
  if (!state.cloudflare?.active) return { active: false, alreadyDisabled: true };
  const result = await runFirewallScript('disable', ['-DisabledRulesBase64', Buffer.from(JSON.stringify(state.cloudflare.disabledRules || []), 'utf8').toString('base64')]);
  delete state.cloudflare;
  writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
  return { ...result, active: false };
}

function managedBlockedIps() {
  const state = firewallState();
  return Object.entries(state.blockedIps || {}).map(([ip, entry]) => ({ ip, blockedAt: entry.blockedAt, ruleName: entry.ruleName }));
}

async function blockFirewallIp(rawIp) {
  const ip = validateIp(rawIp);
  const state = firewallState();
  state.blockedIps ||= {};
  const key = ip.toLowerCase();
  if (state.blockedIps[key]) return { ip, alreadyBlocked: true };
  const ruleName = `XAMPPStudio_Block_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
  state.blockedIps[key] = { ruleName, blockedAt: new Date().toISOString(), pending: true };
  writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
  let result;
  try { result = await runFirewallScript('block', ['-Ip', ip, '-RuleName', ruleName]); }
  catch (error) { delete state.blockedIps[key]; writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2)); throw error; }
  state.blockedIps[key].pending = false;
  writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
  return { ...result, ip, blockedAt: state.blockedIps[key].blockedAt };
}

async function unblockFirewallIp(rawIp) {
  const ip = validateIp(rawIp);
  const state = firewallState();
  const key = ip.toLowerCase();
  const entry = state.blockedIps?.[key];
  if (!entry) throw new Error('Este IP não está na lista de bloqueios criada pelo XAMPP Studio.');
  const result = await runFirewallScript('unblock', ['-RuleName', entry.ruleName]);
  delete state.blockedIps[key];
  writeAtomically(FIREWALL_STATE, JSON.stringify(state, null, 2));
  return { ...result, ip };
}

function compareVersions(left, right) {
  // O windows.php.net versiona reempacotamentos como "8.5.12-1"; o sufixo
  // é uma revisão do pacote e entra na comparação como quarta parte.
  const parse = value => {
    const match = String(value || '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(\d+))?/);
    return match ? match.slice(1).map(part => Number(part || 0)) : [];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function readPeArchitecture(executable) {
  const handle = fs.openSync(executable, 'r');
  try {
    const header = Buffer.alloc(4096);
    const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
    if (bytesRead < 256 || header.toString('ascii', 0, 2) !== 'MZ') throw new Error('O executável não tem cabeçalho PE reconhecível.');
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset + 6 > bytesRead || header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('Cabeçalho PE inválido.');
    const machine = header.readUInt16LE(peOffset + 4);
    if (machine === 0x8664) return 'Win64';
    if (machine === 0x014c) return 'Win32';
    throw new Error(`Arquitetura PE não suportada: 0x${machine.toString(16)}.`);
  } finally { fs.closeSync(handle); }
}

/**
 * Identifica o PHP local que serve de referência ao catálogo de versões.
 *
 * O catálogo só precisa da identidade do executável. O PHP sem php.ini
 * responde mesmo com extensões quebradas ou com Apache e MySQL parados.
 * Se o runtime sumiu, tenta o PHP original registrado e o incluído no XAMPP.
 */
async function resolveLocalPhpBaseline() {
  const { parseIniValue } = require('./lib/runtime-state.cjs');
  const environment = readEnvironmentState();
  const bundledRoot = path.join(XAMPP_ROOT, 'php');
  const properties = readText(path.join(XAMPP_ROOT, 'properties.ini'));
  const activeRoot = environment.phpRoot || parseIniValue(properties, 'php_binary_directory') || bundledRoot;
  const candidates = [
    { root: activeRoot, label: 'runtime ativo' },
    { root: environment.originalPhpRoot, label: 'PHP original do XAMPP' },
    { root: bundledRoot, label: 'PHP incluído no XAMPP' }
  ];
  const trustedRoots = [XAMPP_ROOT, path.join(APP_ROOT, 'runtimes'), environment.phpRoot, environment.originalPhpRoot]
    .filter(root => typeof root === 'string' && path.isAbsolute(root) && !/^[\\/]{2}/.test(root));
  const visited = new Set();
  for (const candidate of candidates) {
    if (typeof candidate.root !== 'string' || !path.isAbsolute(candidate.root)) continue;
    const root = path.resolve(candidate.root);
    const key = root.toLowerCase();
    const trustedRoot = trustedRoots.find(parent => isInside(parent, root));
    if (!trustedRoot || visited.has(key)) continue;
    visited.add(key);
    try {
      const executable = fs.realpathSync(path.join(root, 'php.exe'));
      if (!isInside(fs.realpathSync(trustedRoot), executable)) continue;
      const architecture = readPeArchitecture(executable);
      const probe = await execFileAsync(executable, ['-n', '-r', 'echo PHP_VERSION,"|",(PHP_ZTS?"TS":"NTS");'], { timeout: 3000, windowsHide: true, maxBuffer: 4096 });
      const identity = /^(\d+\.\d+\.\d+(?:(?:alpha|beta|RC)\d+|-dev)?)\|(TS|NTS)$/i.exec(probe.stdout.trim());
      if (!identity) continue;
      let version = identity[1];
      // PHP_VERSION não contém a revisão de um ZIP reempacotado (ex.: -1).
      let metadata = {};
      try { metadata = JSON.parse(readText(path.join(root, 'studio-runtime.json'))) || {}; } catch {}
      if (typeof metadata.version === 'string' && /^\d+\.\d+\.\d+-\d+$/.test(metadata.version) && metadata.version.split('-')[0] === version) {
        version = metadata.version;
      }
      return {
        version,
        threadSafety: identity[2].toUpperCase(),
        architecture: architecture === 'Win32' ? '32-bit' : '64-bit',
        root,
        source: candidate.label,
        warning: candidate === candidates[0] ? null : `Não consegui identificar o PHP ativo em ${activeRoot}. O catálogo usa o ${candidate.label} ${version}.`
      };
    } catch { /* candidato ausente ou não executável; tenta o próximo */ }
  }
  throw new Error(`Não consegui identificar um PHP para Windows x86 ou x64 em ${activeRoot} nem no PHP original do XAMPP. Confira o caminho da instalação e se o php.exe funciona.`);
}

async function listWindowsPhpReleases() {
  const baseline = await resolveLocalPhpBaseline();
  const current = baseline.version;
  const threadSafety = baseline.threadSafety === 'TS' ? 'ts' : 'nts';
  const architecture = baseline.architecture === '32-bit' ? 'x86' : 'x64';
  const releaseBase = 'https://downloads.php.net/~windows/releases/';
  const response = await fetch(`${releaseBase}releases.json`, {
    headers: { accept: 'application/json', 'user-agent': 'XAMPP-Studio/0.1' }, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`O catálogo oficial do PHP respondeu HTTP ${response.status}.`);
  const releases = await response.json();
  const versions = [];
  for (const [branch, release] of Object.entries(releases)) {
    const version = release?.version;
    if (!/^\d+\.\d+\.\d+(?:-\d+)?$/.test(version || '')) continue;
    const compared = compareVersions(version, current);
    const preRelease = /(?:alpha|beta|RC)\d+$|-dev$/i.test(current);
    if (compared < 0 || (compared === 0 && !preRelease)) continue;
    const variantEntry = Object.entries(release).find(([key]) => key.startsWith(`${threadSafety}-`) && key.endsWith(`-${architecture}`));
    const variant = variantEntry?.[1];
    if (!variant?.zip?.path || !/^[\w.-]+\.zip$/.test(variant.zip.path) || !/^[a-f0-9]{64}$/i.test(variant.zip.sha256 || '')) continue;
    versions.push({
      version, branch, threadSafety: threadSafety.toUpperCase(), architecture,
      compiler: variantEntry[0].match(/(?:vs|vc)\d+/i)?.[0].toUpperCase() || null,
      size: variant.zip.size, sha256: variant.zip.sha256,
      url: `${releaseBase}${variant.zip.path}`,
      source: 'PHP for Windows · oficial'
    });
  }
  versions.sort((a, b) => compareVersions(b.version, a.version));
  return {
    currentVersion: current,
    threadSafety: threadSafety.toUpperCase(),
    architecture,
    baseline: { root: baseline.root, source: baseline.source },
    warning: baseline.warning,
    versions,
    checkedAt: new Date().toISOString()
  };
}

async function listWindowsApacheReleases() {
  const active = activeApacheRuntime();
  const executable = active.executable;
  if (!fs.existsSync(executable)) throw new Error('Não encontrei apache/bin/httpd.exe no XAMPP configurado.');
  const currentOutput = await execFileAsync(executable, ['-v'], { timeout: 4000, windowsHide: true, maxBuffer: 4096 });
  const currentVersion = active.version || currentOutput.stdout.match(/Apache\/(\d+\.\d+\.\d+)/)?.[1];
  if (!currentVersion) throw new Error('Não consegui ler a versão do Apache atual.');
  const pageResponse = await fetch('https://www.apachelounge.com/download/', {
    headers: { 'user-agent': 'XAMPP-Studio/0.1' }, signal: AbortSignal.timeout(10000)
  });
  if (!pageResponse.ok) throw new Error(`Apache Lounge respondeu HTTP ${pageResponse.status}.`);
  const html = await pageResponse.text();
  const architecture = readPeArchitecture(executable);
  const candidates = new Map();
  const pattern = /href=["']([^"']*httpd-(\d+\.\d+\.\d+)-(\d+)-(Win32|Win64)-(VS\d+)\.zip)["']/gi;
  for (const match of html.matchAll(pattern)) {
    if (match[4] !== architecture || compareVersions(match[2], currentVersion) <= 0) continue;
    const download = new URL(match[1].replace(/&amp;/g, '&'), 'https://www.apachelounge.com');
    if (download.hostname !== 'www.apachelounge.com' || !download.pathname.startsWith('/download/')) continue;
    const filename = path.posix.basename(download.pathname);
    const checksum = new URL(`${download.pathname}.txt`, download.origin);
    candidates.set(match[2], { version: match[2], build: match[3], compiler: match[5], architecture, filename, url: download.href, checksumUrl: checksum.href, source: 'Apache Lounge · fornecedor terceiro referenciado pelo Apache HTTP Server' });
  }
  return { currentVersion, versions: [...candidates.values()].sort((a, b) => compareVersions(b.version, a.version)), checkedAt: new Date().toISOString(), source: 'Apache Lounge (binários Windows de terceiros)' };
}

async function downloadWindowsApacheRuntime(version, build) {
  const catalog = await listWindowsApacheReleases();
  const release = catalog.versions.find(item => item.version === version && item.build === build);
  if (!release) throw new Error('Esse build não consta na lista atual do fornecedor Windows. Atualize a lista e tente novamente.');
  const runtimeName = `apache-${release.version}-${release.build}-${release.architecture.toLowerCase()}`;
  const targetRoot = path.join(APP_ROOT, 'runtimes', runtimeName);
  if (fs.existsSync(targetRoot)) {
    const metadata = JSON.parse(readText(path.join(targetRoot, 'xampp-studio-runtime.json')));
    return { ...metadata, root: targetRoot, configured: false, alreadyPrepared: true };
  }
  const checksumResponse = await fetch(release.checksumUrl, { headers: { 'user-agent': 'XAMPP-Studio/0.1' }, signal: AbortSignal.timeout(10000) });
  if (!checksumResponse.ok) throw new Error('Não consegui obter o arquivo de checksums do fornecedor.');
  const checksumText = await checksumResponse.text();
  const checksumLines = checksumText.split(/\r?\n/);
  const checksumLine = checksumLines.findIndex(line => line.trim().toLowerCase() === `sha256-checksum for: ${release.filename.toLowerCase()}:`);
  const checksum = checksumLine >= 0 ? checksumLines[checksumLine + 1]?.trim() : null;
  if (!checksum) throw new Error('O fornecedor não publicou SHA-256 reconhecível para esse pacote.');
  const response = await fetch(release.url, { headers: { 'user-agent': 'XAMPP-Studio/0.1' }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`O download do Apache falhou (HTTP ${response.status}).`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length < 5 * 1024 * 1024 || archive.length > 250 * 1024 * 1024) throw new Error('Tamanho inesperado para o pacote Apache.');
  const actualHash = createHash('sha256').update(archive).digest('hex');
  if (actualHash.toLowerCase() !== checksum.toLowerCase()) throw new Error('O SHA-256 do Apache não confere com o checksum publicado pelo fornecedor.');
  const runtimeParent = path.join(APP_ROOT, 'runtimes');
  const downloadRoot = path.join(APP_ROOT, 'downloads');
  const archivePath = path.join(downloadRoot, `${runtimeName}-${process.pid}-${Date.now()}.zip`);
  const stagingRoot = path.join(runtimeParent, `.staging-${process.pid}-${Date.now()}`);
  fs.mkdirSync(downloadRoot, { recursive: true });
  fs.mkdirSync(runtimeParent, { recursive: true });
  try {
    fs.writeFileSync(archivePath, archive, { flag: 'wx' });
    const listing = await execFileAsync('tar', ['-tf', archivePath], { timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.length > 30000 || entries.some(entry => path.isAbsolute(entry) || entry.split(/[\\/]/).some(part => part === '..'))) throw new Error('O pacote Apache contém caminhos de extração inválidos.');
    fs.mkdirSync(stagingRoot, { recursive: false });
    await execFileAsync('tar', ['-xf', archivePath, '-C', stagingRoot], { timeout: 90000, windowsHide: true, maxBuffer: 32 * 1024 });
    const findHttpd = directory => {
      if (fs.existsSync(path.join(directory, 'bin', 'httpd.exe'))) return directory;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) {
        const nested = findHttpd(path.join(directory, entry.name));
        if (nested) return nested;
      }
      return null;
    };
    const extractedRoot = findHttpd(stagingRoot);
    if (!extractedRoot) throw new Error('O ZIP não contém bin/httpd.exe.');
    const versionOutput = await execFileAsync(path.join(extractedRoot, 'bin', 'httpd.exe'), ['-v'], { timeout: 5000, windowsHide: true, maxBuffer: 4096 });
    const extractedVersion = versionOutput.stdout.match(/Apache\/(\d+\.\d+\.\d+)/)?.[1];
    if (extractedVersion !== release.version) throw new Error('O executável extraído não corresponde à versão escolhida.');
    const metadata = { version: release.version, build: release.build, compiler: release.compiler, architecture: release.architecture, source: release.url, checksumUrl: release.checksumUrl, sha256: actualHash, preparedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(extractedRoot, 'xampp-studio-runtime.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' });
    fs.renameSync(extractedRoot, targetRoot);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    return { ...metadata, root: targetRoot, configured: false };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

function listPreparedApacheRuntimes() {
  const root = path.join(APP_ROOT, 'runtimes');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('apache-')).flatMap(entry => {
    const runtimeRoot = path.join(root, entry.name);
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'xampp-studio-runtime.json'), 'utf8'));
      return [{ ...metadata, root: runtimeRoot, configured: false }];
    } catch { return []; }
  }).sort((a, b) => compareVersions(b.version, a.version));
}

function listPreparedMySqlRuntimes() {
  const root = path.join(APP_ROOT, 'runtimes');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^(?:mysql|mariadb)-/i.test(entry.name))
    .flatMap(entry => {
      const runtimeRoot = path.join(root, entry.name);
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'studio-runtime.json'), 'utf8'));
        if (metadata.component !== 'mysql') return [];
        return [{
          ...metadata,
          root: runtimeRoot,
          executable: path.join(runtimeRoot, 'bin', 'mysqld.exe'),
          config: path.join(runtimeRoot, 'my.ini'),
          initialized: fs.existsSync(path.join(metadata.dataDirectory || '', 'mysql')) || fs.existsSync(path.join(metadata.dataDirectory || '', 'aria_log_control'))
        }];
      } catch { return []; }
    })
    .sort((left, right) => compareVersions(right.version, left.version));
}

function mysqlConfigText(runtimeRoot, dataDirectory) {
  const runtimePath = runtimeRoot.replace(/\\/g, '/');
  const dataPath = dataDirectory.replace(/\\/g, '/');
  const logDirectory = path.join(WORKSPACE_ROOT, 'mysql', 'logs').replace(/\\/g, '/');
  const secureDirectory = path.join(WORKSPACE_ROOT, 'mysql', 'secure').replace(/\\/g, '/');
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.mkdirSync(secureDirectory, { recursive: true });
  return [
    '[mysqld]',
    `basedir="${runtimePath}"`,
    `datadir="${dataPath}"`,
    'port=3306',
    'bind-address=127.0.0.1',
    'character-set-server=utf8mb4',
    'collation-server=utf8mb4_unicode_ci',
    'skip-name-resolve',
    `secure-file-priv="${secureDirectory}"`,
    `log-error="${logDirectory}/mysql-error.log"`,
    '',
    '[client]',
    'port=3306',
    'host=127.0.0.1',
    'default-character-set=utf8mb4',
    ''
  ].join('\r\n');
}

function writeDatabaseCredentials(release, password) {
  const directory = path.join(WORKSPACE_ROOT, 'mysql', 'credentials');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${release.id}.json`);
  const payload = {
    product: release.product,
    version: release.version,
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password,
    createdAt: new Date().toISOString()
  };
  writeAtomically(file, JSON.stringify(payload, null, 2));
  try { fs.chmodSync(file, 0o600); } catch {}
  if (process.platform === 'win32') {
    try {
      const user = os.userInfo().username;
      execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `${user}:(R,W)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'], { timeout: 8000, windowsHide: true, stdio: 'ignore' });
    } catch {}
  }
  return file;
}

async function initializeMySqlData(runtime, release, job) {
  const dataDirectory = runtime.dataDirectory;
  fs.mkdirSync(dataDirectory, { recursive: true });
  const existing = fs.readdirSync(dataDirectory);
  if (existing.length) {
    job.step('database', 'succeeded', 'Diretório de dados já existe; a inicialização foi preservada.');
    return null;
  }
  const password = randomBytes(24).toString('base64url');
  if (release.product === 'mysql') {
    const initFile = path.join(runtime.root, 'initialize-root.sql');
    const sql = [
      `ALTER USER 'root'@'localhost' IDENTIFIED BY '${password}';`,
      `CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '${password}';`,
      `ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY '${password}';`,
      "GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;",
      'FLUSH PRIVILEGES;',
      ''
    ].join('\r\n');
    fs.writeFileSync(initFile, sql, { flag: 'wx' });
    try {
      await execFileAsync(runtime.executable, ['--initialize', `--defaults-file=${runtime.config}`, `--init-file=${initFile}`, '--console'], {
        cwd: path.dirname(runtime.executable), timeout: 180000, windowsHide: true, maxBuffer: 64 * 1024
      });
    } finally {
      fs.rmSync(initFile, { force: true });
    }
  } else {
    const installer = findFileByName(path.dirname(runtime.executable), name => /^(?:mysql_install_db|mariadb-install-db)\.exe$/i.test(name));
    if (!installer) throw new Error('O pacote MariaDB não inclui mysql_install_db.exe; o diretório de dados não foi inicializado.');
    await execFileAsync(installer, [`--datadir=${dataDirectory}`, `--password=${password}`, '--port=3306'], {
      cwd: path.dirname(installer), timeout: 180000, windowsHide: true, maxBuffer: 64 * 1024
    });
  }
  const credentials = writeDatabaseCredentials(release, password);
  job.step('database', 'succeeded', `Diretório isolado inicializado; credenciais protegidas em ${credentials}.`);
  return credentials;
}

async function downloadWindowsDatabaseRuntime(releaseId, job) {
  job.step('catalog', 'running', 'Consultando os catálogos oficiais MySQL e MariaDB.');
  const catalog = await listDatabaseReleases({ limit: 8 });
  const release = catalog.releases.find(item => item.id === releaseId);
  if (!release) throw new Error('Essa versão não está mais no catálogo oficial. Atualize a lista e tente novamente.');
  job.step('catalog', 'succeeded', `${release.label} selecionado.`);

  const targetRoot = path.join(APP_ROOT, 'runtimes', release.id);
  if (fs.existsSync(targetRoot)) {
    const metadata = JSON.parse(readText(path.join(targetRoot, 'studio-runtime.json')));
    job.step('download', 'succeeded', `${release.label} já está preparado.`);
    return {
      ...metadata,
      root: targetRoot,
      executable: path.join(targetRoot, 'bin', 'mysqld.exe'),
      config: path.join(targetRoot, 'my.ini'),
      configured: true,
      initialized: fs.existsSync(path.join(metadata.dataDirectory || '', 'mysql')) || fs.existsSync(path.join(metadata.dataDirectory || '', 'aria_log_control')),
      credentialsPath: metadata.credentialsPath || null,
      alreadyPrepared: true
    };
  }
  if (!release.checksum?.value) throw new Error('A fonte oficial não publicou checksum para este pacote; o download foi cancelado.');

  job.step('download', 'running', 'Baixando o pacote Windows oficial.');
  const response = await fetch(release.url, {
    headers: { accept: 'application/zip', 'user-agent': 'XAMPP-Studio/0.2' },
    signal: AbortSignal.timeout(300000)
  });
  if (!response.ok) throw new Error(`O download do banco falhou (HTTP ${response.status}).`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length < 5 * 1024 * 1024 || archive.length > 700 * 1024 * 1024) throw new Error('Tamanho inesperado para o pacote do banco de dados.');
  const actualChecksum = createHash(release.checksum.algorithm).update(archive).digest('hex');
  if (actualChecksum.toLowerCase() !== release.checksum.value.toLowerCase()) throw new Error(`O checksum ${release.checksum.algorithm.toUpperCase()} do pacote não confere com a fonte oficial.`);
  job.step('download', 'succeeded', `${(archive.length / 1024 / 1024).toFixed(1)} MB · checksum ${release.checksum.algorithm.toUpperCase()} conferido.`);

  job.step('extract', 'running', 'Validando e extraindo o pacote.');
  const archivePath = path.join(APP_ROOT, 'downloads', `${release.id}-${process.pid}-${Date.now()}.zip`);
  const stagingRoot = path.join(APP_ROOT, 'runtimes', `.staging-db-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.mkdirSync(path.dirname(stagingRoot), { recursive: true });
  try {
    fs.writeFileSync(archivePath, archive, { flag: 'wx' });
    const listing = await execFileAsync('tar', ['-tf', archivePath], { timeout: 40000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.length > 50000 || entries.some(entry => path.isAbsolute(entry) || entry.split(/[\\/]/).some(part => part === '..'))) throw new Error('O pacote do banco contém caminhos de extração inválidos.');
    fs.mkdirSync(stagingRoot, { recursive: false });
    await execFileAsync('tar', ['-xf', archivePath, '-C', stagingRoot], { timeout: 240000, windowsHide: true, maxBuffer: 64 * 1024 });
    const extractedRoot = findFileByName(stagingRoot, name => name.toLowerCase() === 'mysqld.exe') ? path.dirname(path.dirname(findFileByName(stagingRoot, name => name.toLowerCase() === 'mysqld.exe'))) : null;
    if (!extractedRoot) throw new Error('O ZIP não contém bin/mysqld.exe.');
    const dataDirectory = path.join(WORKSPACE_ROOT, 'mysql', 'data', release.id);
    const metadata = {
      component: 'mysql',
      product: release.product,
      version: release.version,
      architecture: 'Win64',
      channel: release.channel,
      source: release.url,
      sourcePage: release.sourceUrl,
      signatureUrl: release.signatureUrl,
      checksum: release.checksum,
      sha256: createHash('sha256').update(archive).digest('hex'),
      dataDirectory,
      preparedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(extractedRoot, 'studio-runtime.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' });
    fs.renameSync(extractedRoot, targetRoot);
    fs.writeFileSync(path.join(targetRoot, 'my.ini'), mysqlConfigText(targetRoot, dataDirectory), { flag: 'wx' });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    const runtime = { ...metadata, root: targetRoot, executable: path.join(targetRoot, 'bin', 'mysqld.exe'), config: path.join(targetRoot, 'my.ini') };
    job.step('extract', 'succeeded', `Runtime preparado em ${targetRoot}.`);

    job.step('database', 'running', 'Inicializando um diretório de dados isolado e local.');
    const credentialsPath = await initializeMySqlData(runtime, release, job);
    if (credentialsPath) {
      const metadataFile = path.join(targetRoot, 'studio-runtime.json');
      const persisted = JSON.parse(readText(metadataFile));
      persisted.credentialsPath = credentialsPath;
      writeAtomically(metadataFile, JSON.stringify(persisted, null, 2));
    }
    return { ...runtime, configured: true, initialized: true, credentialsPath };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

async function switchMySqlRuntime(mysqlRoot) {
  if (process.platform !== 'win32') throw new Error('A ativação integrada só está disponível no Windows.');
  const runtime = listPreparedMySqlRuntimes().find(item => samePath(item.root, path.resolve(mysqlRoot)));
  if (!runtime) throw new Error('Esse runtime de banco de dados não foi preparado pelo XAMPP Studio.');
  if (!fs.existsSync(runtime.executable) || !fs.existsSync(runtime.config)) throw new Error('O runtime selecionado não contém mysqld.exe ou my.ini.');

  const oldState = readEnvironmentState();
  let service = await inspectXamppService('mysql');
  const serviceName = service.serviceName;
  const nextState = {
    ...oldState,
    mysqlRoot: runtime.root,
    mysqlConfig: runtime.config,
    mysqlVersion: runtime.version,
    mysqlProduct: runtime.product,
    mysqlServiceName: serviceName
  };
  const nextCommand = `"${runtime.executable}" --defaults-file="${runtime.config}"`;
  let priorCommand = null;
  let stopped = false;
  let serviceChanged = false;
  let serviceCreated = false;

  try {
    if (service.registered === false) {
      const ownership = await portOwnership(3306, 'mysql');
      const portAlreadyActive = ownership.active;
      await runWindowsServiceHelper('integrate-mysql', {
        serviceName,
        executable: runtime.executable,
        config: runtime.config,
        startAfterInstall: !portAlreadyActive
      });
      serviceCreated = true;
      writeEnvironmentState(nextState);
      service = await inspectXamppService('mysql');
      if (!service.managed) throw new Error(service.reason || 'O serviço do banco foi registrado, mas não aponta para o runtime selecionado.');

      if (portAlreadyActive) {
        return {
          component: 'mysql',
          product: runtime.product,
          version: runtime.version,
          root: runtime.root,
          dataDirectory: runtime.dataDirectory,
          serviceName,
          restarted: false,
          responding: true,
          migrationRequired: ownership.managed,
          portConflict: !ownership.managed,
          portSummary: ownership.summary
        };
      }

      await waitForXamppService('mysql', 4, 45000);
      const responding = await waitForPort(3306, 30000);
      if (!responding) throw new Error('O serviço do banco iniciou, mas a porta 3306 não respondeu. O registro será revertido.');
      return {
        component: 'mysql',
        product: runtime.product,
        version: runtime.version,
        root: runtime.root,
        dataDirectory: runtime.dataDirectory,
        serviceName,
        restarted: true,
        responding: true,
        migrationRequired: false
      };
    }

    if (!service.managed) throw new Error(service.reason || 'Primeiro integre o serviço MySQL/MariaDB ao Studio na página Serviços.');
    if (![1, 4].includes(service.state)) throw new Error(`O banco está em uma transição do Windows (estado ${service.state}); aguarde e tente novamente.`);
    if (service.state === 1) {
      const ownership = await portOwnership(3306, 'mysql');
      if (ownership.active && ownership.managed) throw new Error('A porta 3306 ainda pertence a uma instância do runtime integrado. Pare essa instância uma vez para concluir a migração.');
      if (ownership.active) throw new Error(`A porta 3306 está ocupada por ${ownership.summary || 'outro processo'} e não pelo XAMPP Studio. Libere a porta antes de ativar o runtime.`);
    }

    const scConfig = await execFileAsync('sc.exe', ['qc', serviceName], { timeout: 5000, windowsHide: true, maxBuffer: 8192 });
    priorCommand = serviceCommandFromOutput(scConfig.stdout);
    if (!priorCommand) throw new Error('Não consegui guardar o comando do serviço do banco para permitir a reversão.');

    if (service.state === 4) {
      await runWindowsServiceAction('stop', serviceName);
      await waitForXamppService('mysql', 1, 30000);
      stopped = true;
    }
    writeEnvironmentState(nextState);
    await changeServiceCommand(serviceName, nextCommand);
    serviceChanged = true;
    if (stopped) {
      await runWindowsServiceAction('start', serviceName);
      await waitForXamppService('mysql', 4, 45000);
      const responding = await waitForPort(3306, 30000);
      if (!responding) throw new Error('O serviço do banco iniciou, mas a porta 3306 não respondeu. O runtime anterior será restaurado.');
    }
    return {
      component: 'mysql',
      product: runtime.product,
      version: runtime.version,
      root: runtime.root,
      dataDirectory: runtime.dataDirectory,
      serviceName,
      restarted: stopped,
      responding: stopped ? true : await checkPort(3306),
      migrationRequired: false
    };
  } catch (error) {
    if (serviceChanged && priorCommand) {
      try { await changeServiceCommand(serviceName, priorCommand); } catch {}
    }
    if (serviceCreated) {
      try { await runWindowsServiceAction('delete', serviceName); } catch {}
    }
    writeEnvironmentState(oldState);
    if (stopped) {
      try {
        await runWindowsServiceAction('start', serviceName);
        await waitForXamppService('mysql', 4, 45000);
      } catch {}
    }
    throw error;
  }
}

function existingFile(candidates) {
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

function findRuntimeDll(root, dll) {
  return existingFile([path.join(root, 'ext', dll), path.join(root, dll)]);
}

function findRuntimeDllByPattern(root, pattern) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && pattern.test(entry.name)) return path.join(root, entry.name);
  }
  return null;
}

function collectDllRegistry() {
  const config = getConfig();
  const entries = new Map();
  const add = entry => {
    const key = `${entry.kind}:${String(entry.dll).toLowerCase()}`;
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, { ...entry, required: true, sources: [...new Set(entry.sources || [])] });
      return;
    }
    existing.sources = [...new Set([...existing.sources, ...(entry.sources || [])])];
    existing.present = existing.present || entry.present;
    existing.path = existing.path || entry.path;
  };

  for (const directive of phpExtensionDirectives(readText(activePhpIni(config)))) {
    const file = findRuntimeDll(config.phpRoot, directive.dll);
    add({ name: directive.name, dll: directive.dll, kind: 'php_extension', directive: directive.directive, present: Boolean(file), path: file, sources: ['php.ini'] });
  }

  for (const line of readText(config.apacheConf).split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line)) continue;
    const module = line.match(/^\s*LoadModule\s+php_module\s+(?:"([^"]+)"|([^\s]+))/i);
    if (module) {
      const modulePath = findRuntimeDllByPattern(config.phpRoot, /^php\d*apache2_4\.dll$/i);
      add({ name: 'php_module', dll: path.basename((module[1] || module[2]).replace(/\\/g, '/')), kind: 'apache_module', directive: 'loadmodule', present: Boolean(modulePath), path: modulePath, sources: ['httpd-xampp.conf'] });
      continue;
    }
    const load = line.match(/^\s*LoadFile\s+(?:"([^"]+)"|([^\s]+))/i);
    if (!load) continue;
    const dll = path.basename((load[1] || load[2]).replace(/\\/g, '/'));
    if (!/\.dll$/i.test(dll)) continue;
    const kind = /^php\d*ts\.dll$/i.test(dll) ? 'php_thread_safe' : 'apache_load_file';
    const file = existingFile([path.join(config.phpRoot, dll), path.join(config.phpRoot, 'ext', dll)]);
    add({ name: dll.replace(/\.dll$/i, ''), dll, kind, directive: 'loadfile', present: Boolean(file), path: file, sources: ['httpd-xampp.conf'] });
  }

  return {
    version: 1,
    phpVersion: config.phpVersion,
    phpRoot: config.phpRoot,
    apacheConfig: config.apacheConf,
    dlls: [...entries.values()],
    checkedAt: new Date().toISOString()
  };
}

function readDllRegistry() {
  try {
    const value = JSON.parse(readText(DLL_REGISTRY));
    return value && Array.isArray(value.dlls) ? value : null;
  } catch { return null; }
}

function persistDllRegistry(registry = collectDllRegistry()) {
  const previous = readDllRegistry();
  const now = new Date().toISOString();
  const next = { ...registry, createdAt: previous?.createdAt || now, updatedAt: now };
  writeAtomically(DLL_REGISTRY, JSON.stringify(next, null, 2));
  return next;
}

function syncDllRegistry() {
  const current = collectDllRegistry();
  const previous = readDllRegistry();
  if (previous && JSON.stringify(previous.dlls) === JSON.stringify(current.dlls) && previous.phpRoot === current.phpRoot) return previous;
  return persistDllRegistry(current);
}

function currentDllRegistry() {
  const current = collectDllRegistry();
  return current.dlls.length ? current : readDllRegistry() || current;
}

function runtimeDllFiles(root) {
  const files = [];
  for (const directory of [root, path.join(root, 'ext')]) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && /\.dll$/i.test(entry.name)) files.push({ name: entry.name, path: path.join(directory, entry.name), area: path.basename(directory) });
    }
  }
  return files;
}

function verifyRuntimeDlls(root, requiredDlls = currentDllRegistry().dlls, version) {
  const resolved = path.resolve(root);
  if (!version && requiredDlls.some(item => item.dll?.toLowerCase() === 'php_opcache.dll')) {
    try { version = JSON.parse(readText(path.join(resolved, 'studio-runtime.json'))).version; } catch {}
  }
  const files = runtimeDllFiles(resolved);
  const byName = new Map(files.map(item => [item.name.toLowerCase(), item]));
  const present = [];
  const missing = [];
  for (const required of requiredDlls) {
    let found = null;
    if (required.kind === 'apache_module') found = files.find(item => /^php\d*apache2_4\.dll$/i.test(item.name)) || null;
    else if (required.kind === 'php_thread_safe') found = files.find(item => /^php\d*ts\.dll$/i.test(item.name)) || null;
    else found = byName.get(String(required.dll).toLowerCase()) || null;
    const builtIn = required.kind === 'php_extension' && isBuiltinOpcache(required.dll, version);
    const detail = {
      name: required.name,
      dll: required.dll,
      kind: required.kind,
      sources: required.sources || [],
      found: builtIn || Boolean(found),
      builtIn,
      path: builtIn ? null : found?.path || null
    };
    if (detail.found) present.push(detail); else missing.push(detail);
  }
  return {
    compatible: missing.length === 0,
    phpRoot: resolved,
    required: requiredDlls.length,
    present: present.length,
    missing,
    details: [...present, ...missing],
    checkedAt: new Date().toISOString()
  };
}

const PECL_VERSION_CACHE = new Map();

function peclPackageFromDll(dll) { return extensionName(dll); }

function phpBuildTarget(phpRoot) {
  let metadata = {};
  try { metadata = JSON.parse(readText(path.join(phpRoot, 'studio-runtime.json'))); } catch {}
  const names = fs.existsSync(phpRoot) ? fs.readdirSync(phpRoot) : [];
  const version = metadata.version || getVersions().find(item => samePath(item.root, phpRoot))?.version;
  if (!version) throw new Error('Não foi possível identificar a versão do runtime PHP.');
  const rawThreadSafety = String(metadata.threadSafety || '').toUpperCase();
  const threadSafety = rawThreadSafety === 'TS' || rawThreadSafety === 'THREAD SAFE'
    ? 'ts'
    : rawThreadSafety
      ? 'nts'
      : (names.some(name => /^php\d+ts\.dll$/i.test(name)) ? 'ts' : 'nts');
  let architecture = metadata.architecture;
  if (!architecture) {
    try { architecture = readPeArchitecture(path.join(phpRoot, 'php.exe')); } catch {}
  }
  const rawArchitecture = String(architecture || '').toLowerCase();
  const compiler = metadata.compiler || (compareVersions(version, '8.4.0') >= 0 ? 'VS17' : compareVersions(version, '8.0.0') >= 0 ? 'VS16' : 'VC15');
  return {
    root: phpRoot,
    version,
    phpMinor: version.match(/^(\d+\.\d+)/)?.[1] || version,
    threadSafety,
    architecture: rawArchitecture.includes('64') ? 'x64' : (rawArchitecture.includes('32') || rawArchitecture === 'x86') ? 'x86' : null,
    compiler: String(compiler).toUpperCase()
  };
}

async function searchPeclVersions(rawRoot, rawDll, rawPackage, refresh = false) {
  const phpRoot = managedPhpRoot(rawRoot);
  const target = phpBuildTarget(phpRoot);
  const packageName = rawPackage ? peclPackageFromDll(rawPackage) : peclPackageFromDll(rawDll);
  const cacheKey = `${packageName}|${target.version}|${target.threadSafety}|${target.architecture}|${target.compiler}`;
  const cached = PECL_VERSION_CACHE.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.at < 5 * 60 * 1000) return { ...cached.value, target };
  const packageUrl = `https://pecl.php.net/package/${encodeURIComponent(packageName)}`;
  const result = { package: packageName, packageUrl, target, source: 'PECL · downloads.php.net Windows builds', releases: [], available: false, checkedAt: new Date().toISOString() };
  let packageHtml;
  try {
    const response = await fetch(packageUrl, { headers: { accept: 'text/html', 'user-agent': 'XAMPP-Studio-pecl/0.1' }, signal: AbortSignal.timeout(9000) });
    if (!response.ok) throw new Error(`PECL respondeu HTTP ${response.status}.`);
    packageHtml = await response.text();
  } catch (error) {
    result.error = `Não foi possível consultar o PECL: ${error.message}`;
    return result;
  }
  const releasePattern = new RegExp(`href="/get/${escapeRegExp(packageName)}-(\\d+\\.\\d+\\.\\d+)\\.tgz"`, 'gi');
  const versions = [];
  for (const match of packageHtml.matchAll(releasePattern)) if (!versions.includes(match[1])) versions.push(match[1]);
  if (!versions.length) {
    result.error = `O PECL não listou versões estáveis para o pacote ${packageName}.`;
    PECL_VERSION_CACHE.set(cacheKey, { at: Date.now(), value: result });
    return result;
  }
  const selected = versions.slice(0, 8);
  result.releases = await Promise.all(selected.map(async version => {
    const directoryUrl = `https://downloads.php.net/~windows/pecl/releases/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/`;
    try {
      const response = await fetch(directoryUrl, { headers: { accept: 'text/html', 'user-agent': 'XAMPP-Studio-pecl/0.1' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) return { version, available: false, builds: [], compatibleBuilds: [], error: `Sem builds Windows (HTTP ${response.status}).` };
      const builds = parsePeclBuilds(await response.text(), directoryUrl, target);
      return { version, available: true, builds, compatibleBuilds: builds.filter(build => build.compatible) };
    } catch (error) {
      return { version, available: false, builds: [], compatibleBuilds: [], error: error.message };
    }
  }));
  result.available = result.releases.some(release => release.builds.length > 0);
  if (result.available || result.releases.every(item => !item.error || item.error.includes('HTTP 404'))) {
    PECL_VERSION_CACHE.set(cacheKey, { at: Date.now(), value: result });
  }
  return result;
}

async function searchMissingDlls(rawRoot) {
  const phpRoot = managedPhpRoot(rawRoot);
  const registry = currentDllRegistry();
  const check = verifyRuntimeDlls(phpRoot, registry.dlls);
  const versions = getVersions();
  const target = versions.find(item => samePath(item.root, phpRoot));
  const targetVersion = target?.version || path.basename(phpRoot);
  const local = [];
  for (const missing of check.missing) {
    for (const runtime of versions) {
      if (samePath(runtime.root, phpRoot)) continue;
      const file = findRuntimeDll(runtime.root, missing.dll);
      if (!file) continue;
      local.push({
        dll: missing.dll,
        name: missing.name,
        kind: missing.kind,
        sourceRoot: runtime.root,
        sourceVersion: runtime.version,
        threadSafety: runtime.threadSafety,
        architecture: runtime.architecture,
        path: file,
        sameVersion: String(runtime.version) === String(targetVersion)
      });
    }
  }
  const extensionMissing = check.missing.filter(item => item.kind === 'php_extension').slice(0, 8);
  const catalog = await Promise.all(extensionMissing.map(async item => {
    const query = String(item.name || item.dll).replace(/^php_/i, '').replace(/\.dll$/i, '');
    try {
      const result = await searchExtensionCatalog(query);
      return { dll: item.dll, query, packages: result.packages.slice(0, 4) };
    } catch (error) {
      return { dll: item.dll, query, packages: [], error: error.message };
    }
  }));
  return {
    phpRoot,
    targetVersion,
    check,
    local,
    catalog,
    registry: { phpVersion: registry.phpVersion, updatedAt: registry.updatedAt },
    checkedAt: new Date().toISOString()
  };
}

function findFileByName(root, matcher) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && matcher(entry.name)) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return null;
}

function upsertPhpExtensionDirective(contents, dll, directive = 'extension', aliases = []) {
  const names = [...new Set([dll, ...aliases].filter(Boolean).map(String))];
  const valuePattern = names.map(escapeRegExp).join('|');
  const activePattern = new RegExp(`^\\s*(extension|zend_extension)\\s*=\\s*["']?(?:${valuePattern})["']?\\s*$`, 'im');
  const commentedPattern = new RegExp(`^\\s*[;#]\\s*(extension|zend_extension)\\s*=\\s*["']?(?:${valuePattern})["']?\\s*$`, 'im');
  if (activePattern.test(contents)) return { text: contents, changed: false, directive: contents.match(activePattern)?.[1]?.toLowerCase() || directive };
  if (commentedPattern.test(contents)) {
    return {
      text: contents.replace(commentedPattern, `${directive}=${dll}`),
      changed: true,
      directive
    };
  }
  return {
    text: `${contents.trimEnd()}\r\n\r\n; XAMPP Studio: extensão instalada pelo fluxo assíncrono\r\n${directive}=${dll}\r\n`,
    changed: true,
    directive
  };
}

async function installPeclExtension(phpRoot, rawDll, rawPackage, rawBuildFile, job, downloadOnly = false, requirement = null) {
  const targetRoot = managedPhpRoot(phpRoot);
  const target = phpBuildTarget(targetRoot);
  const packageName = rawPackage ? peclPackageFromDll(rawPackage) : peclPackageFromDll(rawDll);
  const requestedDll = extensionDllName(rawDll ? extensionName(rawDll) : packageName);

  job.step('search', 'running', `Procurando build Windows para PHP ${target.version} ${target.threadSafety.toUpperCase()} ${target.architecture}.`);
  const catalog = await searchPeclVersions(targetRoot, requestedDll, packageName);
  const candidate = (catalog.releases || [])
    .flatMap(release => (release.compatibleBuilds || []).map(build => ({ ...build, release: release.version })))
    .find(build => build.compatible && (!rawBuildFile || String(build.file).toLowerCase() === String(rawBuildFile).toLowerCase()));
  if (!candidate) {
    const failed = catalog.releases?.find(item => item.error && !item.error.includes('HTTP 404'));
    throw new Error(catalog.error || (failed && `Falha ao consultar os builds de ${packageName}: ${failed.error}`)
      || `Nenhum build compatível localizado para ${requestedDll} no PHP ${target.phpMinor} ${target.threadSafety.toUpperCase()} ${target.compiler} ${target.architecture}.`);
  }
  job.step('search', 'succeeded', `Build ${candidate.file} selecionado.`);

  job.step('download', 'running', 'Baixando o pacote Windows oficial do PECL.');
  const response = await fetch(candidate.url, {
    headers: { accept: 'application/zip', 'user-agent': 'XAMPP-Studio-pecl/0.2' },
    signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error(`O download do pacote PECL falhou (HTTP ${response.status}).`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length < 1024 || archive.length > 80 * 1024 * 1024) throw new Error('Tamanho inesperado para o pacote da extensão.');
  const sha256 = createHash('sha256').update(archive).digest('hex');
  job.step('download', 'succeeded', `${(archive.length / 1024 / 1024).toFixed(2)} MB · SHA-256 ${sha256.slice(0, 16)}…`);

  job.step('extract', 'running', 'Validando e extraindo o pacote.');
  const operationId = randomBytes(12).toString('hex');
  const stagingRoot = path.join(APP_ROOT, 'runtimes', `.staging-ext-${operationId}`);
  const archivePath = path.join(APP_ROOT, 'downloads', `pecl-${packageName}-${operationId}.zip`);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.mkdirSync(path.dirname(stagingRoot), { recursive: true });
  let copied = false;
  let rollbackSnapshot = null;
  try {
    fs.writeFileSync(archivePath, archive, { flag: 'wx' });
    const listing = await execFileAsync('tar', ['-tf', archivePath], { timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.length > 10000 || entries.some(entry => path.isAbsolute(entry) || entry.split(/[\\/]/).some(part => part === '..'))) throw new Error('O pacote PECL contém caminhos de extração inválidos.');
    fs.mkdirSync(stagingRoot, { recursive: false });
    await execFileAsync('tar', ['-xf', archivePath, '-C', stagingRoot], { timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 });
    const dllName = requestedDll.toLowerCase();
    const sourceDll = findFileByName(stagingRoot, name => name.toLowerCase() === dllName)
      || findFileByName(stagingRoot, name => name.toLowerCase() === `php_${packageName.toLowerCase()}.dll`);
    if (!sourceDll) throw new Error(`O pacote não contém ${requestedDll}.`);
    const peArchitecture = readPeArchitecture(sourceDll);
    const expectedArchitecture = target.architecture === 'x64' ? 'Win64' : target.architecture === 'x86' ? 'Win32' : null;
    if (expectedArchitecture && peArchitecture !== expectedArchitecture) throw new Error(`A DLL é ${peArchitecture}, mas o runtime PHP é ${target.architecture}. A instalação foi cancelada.`);
    job.step('extract', 'succeeded', `${path.basename(sourceDll)} · ${peArchitecture}`);

    if (downloadOnly) {
      const directory = path.join(APP_ROOT, 'downloads', 'extensions', job.id);
      fs.mkdirSync(directory, { recursive: true });
      const dll = path.basename(sourceDll);
      fs.copyFileSync(sourceDll, path.join(directory, dll));
      fs.copyFileSync(archivePath, path.join(directory, candidate.file));
      const result = {
        package: packageName, dll, build: candidate.file, version: candidate.release,
        phpRoot: targetRoot, compiler: target.compiler, downloadedAt: new Date().toISOString(),
        phpVersion: target.version, threadSafety: target.threadSafety.toUpperCase(), architecture: target.architecture,
        path: path.join(directory, dll), sha256, dllSha256: createHash('sha256').update(fs.readFileSync(sourceDll)).digest('hex'),
        source: candidate.url, configured: false,
        downloadUrl: `/api/extensions/downloads/${job.id}/${dll}`,
        archiveUrl: `/api/extensions/downloads/${job.id}/${candidate.file}`
      };
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(result, null, 2));
      job.step('save', 'succeeded', 'DLL e ZIP original salvos em downloads/extensions. PHP e php.ini preservados.');
      return result;
    }

    job.step('configure', 'running', 'Copiando a DLL e atualizando o php.ini do runtime.');
    const extDirectory = path.join(targetRoot, 'ext');
    fs.mkdirSync(extDirectory, { recursive: true });
    const targetDll = path.join(extDirectory, path.basename(sourceDll));
    const iniPath = path.join(targetRoot, 'php.ini');
    if (!fs.existsSync(iniPath)) throw new Error('O runtime PHP selecionado não possui php.ini.');
    const registryEntry = requirement || currentDllRegistry().dlls.find(item => String(item.dll).toLowerCase() === dllName);
    const directive = registryEntry?.directive === 'zend_extension' ? 'zend_extension' : 'extension';
    const ini = readText(iniPath);
    const updated = requirement
      ? ensureRequiredPhpExtensions(setPhpExtensionDirectory(ini, targetRoot), [requirement], target.version)
      : upsertPhpExtensionDirective(ini, path.basename(sourceDll), directive, [packageName, registryEntry?.name]).text;
    const snapshot = createSwitchBackup([
      ['php.ini', iniPath],
      [`${path.basename(sourceDll)}-existing`, targetDll]
    ]);
    rollbackSnapshot = snapshot;
    try {
      fs.copyFileSync(sourceDll, targetDll);
      copied = !snapshot.files.some(file => path.basename(file.name) === `${path.basename(sourceDll)}-existing`);
      writeAtomically(iniPath, updated);
    } catch (error) {
      try { restoreSwitchBackup(rollbackSnapshot); } catch {}
      throw error;
    }

    job.step('validate', 'running', 'Iniciando o PHP para validar a extensão.');
    const probe = await execFileAsync(path.join(targetRoot, 'php.exe'), ['-c', iniPath, '-m'], { timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 });
    const modules = probe.stdout.split(/\r?\n/).map(line => line.trim().toLowerCase());
    const expectedModule = String(registryEntry?.name || packageName).toLowerCase();
    if (!modules.includes(expectedModule)) throw new Error(`O PHP iniciou sem ${expectedModule}. A configuração anterior foi restaurada.`);
    job.step('validate', 'succeeded', `Extensão ${expectedModule} carregada pelo PHP ${target.version}.`);
    job.step('configure', 'succeeded', `${path.basename(sourceDll)} instalada em ${extDirectory}.`);

    return {
      phpRoot: targetRoot,
      package: packageName,
      dll: path.basename(sourceDll),
      extension: expectedModule,
      path: targetDll,
      version: candidate.release,
      build: candidate.file,
      phpVersion: target.version,
      threadSafety: target.threadSafety.toUpperCase(),
      architecture: target.architecture,
      sha256,
      source: candidate.url,
      backup: snapshot.directory,
      configured: updated !== ini
    };
  } catch (error) {
    if (copied) {
      try { fs.rmSync(path.join(targetRoot, 'ext', requestedDll), { force: true }); } catch {}
    }
    if (rollbackSnapshot) {
      try { restoreSwitchBackup(rollbackSnapshot); } catch {}
    }
    throw error;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
  }
}

function pendingPhpExtensions(root, ini, originallyMissing) {
  if (!Array.isArray(originallyMissing) || originallyMissing.length === 0) return [];
  const enabled = phpExtensionDirectives(ini);
  return originallyMissing.filter(item => {
    const setting = enabled.find(entry => entry.dll.toLowerCase() === String(item.dll).toLowerCase()
      && entry.directive === (item.directive || 'extension'));
    return !setting || !findRuntimeDll(root, setting.dll);
  });
}

function phpRequirementsForVersion(registry, previouslyMissing = []) {
  const required = new Map(registry.map(item => [item.dll.toLowerCase(), item]));
  // Uma instalação anterior pode ter sido preparada a partir de outro php.ini.
  for (const item of previouslyMissing) {
    if (/^php_[a-z0-9_.-]+\.dll$/i.test(item?.dll) && !required.has(item.dll.toLowerCase())) {
      required.set(item.dll.toLowerCase(), { ...item, kind: 'php_extension', sources: ['php.ini migrado'] });
    }
  }
  return required;
}

function getVersionsWithDllChecks() {
  const registry = currentDllRegistry();
  const versions = getVersions();
  let apache = null;
  let apacheFiles = [];
  try {
    apache = activeApacheRuntime();
    apacheFiles = apacheConfigFiles(apache.root, apache.config || path.join(apache.root, 'conf', 'httpd.conf'));
  } catch { apache = null; }
  return {
    versions: versions.map(item => {
      const ini = readText(item.current ? activePhpIni(getConfig()) : path.join(item.root, 'php.ini'));
      const extensions = [...phpRequirementsForVersion(registry.dlls, item.missingExtensions).values()]
        .filter(entry => entry.kind === 'php_extension' && !isBuiltinOpcache(entry.dll, item.version));
      const conflicts = apache && apacheFiles.length
        ? phpRuntimeApacheConflicts(item.root, ini, apache.root, apacheFiles)
        : [];
      return {
        ...item,
        canPrepareExtensions: !item.current && samePath(path.dirname(item.root), path.join(APP_ROOT, 'runtimes')),
        missingExtensions: pendingPhpExtensions(item.root, ini, extensions),
        dllCheck: verifyRuntimeDlls(item.root, registry.dlls, item.version),
        apacheCompatibility: {
          compatible: conflicts.length === 0,
          conflicts: conflicts.map(entry => ({ extension: entry.extension, dll: entry.dll, missing: entry.missing.slice(0, 8) })),
          summary: conflicts.length ? describeApacheConflicts(conflicts, apache?.version) : null
        }
      };
    }),
    dllRegistry: registry,
    apache: apache ? { version: apache.version, root: apache.root } : null
  };
}

function activePhpIni(config) {
  const roots = [config.phpRoot, XAMPP_ROOT, path.join(APP_ROOT, 'runtimes')];
  if (config.phpIniDir && path.isAbsolute(config.phpIniDir) && roots.some(root => isInside(root, config.phpIniDir))) {
    const apacheIni = path.join(config.phpIniDir, 'php.ini');
    if (fs.existsSync(apacheIni)) return apacheIni;
  }
  return path.join(config.phpRoot, 'php.ini');
}

function migratePhpIni(sourceIni, targetRoot, targetVersion, templateRoot = targetRoot) {
  const template = readText(sourceIni) || readText(path.join(templateRoot, 'php.ini-development'));
  if (!template) throw new Error('Não encontrei um php.ini atual nem o php.ini-development do pacote oficial.');
  const missing = [];
  const migrated = [];
  const lines = template.split(/\r?\n/).map(line => {
    const extension = line.match(/^(\s*)(zend_extension|extension)\s*=\s*(.*?)\s*$/i);
    if (!extension || /^\s*[;#]/.test(line)) return line;
    const originalValue = extension[3].replace(/\s*[;#].*$/, '').trim().replace(/^['"]|['"]$/g, '');
    const dll = extensionDllName(originalValue);
    if (isBuiltinOpcache(dll, targetVersion)) {
      migrated.push('opcache');
      return `; OPcache integrado ao PHP ${targetVersion}\n; ${line.trim()}`;
    }
    const available = [path.join(templateRoot, 'ext', dll), path.join(templateRoot, dll)].some(file => fs.existsSync(file));
    const name = dll.replace(/^php_/i, '').replace(/\.dll$/i, '');
    if (available) {
      migrated.push(name);
      // Um caminho absoluto no php.ini antigo carregaria a DLL do PHP anterior.
      return /[\\/]/.test(originalValue) ? `${extension[1]}${extension[2]}=${dll}` : line;
    }
    missing.push({ name, dll, directive: extension[2].toLowerCase() });
    return `; XAMPP Studio: ${name} não está disponível neste pacote PHP ${targetVersion}.\n; ${line.trim()}`;
  });
  const ini = setPhpExtensionDirectory(lines.join('\r\n'), targetRoot);
  return { ini, extensions: { migrated: [...new Set(migrated)], missing, checkedAt: new Date().toISOString() } };
}

async function probePhpRuntime(root, expected) {
  const executable = path.join(root, 'php.exe');
  const ini = path.join(root, 'php.ini');
  const probe = await execFileAsync(executable, ['-c', ini, '-r', 'echo PHP_VERSION,"|",(PHP_ZTS?"TS":"NTS"),"|",PHP_INT_SIZE*8;'], { timeout: 8000, windowsHide: true, maxBuffer: 8192 });
  const [version, threadSafety, bits] = probe.stdout.trim().split('|');
  const architecture = bits === '64' ? 'x64' : bits === '32' ? 'x86' : null;
  // Pacotes "8.5.12-1" do windows.php.net trazem um engine que reporta
  // "8.5.12"; a revisão do pacote não pode reprovar o runtime extraído.
  const expectedVersion = expected ? String(expected.version).replace(/-\d+$/, '') : null;
  if (expected && (version !== expectedVersion || threadSafety !== expected.threadSafety || architecture !== expected.architecture)) {
    throw new Error(`Runtime extraído: PHP ${version} ${threadSafety} ${architecture || bits}; selecionado: PHP ${expected.version} ${expected.threadSafety} ${expected.architecture}.`);
  }
  const modules = await execFileAsync(executable, ['-c', ini, '-m'], { timeout: 12000, windowsHide: true, maxBuffer: 32 * 1024 });
  const startupText = `${modules.stdout || ''}\n${modules.stderr || ''}`;
  if (isBuiltinOpcache('php_opcache.dll', version) && !/^Zend OPcache\s*$/im.test(modules.stdout)) {
    throw new Error(`O PHP ${version} iniciou sem o OPcache integrado esperado.`);
  }
  const loadFailure = startupText.match(/(?:Unable to load dynamic library|Failed loading|Failed to load Zend extension)[^\r\n]*/i);
  if (loadFailure) throw new Error(`A configuração copiada ainda aponta para uma DLL incompatível: ${loadFailure[0].slice(0, 260)}`);
  return { version, threadSafety, architecture, modules: modules.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean) };
}

function setPhpExtensionDirectory(contents, root) {
  const directory = path.join(root, 'ext').replace(/\\/g, '/');
  const active = /^[ \t]*extension_dir[ \t]*=.*$/gim;
  return active.test(contents)
    ? contents.replace(active, () => `extension_dir="${directory}"`)
    : `${contents}\r\n\r\n; XAMPP Studio: diretório de módulos deste runtime\r\nextension_dir="${directory}"\r\n`;
}

/**
 * Alinha os caminhos do php.ini com o runtime em uso.
 *
 * Sem isso o error_log continua apontando para a pasta do PHP antigo e o
 * openssl.cafile para o Apache antigo: os erros do PHP sumem e a verificação
 * de certificados do curl depende de um componente que pode ser removido.
 */
function alignPhpIniPaths(contents, phpRoot, apacheRoot = null) {
  let output = String(contents || '');
  const logDirectory = path.join(phpRoot, 'logs').replace(/\\/g, '/');
  const logFile = `${logDirectory}/php_error_log`;
  try { fs.mkdirSync(path.join(phpRoot, 'logs'), { recursive: true }); } catch {}
  const errorLog = /^\s*error_log\s*=.*$/im;
  if (errorLog.test(output)) output = output.replace(errorLog, `error_log="${logFile}"`);
  else output += `\r\n; XAMPP Studio: log de erros deste runtime\r\nerror_log="${logFile}"\r\n`;
  if (apacheRoot) {
    const bundle = path.join(apacheRoot, 'bin', 'curl-ca-bundle.crt').replace(/\\/g, '/');
    if (fs.existsSync(path.join(apacheRoot, 'bin', 'curl-ca-bundle.crt'))) {
      const caFile = /^\s*openssl\.cafile\s*=.*$/im;
      if (caFile.test(output)) output = output.replace(caFile, `openssl.cafile="${bundle}"`);
      else output += `\r\n; XAMPP Studio: pacote de certificados do Apache em uso\r\nopenssl.cafile="${bundle}"\r\n`;
    }
  }
  return output;
}

function ensureRequiredPhpExtensions(contents, requiredDlls, version) {
  const activeDlls = new Set();
  const extensions = new Map(requiredDlls.filter(item => item.kind === 'php_extension').map(item => [item.dll.toLowerCase(), item]));
  const additions = [];
  let updated = contents.replace(/^[ \t]*(?:zend_extension|extension)[ \t]*=[^\r\n]+/gim, line => {
    const setting = phpExtensionDirectives(line)[0];
    if (!setting) return line;
    if (isBuiltinOpcache(setting.dll, version)) return `; ${line}`;
    const dll = setting.dll.toLowerCase();
    activeDlls.add(dll);
    const item = extensions.get(dll);
    if (!item) return line;
    const directive = item.directive === 'zend_extension' ? 'zend_extension' : 'extension';
    const comment = line.match(/[ \t]*[;#].*$/)?.[0] || '';
    if (setting.directive === directive && !/[\\/]/.test(line.slice(0, line.length - comment.length))) return line;
    return `${directive}=${item.dll}${comment}`;
  });
  for (const item of extensions.values()) {
    if (isBuiltinOpcache(item.dll, version) || activeDlls.has(item.dll.toLowerCase())) continue;
    const value = item.directive === 'zend_extension'
      ? (String(item.name).toLowerCase() === 'opcache' ? 'opcache' : item.dll)
      : item.dll;
    // A nota "não está disponível neste pacote" e a diretiva comentada ficam
    // obsoletas quando a DLL é habilitada de novo: removê-las evita um
    // php.ini que se contradiz.
    updated = updated.replace(new RegExp(`^;[ \\t]*XAMPP Studio: ${escapeRegExp(item.name)} não está disponível neste pacote PHP[^\\r\\n]*\\r?\\n`, 'im'), '');
    updated = updated.replace(new RegExp(`^;[ \\t]*(?:zend_extension|extension)[ \\t]*=[ \\t]*${escapeRegExp(item.dll)}[^\\r\\n]*\\r?\\n`, 'im'), '');
    additions.push(`${item.directive === 'zend_extension' ? 'zend_extension' : 'extension'}=${value}`);
    activeDlls.add(String(item.dll).toLowerCase());
  }
  if (!additions.length) return updated;
  return `${updated.trimEnd()}\r\n\r\n; XAMPP Studio: extensões exigidas pelo registro de DLLs\r\n${additions.join('\r\n')}\r\n`;
}

function phpApacheFiles(root) {
  const files = fs.readdirSync(root);
  return {
    module: files.find(name => /^php\d*apache2_4\.dll$/i.test(name)) || null,
    ts: files.find(name => /^php\d*ts\.dll$/i.test(name)) || null
  };
}

/**
 * Confere o certificado do runtime Apache.
 *
 * O certificado que acompanha o XAMPP tem chave RSA de 1024 bits e SHA1, e o
 * OpenSSL 3.5 (usado pelo Apache 2.4.69) recusa a configuração com
 * "ee key too small" — o serviço sobe e cai em seguida. O XAMPP Studio usa o
 * openssl.exe do próprio runtime para gerar um certificado de 2048 bits.
 */
function apacheCertificateStatus(apacheRoot) {
  const certificate = path.join(apacheRoot, 'conf', 'ssl.crt', 'server.crt');
  const key = path.join(apacheRoot, 'conf', 'ssl.key', 'server.key');
  const openssl = path.join(apacheRoot, 'bin', 'openssl.exe');
  if (!fs.existsSync(openssl)) return { ok: false, reason: 'o runtime Apache não traz openssl.exe', bits: 0 };
  if (!fs.existsSync(certificate) || !fs.existsSync(key)) return { ok: false, reason: 'o runtime Apache não tem certificado gerado', bits: 0 };
  try {
    const result = execFileSync(openssl, ['x509', '-in', certificate, '-noout', '-text'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, OPENSSL_CONF: path.join(apacheRoot, 'conf', 'openssl.cnf') }
    });
    const bits = Number(String(result).match(/Public-Key:\s*\((\d+) bit\)/)?.[1] || 0);
    if (bits < 2048) return { ok: false, reason: `o certificado usa chave RSA de ${bits} bits (o OpenSSL 3.x exige 2048)`, bits };
    return { ok: true, bits };
  } catch (error) {
    return { ok: false, reason: `não consegui ler o certificado (${error.message.slice(0, 120)})`, bits: 0 };
  }
}

function generateApacheCertificate(apacheRoot) {
  const openssl = path.join(apacheRoot, 'bin', 'openssl.exe');
  if (!fs.existsSync(openssl)) throw new Error('O runtime Apache não traz openssl.exe para gerar o certificado.');
  const certificateDirectory = path.join(apacheRoot, 'conf', 'ssl.crt');
  const keyDirectory = path.join(apacheRoot, 'conf', 'ssl.key');
  fs.mkdirSync(certificateDirectory, { recursive: true });
  fs.mkdirSync(keyDirectory, { recursive: true });
  const certificate = path.join(certificateDirectory, 'server.crt');
  const key = path.join(keyDirectory, 'server.key');
  execFileSync(openssl, [
    'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', '3650',
    '-keyout', key, '-out', certificate,
    '-subj', '/C=BR/ST=Local/L=Local/O=XAMPP Studio/OU=Local/CN=www.example.com',
    '-addext', 'subjectAltName=DNS:www.example.com,DNS:localhost,IP:127.0.0.1'
  ], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // O openssl.exe do Apache Lounge vem com OPENSSL_CONF apontando para a
    // máquina de build; sem corrigir, a geração do certificado falha.
    env: { ...process.env, OPENSSL_CONF: path.join(apacheRoot, 'conf', 'openssl.cnf') }
  });
  const status = apacheCertificateStatus(apacheRoot);
  if (!status.ok) throw new Error(`Não consegui gerar um certificado utilizável no runtime Apache: ${status.reason}.`);
  return status;
}

function makeApacheRuntimeConfig(sourceConfig, apacheRoot) {
  const confDirectory = path.dirname(sourceConfig);
  const sourceRoot = path.dirname(confDirectory);
  const generatedConfig = path.join(apacheRoot, 'conf', 'xampp-studio-httpd.conf');
  if (!fs.existsSync(path.join(apacheRoot, 'conf'))) throw new Error('O build Apache não tem a pasta conf esperada.');
  // O httpd-ssl.conf do XAMPP usa caminhos relativos ao ServerRoot. O runtime
  // isolado precisa de certificado próprio: o do XAMPP tem chave de 1024 bits
  // e o OpenSSL 3.x do Apache novo rejeita a configuração ("ee key too small").
  const certificate = apacheCertificateStatus(apacheRoot);
  if (!certificate.ok) {
    const sourceCertificate = path.join(confDirectory, 'ssl.crt', 'server.crt');
    const sourceKey = path.join(confDirectory, 'ssl.key', 'server.key');
    const copied = [];
    if (fs.existsSync(sourceCertificate) && fs.existsSync(sourceKey)) {
      try {
        fs.mkdirSync(path.join(apacheRoot, 'conf', 'ssl.crt'), { recursive: true });
        fs.mkdirSync(path.join(apacheRoot, 'conf', 'ssl.key'), { recursive: true });
        fs.copyFileSync(sourceCertificate, path.join(apacheRoot, 'conf', 'ssl.crt', 'server.crt'));
        fs.copyFileSync(sourceKey, path.join(apacheRoot, 'conf', 'ssl.key', 'server.key'));
        copied.push('certificado do XAMPP');
      } catch {}
    }
    const afterCopy = apacheCertificateStatus(apacheRoot);
    if (!afterCopy.ok) generateApacheCertificate(apacheRoot);
  }
  let text = readText(sourceConfig);
  if (!text) throw new Error('Não consegui ler o httpd.conf de origem para preparar a configuração Apache.');
  let serverRootSeen = false;
  let srvRootSeen = false;
  text = text.split(/\r?\n/).map(line => {
    if (/^\s*ServerRoot\s+/i.test(line)) { serverRootSeen = true; return `ServerRoot "${apacheRoot.replace(/\\/g, '/')}"`; }
    if (/^\s*Define\s+SRVROOT\b/i.test(line)) { srvRootSeen = true; return `Define SRVROOT "${apacheRoot.replace(/\\/g, '/')}"`; }
    const include = line.match(/^(\s*Include(?:Optional)?\s+)(.+?)\s*$/i);
    if (!include || /^\s*#/.test(line)) return line;
    let includePath = include[2].trim().replace(/^['"]|['"]$/g, '').replace(/\$\{SRVROOT\}/gi, apacheRoot.replace(/\\/g, '/'));
    const isAbsolute = path.isAbsolute(includePath) || /^[a-z]:[\\/]/i.test(includePath) || includePath.startsWith('\\\\');
    // No Apache, caminhos relativos de Include são resolvidos a partir do ServerRoot.
    if (!isAbsolute) includePath = path.join(apacheRoot, includePath);
    // Um Include de conf/extra deve apontar para a cópia do próprio runtime:
    // assim o httpd novo não depende de arquivos do Apache antigo do XAMPP.
    const extra = includePath.match(/[/\\]conf[/\\]extra[/\\]([^/\\]+)$/i);
    if (extra) {
      const own = path.join(apacheRoot, 'conf', 'extra', extra[1]);
      if (fs.existsSync(own)) includePath = own;
    }
    return `${include[1]}"${includePath.replace(/\\/g, '/')}"`;
  }).join('\r\n');
  if (!serverRootSeen) throw new Error('Não encontrei ServerRoot ativo em httpd.conf.');
  if (!srvRootSeen) text = `Define SRVROOT "${apacheRoot.replace(/\\/g, '/')}"\r\n${text}`;
  return { config: generatedConfig, text };
}

function createSwitchBackup(files) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const destination = path.join(BACKUP_ROOT, `switch-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(destination, { recursive: false });
  const copied = [];
  const absent = [];
  try {
    for (const [name, source] of files) {
      if (!fs.existsSync(source)) {
        absent.push(source);
        continue;
      }
      const target = path.join(destination, `${String(copied.length + 1).padStart(2, '0')}-${name}`);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      copied.push({ name, source, target, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
    }
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), xamppRoot: XAMPP_ROOT, files: copied, absent }, null, 2), { flag: 'wx' });
    return { directory: destination, files: copied, absent };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function restoreSwitchBackup(snapshot) {
  for (const file of snapshot.files) writeAtomically(file.source, fs.readFileSync(file.target));
  for (const file of snapshot.absent || []) fs.rmSync(file, { force: true });
}

async function stableApacheState() {
  let service = await inspectXamppService('apache');
  if (service.managed && [2, 3].includes(service.state)) {
    try {
      service = await waitForXamppService('apache', service.state === 2 ? 4 : 1, 30000);
    } catch {
      service = await inspectXamppService('apache');
    }
  }
  if (!service.managed || ![1, 4].includes(service.state)) throw new Error(service.reason || 'Estado do Apache indisponível.');
  return service.state;
}

async function rollbackPhpActivation(snapshot, serviceName, priorCommand, steps) {
  const problems = [];
  // Uma falha na validação ou no UAC ocorre antes de tocar no processo original.
  if (steps.startAttempted) {
    try {
      if (await stableApacheState() === 4) {
        await runWindowsServiceAction('stop', serviceName);
        await waitForXamppService('apache', 1, 30000);
      }
    } catch (error) { problems.push(`parada: ${error.message}`); }
  }
  try { restoreSwitchBackup(snapshot); } catch (error) { problems.push(`arquivos: ${error.message}`); }
  if (steps.commandAttempted) {
    try { await changeApacheServiceCommand(priorCommand, serviceName); } catch (error) { problems.push(`serviço: ${error.message}`); }
  }
  if (steps.stopAttempted) {
    try {
      if (await stableApacheState() === 1) {
        await runWindowsServiceAction('start', serviceName);
        await waitForXamppService('apache', 4, APACHE_START_TIMEOUT_MS);
      }
    } catch (error) { problems.push(`retorno do Apache: ${error.message}`); }
  }
  return problems.length ? `Reversão incompleta (${problems.join('; ')}). Confira o backup em ${snapshot.directory}.` : `As configurações anteriores foram restauradas. Backup: ${snapshot.directory}.`;
}

async function startApacheForActivation(serviceName, apacheRoot, configPath, port) {
  const errorLogOffset = apacheErrorLogSize(apacheRoot, configPath);
  try {
    await runWindowsServiceAction('start', serviceName);
    await waitForXamppService('apache', 4, APACHE_START_TIMEOUT_MS);
    if (!(await waitForPort(port, APACHE_PORT_TIMEOUT_MS))) {
      throw new Error(`O serviço iniciou, mas a porta ${port} não respondeu após ${APACHE_PORT_TIMEOUT_MS / 1000} segundos.`);
    }
    const extensionFailures = apacheExtensionLoadFailures(apacheRoot, errorLogOffset, configPath);
    if (extensionFailures.length) throw new Error(`O Apache iniciou, mas ${extensionFailures.join(', ')} não carregou no contexto web.`);
  } catch (error) {
    const detail = apacheStartupLogDetail(apacheRoot, errorLogOffset, configPath);
    const log = apacheErrorLogPath(apacheRoot, configPath);
    const message = detail ? `\nLog do Apache (${log})\n${detail}` : `\nLog do Apache: ${log}.`;
    throw new Error(error.message + message, { cause: error });
  }
}

/**
 * Migra o Apache para outra porta.
 *
 * A troca é sempre reversível: o httpd em uso é copiado antes, a nova
 * configuração passa por "httpd -t", o serviço é reiniciado e a porta nova
 * precisa responder. Qualquer falha devolve o arquivo original e reinicia o
 * serviço na configuração anterior.
 */
async function changeApachePort(rawPort) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Escolha uma porta entre 1024 e 65535.');
  }
  const apache = activeApacheRuntime();
  const config = apache.config;
  const contents = readText(config);
  if (!contents) throw new Error(`Não consegui ler a configuração do Apache: ${config}`);
  const current = apachePrimaryPort(contents);
  if (current === port) throw new Error(`O Apache já escuta na porta ${port}.`);

  const ownership = await portOwnership(port, 'apache');
  if (ownership.active) {
    throw new Error(`A porta ${port} já está em uso por ${ownership.summary || 'outro processo'}. Escolha outra porta.`);
  }

  const snapshot = createSwitchBackup([[path.basename(config), config]]);
  try {
    writeAtomically(config, rewriteApacheListenPort(contents, port));
    const check = await execFileAsync(apache.executable, ['-t', '-d', apache.root, '-f', apache.config], { cwd: apache.root, timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 });
    if (!/Syntax OK/i.test(`${check.stdout}\n${check.stderr}`)) throw new Error('A configuração com a nova porta não passou na validação; o Apache foi revertido.');

    const service = await inspectXamppService('apache');
    if (service.managed) {
      if (service.state === 4) await restartWindowsService(service.serviceName);
      else await runWindowsServiceAction('start', service.serviceName);
      await waitForXamppService('apache', 4, 45000);
    }
    const responding = await waitForPort(port, 20000);
    if (!responding) throw new Error(`O Apache subiu, mas a porta ${port} não respondeu; o Apache foi revertido.`);

    const previousOwnership = await portOwnership(current, 'apache');
    return {
      component: 'apache',
      previousPort: current,
      port,
      url: `http://localhost:${port}`,
      responding: true,
      releasedPreviousPort: !previousOwnership.active,
      backup: snapshot.directory,
      restarted: service.managed
    };
  } catch (error) {
    try {
      restoreSwitchBackup(snapshot);
      const service = await inspectXamppService('apache');
      if (service.managed) {
        if (service.state === 4) await restartWindowsService(service.serviceName);
        else await runWindowsServiceAction('start', service.serviceName);
        await waitForXamppService('apache', 4, 45000);
      }
    } catch (rollbackError) {
      throw new Error(`${error.message} (a reversão também falhou: ${rollbackError.message})`);
    }
    throw error;
  }
}

function makeStandaloneApacheConfig(sourceConfig, apacheRoot, phpRoot, phpModule, tsRuntime, phpIniContents = '', apacheFiles = []) {
  const prepared = makeApacheRuntimeConfig(sourceConfig, apacheRoot);
  const documentRoot = path.join(WORKSPACE_ROOT, 'htdocs').replace(/\\/g, '/');
  fs.mkdirSync(documentRoot, { recursive: true });
  let documentRootSeen = false;
  const withoutPhp = prepared.text.split(/\r?\n/).filter(line => {
    if (/^\s*LoadModule\s+php_module\b/i.test(line)) return false;
    if (/^\s*LoadFile\s+.*php\d*ts\.dll/i.test(line)) return false;
    if (/^\s*PHPIniDir\b/i.test(line)) return false;
    if (/^\s*SetEnv\s+PHPRC\b/i.test(line)) return false;
    if (/^\s*DocumentRoot\s+/i.test(line)) { documentRootSeen = true; return false; }
    return true;
  }).join('\r\n');
  const phpModulePath = path.join(phpRoot, phpModule).replace(/\\/g, '/');
  const phpRuntimePath = path.join(phpRoot, tsRuntime).replace(/\\/g, '/');
  const phpRootPath = phpRoot.replace(/\\/g, '/');
  const dependencyFiles = phpRuntimeDependencyDlls(phpRoot, phpIniContents, apacheRoot, apacheFiles);
  const denyRules = apacheDenyRules(APP_ROOT, [documentRoot]);
  const text = [
    withoutPhp.trimEnd(),
    '',
    denyRules,
    `DocumentRoot "${documentRoot}"`,
    `<Directory "${documentRoot}">`,
    '  Options Indexes FollowSymLinks',
    '  AllowOverride All',
    '  Require all granted',
    '</Directory>',
    `LoadFile "${phpRuntimePath}"`,
    ...dependencyFiles.map(file => `LoadFile "${path.join(phpRoot, path.basename(file)).replace(/\\/g, '/')}"`),
    `LoadModule php_module "${phpModulePath}"`,
    `PHPIniDir "${phpRootPath}"`,
    `SetEnv PHPRC "${phpRootPath}"`,
    ''
  ].join('\r\n');
  return { config: prepared.config, text, documentRoot, dependencies: dependencyFiles.map(file => path.basename(file)) };
}

async function switchStandaloneEnvironment(phpRoot, apacheRootChoice = null) {
  if (process.platform !== 'win32') throw new Error('A ativação integrada só está disponível no Windows.');
  const config = getConfig();
  const runtimesRoot = path.join(APP_ROOT, 'runtimes');
  const candidates = getVersions();
  const environment = readEnvironmentState();
  const activePhpRoot = typeof environment.phpRoot === 'string' ? environment.phpRoot : null;
  const php = candidates.find(item => path.resolve(item.root).toLowerCase() === path.resolve(phpRoot).toLowerCase());
  const allowed = php && (isInside(runtimesRoot, php.root) || isInside(XAMPP_ROOT, php.root) || (activePhpRoot && samePath(php.root, activePhpRoot)));
  if (!allowed) throw new Error('Essa versão PHP não pertence ao ambiente ativo ou aos runtimes preparados pelo Studio.');
  const targetRoot = path.resolve(php.root);
  if (!fs.existsSync(path.join(targetRoot, 'php.exe')) || !fs.existsSync(path.join(targetRoot, 'php.ini'))) throw new Error('O runtime selecionado não tem php.exe e php.ini.');
  const requiredDlls = currentDllRegistry().dlls;
  const dllCheck = verifyRuntimeDlls(targetRoot, requiredDlls, php.version);
  if (!dllCheck.compatible) {
    const missing = dllCheck.missing.map(item => item.dll).join(', ');
    throw new Error(`Troca bloqueada: ${dllCheck.missing.length} DLL(s) exigida(s) não existe(m) em PHP ${php.version} (${missing}).`);
  }
  const phpFiles = phpApacheFiles(targetRoot);
  if (!phpFiles.module || !phpFiles.ts) throw new Error('Para servir PHP pelo Apache, escolha um build Thread Safe que contenha php*_apache2_4.dll e php*ts.dll.');
  const expectedPhp = {
    version: php.version,
    threadSafety: php.threadSafety || 'TS',
    architecture: php.architecture || (readPeArchitecture(path.join(targetRoot, 'php.exe')) === 'Win64' ? 'x64' : 'x86')
  };
  if (expectedPhp.threadSafety !== 'TS') throw new Error('O PHP selecionado não é Thread Safe. O módulo PHP do Apache exige TS.');

  const currentApache = activeApacheRuntime();
  let apache = currentApache;
  if (apacheRootChoice) {
    const normalizedChoice = path.resolve(apacheRootChoice);
    const found = listPreparedApacheRuntimes().find(item => path.resolve(item.root).toLowerCase() === normalizedChoice.toLowerCase());
    if (!found || !isInside(runtimesRoot, found.root)) throw new Error('O Apache escolhido não é um runtime preparado pelo XAMPP Studio.');
    // A lista de runtimes preparados traz metadados sem caminhos: o build do
    // Apache Lounge segue a convenção bin/httpd.exe dentro do próprio root.
    apache = { ...found, executable: path.join(found.root, 'bin', 'httpd.exe') };
  }
  if (!fs.existsSync(apache.executable)) throw new Error('O Apache selecionado não tem executável httpd.exe.');
  const sourceConfig = fs.existsSync(path.join(apache.root, 'conf', 'httpd.conf'))
    ? path.join(apache.root, 'conf', 'httpd.conf')
    : currentApache.config;
  const phpIniPath = path.join(targetRoot, 'php.ini');
  const updatedPhpIni = ensureRequiredPhpExtensions(alignPhpIniPaths(setPhpExtensionDirectory(readText(phpIniPath), targetRoot), targetRoot, apache.root), requiredDlls, php.version);
  const apacheFiles = apacheConfigFiles(apache.root, sourceConfig);
  const conflicts = phpRuntimeApacheConflicts(targetRoot, updatedPhpIni, apache.root, apacheFiles);
  if (conflicts.length) {
    throw new Error(`Troca bloqueada: ${describeApacheConflicts(conflicts, apache.version)}. Atualize o Apache para uma versão compatível ou escolha um PHP que funcione com este Apache.`);
  }
  const generated = makeStandaloneApacheConfig(sourceConfig, apache.root, targetRoot, phpFiles.module, phpFiles.ts, updatedPhpIni, apacheFiles);

  const service = await inspectXamppService('apache');
  if (!service.managed) throw new Error('Para ativar uma versão, primeiro integre o serviço Apache ao Studio na página Serviços.');
  if (![1, 4].includes(service.state)) throw new Error(`Apache está mudando de estado no Windows (estado ${service.state}); aguarde e tente novamente.`);
  const apachePort = apachePrimaryPort(generated.text);
  if (service.state === 1 && await checkPort(apachePort)) throw new Error(`A porta ${apachePort} está ocupada por um processo fora do serviço Apache integrado.`);
  const scConfig = await execFileAsync('sc.exe', ['qc', service.serviceName], { timeout: 5000, windowsHide: true, maxBuffer: 8192 });
  const storedServiceCommand = await readServiceCommand(service.serviceName);
  const priorServiceCommand = quoteServiceCommand(storedServiceCommand || serviceCommandFromOutput(scConfig.stdout));
  if (!priorServiceCommand) throw new Error('Não consegui guardar o comando do serviço Apache para permitir a reversão.');

  const oldEnvironment = readEnvironmentState();
  const nextEnvironment = {
    ...oldEnvironment,
    mode: 'standalone',
    phpRoot: targetRoot,
    phpVersion: php.version,
    apacheRoot: apache.root,
    apacheConfig: generated.config,
    apacheServiceName: service.serviceName,
    apacheVersion: apache.version || await getApacheVersion(apache.executable)
  };
  const snapshot = createSwitchBackup([
    ['php.ini-target', phpIniPath],
    ['active-environment.json', ENVIRONMENT_STATE],
    ['studio-httpd.conf', generated.config]
  ]);
  const steps = { stopAttempted: false, startAttempted: false, commandAttempted: false };
  try {
    writeAtomically(phpIniPath, updatedPhpIni);
    const phpProbe = await probePhpRuntime(targetRoot, expectedPhp);
    writeAtomically(generated.config, generated.text);
    const check = await execFileAsync(apache.executable, ['-t', '-d', apache.root, '-f', generated.config], { cwd: apache.root, timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 });
    if (!/Syntax OK/i.test(`${check.stdout}\n${check.stderr}`)) throw new Error(`A validação do Apache não retornou “Syntax OK”: ${(check.stdout || check.stderr || '').slice(0, 360)}`);
    writeEnvironmentState(nextEnvironment);
    const nextCommand = apacheServiceCommand({ ...apache, config: generated.config }, service.serviceName);
    if (!serviceCommandMatches(storedServiceCommand, nextCommand)) {
      steps.commandAttempted = true;
      await changeApacheServiceCommand(nextCommand, service.serviceName);
    }
    let restarted = false;
    let responding = false;
    if (service.state === 4) {
      steps.stopAttempted = true;
      await runWindowsServiceAction('stop', service.serviceName);
      await waitForXamppService('apache', 1, 30000);
      steps.startAttempted = true;
      await startApacheForActivation(service.serviceName, apache.root, generated.config, apachePort);
      responding = true;
      restarted = true;
    }
    return {
      phpVersion: phpProbe.version,
      phpRoot: targetRoot,
      apacheVersion: nextEnvironment.apacheVersion,
      apacheRoot: apache.root,
      apacheRestarted: restarted,
      responding,
      backup: snapshot.directory,
      mode: 'standalone',
      warnings: (php.missingExtensions || []).filter(item => !phpProbe.modules.some(module =>
        module.toLowerCase() === String(item.name).toLowerCase()))
    };
  } catch (error) {
    const rollback = await rollbackPhpActivation(snapshot, service.serviceName, priorServiceCommand, steps);
    throw new Error(`${error.message} ${rollback}`);
  }
}

async function switchEnvironment(phpRoot, apacheRootChoice = null) {
  if (isStandaloneMode()) return switchStandaloneEnvironment(phpRoot, apacheRootChoice);
  if (process.platform !== 'win32') throw new Error('A ativação integrada só está disponível no Windows.');
  const config = getConfig();
  const runtimesRoot = path.join(APP_ROOT, 'runtimes');
  const candidates = getVersions();
  const php = candidates.find(item => path.resolve(item.root).toLowerCase() === path.resolve(phpRoot).toLowerCase());
  if (!php || (!isInside(runtimesRoot, php.root) && !isInside(XAMPP_ROOT, php.root))) throw new Error('Essa versão PHP não pertence ao XAMPP ou aos runtimes preparados pelo Studio.');
  const targetRoot = path.resolve(php.root);
  if (!fs.existsSync(path.join(targetRoot, 'php.exe')) || !fs.existsSync(path.join(targetRoot, 'php.ini'))) throw new Error('O runtime selecionado não tem php.exe e php.ini.');
  const requiredDlls = currentDllRegistry().dlls;
  const dllCheck = verifyRuntimeDlls(targetRoot, requiredDlls, php.version);
  if (!dllCheck.compatible) {
    const missing = dllCheck.missing.map(item => item.dll).join(', ');
    throw new Error(`Troca bloqueada: ${dllCheck.missing.length} DLL(s) usada(s) pelo ambiente atual não existe(m) em PHP ${php.version} (${missing}). Instale as DLLs nesse runtime ou ajuste as extensões ativas antes de trocar.`);
  }
  const phpFiles = phpApacheFiles(targetRoot);
  if (!phpFiles.module || !phpFiles.ts) throw new Error('Para servir PHP pelo Apache, escolha um build Thread Safe que contenha php*_apache2_4.dll e php*ts.dll.');
  const expectedPhp = {
    version: php.version, threadSafety: php.threadSafety || 'TS',
    architecture: php.architecture || (readPeArchitecture(path.join(targetRoot, 'php.exe')) === 'Win64' ? 'x64' : 'x86')
  };
  if (expectedPhp.threadSafety !== 'TS') throw new Error('O PHP selecionado não é Thread Safe. O módulo PHP do Apache exige TS.');

  const currentApache = activeApacheRuntime();
  let apache = currentApache;
  if (apacheRootChoice) {
    const normalizedChoice = path.resolve(apacheRootChoice);
    const bundled = path.resolve(path.join(XAMPP_ROOT, 'apache'));
    if (normalizedChoice.toLowerCase() === bundled.toLowerCase()) {
      apache = { root: bundled, executable: path.join(bundled, 'bin', 'httpd.exe'), config: path.join(bundled, 'conf', 'httpd.conf'), version: null, source: 'XAMPP' };
    } else {
      apache = listPreparedApacheRuntimes().find(item => path.resolve(item.root).toLowerCase() === normalizedChoice.toLowerCase());
      if (!apache || !isInside(runtimesRoot, apache.root)) throw new Error('O Apache escolhido não é um runtime preparado pelo XAMPP Studio.');
      const prepared = makeApacheRuntimeConfig(path.join(XAMPP_ROOT, 'apache', 'conf', 'httpd.conf'), apache.root);
      // O config gerado é sempre reescrito: ele depende do Apache escolhido e
      // do conjunto de DLLs do runtime PHP ativo.
      apache.generatedConfig = prepared;
      apache.executable = path.join(apache.root, 'bin', 'httpd.exe');
    }
  }
  if (!fs.existsSync(apache.executable) || !fs.existsSync(apache.config || path.join(apache.root, 'conf', 'httpd.conf'))) throw new Error('O Apache selecionado não tem executável ou configuração.');
  const apacheConfig = apache.generatedConfig?.config || apache.config;
  const apachePort = apachePrimaryPort(apache.generatedConfig?.text || readText(apacheConfig));
  const phpConfig = readText(path.join(targetRoot, 'php.ini'));
  const updatedPhpIni = ensureRequiredPhpExtensions(alignPhpIniPaths(setPhpExtensionDirectory(phpConfig, targetRoot), targetRoot, apache.root), requiredDlls, php.version);
  const apacheFiles = apacheConfigFiles(apache.root, apache.config || path.join(apache.root, 'conf', 'httpd.conf'));
  const conflicts = phpRuntimeApacheConflicts(targetRoot, updatedPhpIni, apache.root, apacheFiles);
  if (conflicts.length) {
    throw new Error(`Troca bloqueada: ${describeApacheConflicts(conflicts, apache.version)}. Atualize o Apache para uma versão compatível ou escolha um PHP que funcione com este Apache.`);
  }
  const rewrittenPhpApache = rewriteXamppPhpConfig(readText(config.apacheConf), config.phpRoot, targetRoot, phpFiles.module, phpFiles.ts, updatedPhpIni, apache.root, apacheFiles);
  const propertiesPath = path.join(XAMPP_ROOT, 'properties.ini');
  let properties = readText(propertiesPath);
  if (!properties) throw new Error('Não consegui ler properties.ini do XAMPP.');
  const phpRootIni = targetRoot.replace(/\//g, '\\');
  const updateIniKey = (text, key, value) => {
    const line = new RegExp(`^\\s*${key}\\s*=.*$`, 'im');
    return line.test(text) ? text.replace(line, `${key}=${value}`) : `${text.trimEnd()}\r\n${key}=${value}\r\n`;
  };
  properties = updateIniKey(properties, 'php_binary_directory', phpRootIni);
  properties = updateIniKey(properties, 'base_stack_version', `${php.version}-0`);
  const oldEnvironment = readEnvironmentState();
  const baseEnvironment = {
    ...oldEnvironment,
    phpRoot: targetRoot,
    phpVersion: php.version,
    originalPhpRoot: oldEnvironment.originalPhpRoot || config.phpRoot,
    originalPhpVersion: oldEnvironment.originalPhpVersion || config.phpVersion || php.version
  };
  const nextEnvironment = apache.root.toLowerCase() === path.resolve(path.join(XAMPP_ROOT, 'apache')).toLowerCase()
    ? { ...baseEnvironment, apacheRoot: null, apacheVersion: null }
    : { ...baseEnvironment, apacheRoot: apache.root, apacheVersion: apache.version };

  const service = await inspectXamppService('apache');
  if (!service.managed) throw new Error('Para ativar uma versão, primeiro integre o serviço Apache ao XAMPP Studio na página Serviços.');
  if (![1, 4].includes(service.state)) throw new Error(`Apache está mudando de estado no Windows (${service.state}); aguarde e tente novamente.`);
  if (service.state === 1 && await checkPort(apachePort)) throw new Error(`A porta ${apachePort} está ocupada por um processo fora do serviço Apache integrado. Encerre a instância antiga pelo mecanismo que a iniciou e tente novamente.`);
  const scConfig = await execFileAsync('sc.exe', ['qc', service.serviceName], { timeout: 5000, windowsHide: true, maxBuffer: 8192 });
  const storedServiceCommand = await readServiceCommand(service.serviceName);
  const priorServiceCommand = quoteServiceCommand(storedServiceCommand || serviceCommandFromOutput(scConfig.stdout));
  if (!priorServiceCommand) throw new Error('Não consegui guardar o comando do serviço Apache para permitir a reversão.');

  const snapshot = createSwitchBackup([
    ['properties.ini', propertiesPath],
    ['httpd-xampp.conf', config.apacheConf],
    ['php.ini-target', path.join(targetRoot, 'php.ini')],
    ['active-environment.json', ENVIRONMENT_STATE],
    ['xampp-httpd.conf', path.join(XAMPP_ROOT, 'apache', 'conf', 'httpd.conf')],
    ...(apache.generatedConfig ? [['studio-httpd.conf', apacheConfig]] : [])
  ]);
  const steps = { stopAttempted: false, startAttempted: false, commandAttempted: false };
  try {
    writeAtomically(path.join(targetRoot, 'php.ini'), updatedPhpIni);
    const phpProbe = await probePhpRuntime(targetRoot, expectedPhp);
    if (apache.generatedConfig) {
      writeAtomically(apache.generatedConfig.config, apache.generatedConfig.text);
      apache.config = apache.generatedConfig.config;
    }
    writeAtomically(config.apacheConf, rewrittenPhpApache.text);
    writeAtomically(propertiesPath, properties);
    const check = await execFileAsync(apache.executable, ['-t', '-d', apache.root, '-f', apacheConfig], { cwd: apache.root, timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 });
    if (!/Syntax OK/i.test(`${check.stdout}\n${check.stderr}`)) throw new Error(`A validação do Apache não retornou “Syntax OK”: ${(check.stdout || check.stderr || '').slice(0, 360)}`);
    writeEnvironmentState(nextEnvironment);
    // Troca o comando do serviço ANTES de parar o Apache: se o Windows negar a
    // elevação, o servidor continua no ar com a configuração anterior.
    const expectedServiceCommand = apacheServiceCommand({ ...apache, config: apacheConfig });
    if (!serviceCommandMatches(storedServiceCommand, expectedServiceCommand)) {
      steps.commandAttempted = true;
      await changeApacheServiceCommand(expectedServiceCommand);
    }
    let restarted = false;
    let responding = false;
    if (service.state === 4) {
      steps.stopAttempted = true;
      await runWindowsServiceAction('stop', service.serviceName);
      await waitForXamppService('apache', 1, 30000);
      steps.startAttempted = true;
      await startApacheForActivation(service.serviceName, apache.root, apacheConfig, apachePort);
      responding = true;
      restarted = true;
    }
    const missingBundled = rewrittenPhpApache.missing;
    // A decisão final usa o estado real do runtime: uma extensão só é
    // migrada de fato quando aparece na lista de módulos carregados.
    const loadedModules = new Set((phpProbe.modules || []).map(item => String(item).toLowerCase()));
    const extensionCandidates = php.missingExtensions || [];
    const migratedExtensions = extensionCandidates.filter(item => loadedModules.has(String(item.name).toLowerCase()));
    const stillMissing = extensionCandidates.filter(item => !loadedModules.has(String(item.name).toLowerCase()));
    const warnings = [...stillMissing, ...missingBundled.map(dll => ({ name: dll, dll, directive: 'LoadFile' }))];
    const registry = persistDllRegistry(collectDllRegistry());
    return { phpVersion: phpProbe.version, phpRoot: targetRoot, phpModules: phpProbe.modules.length, apacheVersion: apache.version || (await getApacheVersion(apache.executable)), apacheRoot: apache.root, apacheRestarted: restarted, responding, backup: snapshot.directory, migratedExtensions, apacheMissingFiles: missingBundled, warnings, dllRegistryUpdatedAt: registry.updatedAt };
  } catch (error) {
    const rollback = await rollbackPhpActivation(snapshot, service.serviceName, priorServiceCommand, steps);
    throw new Error(`${error.message} ${rollback}`);
  }
}

async function getApacheVersion(executable) {
  try { const result = await execFileAsync(executable, ['-v'], { timeout: 4000, windowsHide: true, maxBuffer: 4096 }); return result.stdout.match(/Apache\/(\d+\.\d+\.\d+)/)?.[1] || null; }
  catch { return null; }
}

async function getMySqlIdentity(executable) {
  try {
    const result = await execFileAsync(executable, ['--version'], { timeout: 5000, windowsHide: true, maxBuffer: 8192 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    const product = /mariadb/i.test(output) ? 'mariadb' : 'mysql';
    const version = output.match(/\bVer\s+(\d+\.\d+\.\d+)/i)?.[1] || output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;
    return { product, version, output: output.slice(0, 240) };
  } catch {
    return { product: null, version: null, output: null };
  }
}

function preparedPhpRoot(rawRoot) {
  const root = managedPhpRoot(rawRoot);
  const config = getConfig();
  const runtimes = path.join(APP_ROOT, 'runtimes');
  const active = [config.phpRoot, config.phpIniDir].filter(Boolean).some(dir =>
    samePath(fs.existsSync(dir) ? fs.realpathSync(dir) : dir, root));
  if (active || !samePath(path.dirname(root), runtimes) || path.basename(root).startsWith('.')) {
    throw new Error('Escolha uma versão preparada e inativa do PHP na pasta runtimes do Studio.');
  }
  return root;
}

async function preparePhpExtensions(rawRoot, job) {
  const root = preparedPhpRoot(rawRoot);
  return withPhpRuntimeEdit(root, async () => {
    const target = phpBuildTarget(root);
    const runtime = getVersions().find(item => samePath(item.root, root));
    const known = phpRequirementsForVersion(currentDllRegistry().dlls, runtime?.missingExtensions);
    const required = [...known.values()];
    const before = verifyRuntimeDlls(root, required, target.version);
    const installed = [];
    const reasons = new Map();
    for (const item of before.missing) {
      if (item.kind !== 'php_extension' || item.dll.toLowerCase() === 'php_opcache.dll') {
        reasons.set(item.dll, 'Dependência do pacote PHP/Apache. Confira os arquivos do runtime selecionado.');
        continue;
      }
      const label = `Instalar ${item.name}`;
      const progress = { step: (_phase, _state, detail) => job?.step(label, 'running', detail) };
      try {
        const extension = await installPeclExtension(root, item.dll, null, null, progress, false, known.get(item.dll.toLowerCase()));
        installed.push({ name: item.name, dll: item.dll, version: extension.version });
        job?.step(label, 'succeeded', `${item.name} ${extension.version} carregada no PHP ${target.version}.`);
      } catch (error) {
        reasons.set(item.dll, error.message);
        job?.step(label, 'failed', error.message);
      }
    }

    const dllCheck = verifyRuntimeDlls(root, required, target.version);
    const present = new Set(dllCheck.details.filter(item => item.found).map(item => item.dll.toLowerCase()));
    const ini = path.join(root, 'php.ini');
    const original = readText(ini);
    if (!original) throw new Error('Não foi possível ler o php.ini desta versão.');
    const missingExtensions = new Set(dllCheck.missing.filter(item => item.kind === 'php_extension').map(item => item.dll.toLowerCase()));
    const loadable = setPhpExtensionDirectory(original, root).replace(/^[ \t]*(?:zend_extension|extension)[ \t]*=[^\r\n]+/gim, line =>
      missingExtensions.has(phpExtensionDirectives(line)[0]?.dll.toLowerCase()) ? `; ${line}` : line);
    const settings = ensureRequiredPhpExtensions(loadable, required.filter(item => present.has(item.dll.toLowerCase())), target.version);
    if (settings !== original) {
      createPhpIniBackup(root, ini);
      writeAtomically(ini, settings);
    }
    try {
      await probePhpRuntime(root, { version: target.version, architecture: target.architecture, threadSafety: target.threadSafety.toUpperCase() });
    } catch (error) {
      if (settings !== original) writeAtomically(ini, original);
      throw error;
    }
    const pending = dllCheck.missing.map(({ name, dll }) => ({ name, dll, reason: reasons.get(dll) || 'Dependência ausente.' }));
    return { root, version: target.version, dllCheck, extensionPreparation: { installed, pending } };
  });
}

async function downloadWindowsPhpRuntime(version, job) {
  job?.step('Download', 'running', `Consultando o pacote oficial do PHP ${version}.`);
  const catalog = await listWindowsPhpReleases();
  const release = catalog.versions.find(item => item.version === version);
  if (!release) throw new Error('Essa versão não está na lista oficial compatível com o PHP e o Apache atuais. Atualize a lista e tente novamente.');
  const targetRoot = path.join(APP_ROOT, 'runtimes', `php-${release.version}-${release.threadSafety.toLowerCase()}-${release.architecture}`);
  const runtimeParent = path.join(APP_ROOT, 'runtimes');
  if (!isInside(runtimeParent, targetRoot)) throw new Error('Destino do runtime inválido.');
  if (fs.existsSync(targetRoot)) {
    const metadataFile = path.join(targetRoot, 'studio-runtime.json');
    const existing = readText(metadataFile);
    let metadata;
    try { metadata = JSON.parse(existing); } catch {}
    if (!metadata || metadata.sha256 !== release.sha256 || metadata.version !== version) {
      throw new Error('Já existe outra instalação nessa pasta. Confira a versão em Versões do PHP.');
    }
    job?.step('Download', 'succeeded', 'O pacote já está preparado.');
    return { ...metadata, ...await preparePhpExtensions(targetRoot, job), alreadyPrepared: true };
  }
  const response = await fetch(release.url, { headers: { 'user-agent': 'XAMPP-Studio/0.1' }, signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`O download do PHP falhou (HTTP ${response.status}).`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length < 5 * 1024 * 1024 || archive.length > 150 * 1024 * 1024) throw new Error('Tamanho inesperado para o pacote PHP; o arquivo não foi extraído.');
  const actualHash = createHash('sha256').update(archive).digest('hex');
  if (actualHash.toLowerCase() !== release.sha256.toLowerCase()) throw new Error('O SHA-256 do pacote não confere com o catálogo oficial do PHP.');
  job?.step('Download', 'succeeded', 'Pacote oficial recebido e SHA-256 conferido.');
  job?.progress(55);
  job?.step('Preparação', 'running', 'Extraindo o PHP e migrando o php.ini.');
  const downloadRoot = path.join(APP_ROOT, 'downloads');
  fs.mkdirSync(downloadRoot, { recursive: true });
  fs.mkdirSync(runtimeParent, { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(runtimeParent, '.staging-php-'));
  const archivePath = path.join(downloadRoot, `${path.basename(stagingRoot)}.zip`);
  try {
    fs.writeFileSync(archivePath, archive, { flag: 'wx' });
    const listing = await execFileAsync('tar', ['-tf', archivePath], { timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.length > 20000 || entries.some(entry => path.isAbsolute(entry) || entry.split(/[\\/]/).some(part => part === '..'))) throw new Error('O arquivo PHP contém caminhos de extração inválidos.');
    await execFileAsync('tar', ['-xf', archivePath, '-C', stagingRoot], { timeout: 60000, windowsHide: true, maxBuffer: 32 * 1024 });
    if (!fs.existsSync(path.join(stagingRoot, 'php.exe')) || !fs.existsSync(path.join(stagingRoot, 'ext')) || !fs.existsSync(path.join(stagingRoot, 'php.ini-development'))) throw new Error('O pacote oficial não contém a estrutura PHP esperada.');
    const config = getConfig();
    const sourceIni = samePath(catalog.baseline.root, config.phpRoot)
      ? activePhpIni(config) : path.join(catalog.baseline.root, 'php.ini');
    const migrated = migratePhpIni(sourceIni, stagingRoot, release.version);
    const preparedIni = path.join(stagingRoot, 'php.ini');
    fs.writeFileSync(preparedIni, migrated.ini, { flag: 'wx' });
    job?.step('Preparação', 'succeeded', 'Configuração do PHP de referência migrada.');
    job?.progress(80);
    job?.step('Validação', 'running', 'Verificando versão, arquitetura e carregamento das extensões.');
    await probePhpRuntime(stagingRoot, release);
    fs.writeFileSync(preparedIni, setPhpExtensionDirectory(migrated.ini, targetRoot));
    const metadata = { version: release.version, threadSafety: release.threadSafety, architecture: release.architecture, compiler: release.compiler, source: release.url, sha256: actualHash, extensions: migrated.extensions, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(stagingRoot, 'studio-runtime.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' });
    fs.renameSync(stagingRoot, targetRoot);
    job?.step('Validação', 'succeeded', 'PHP preparado para revisão antes da ativação.');
    return { ...metadata, ...await preparePhpExtensions(targetRoot, job) };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

async function handler(req, res) {
  if (!trustedLocalRequest(req)) {
    // Drena o corpo rejeitado: sem isso, um POST grande de origem
    // não autorizada deixa a conexão pendurada até o cliente desistir.
    req.resume();
    return json(res, 403, { error: 'Acesso permitido apenas pelo navegador local do XAMPP Studio.' });
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/extensions/downloads') {
      const rawRoot = url.searchParams.get('phpRoot');
      if (!rawRoot) return json(res, 400, { error: 'Selecione uma versão do PHP para consultar seus downloads.' });
      const phpRoot = managedPhpRoot(rawRoot);
      return json(res, 200, { phpRoot, downloads: listExtensionDownloads(path.join(APP_ROOT, 'downloads', 'extensions'), phpRoot, id => jobManager.get(id)) });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/extensions/downloads/')) {
      const match = url.pathname.match(/^\/api\/extensions\/downloads\/([a-f0-9-]{36})\/([a-zA-Z0-9_.-]+\.(?:dll|zip))$/);
      if (!match) return json(res, 404, { error: 'Download não encontrado.' });
      const file = path.join(APP_ROOT, 'downloads', 'extensions', match[1], match[2]);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'Download não encontrado.' });
      const bytes = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'content-disposition': `attachment; filename="${match[2]}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(bytes);
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await scanStatus());
    if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
      return json(res, 200, await collectDiagnostics());
    }
    if (req.method === 'GET' && url.pathname === '/api/diagnostics/export') {
      const report = await collectDiagnostics();
      const markdown = renderDiagnosticsMarkdown(report);
      const fileName = `diagnostico-xampp-studio-${report.generatedAt.replace(/[:.]/g, '-')}.md`;
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': Buffer.byteLength(markdown),
        'content-disposition': `attachment; filename="${fileName}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      return res.end(markdown);
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      return json(res, 200, { jobs: jobManager.list({ type: url.searchParams.get('type'), limit: url.searchParams.get('limit') }) });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
      const job = jobManager.get(url.pathname.slice('/api/jobs/'.length));
      return job ? json(res, 200, { job }) : json(res, 404, { error: 'Operação não encontrada.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/services/restart') {
      const body = await readBody(req);
      if (!['apache', 'mysql'].includes(body.service)) return json(res, 400, { error: 'Escolha Apache ou MySQL/MariaDB.' });
      return json(res, 200, await restartXamppService(body.service));
    }
    if (req.method === 'POST' && url.pathname === '/api/services/stop') {
      const body = await readBody(req);
      if (!['apache', 'mysql'].includes(body.service)) return json(res, 400, { error: 'Escolha Apache ou MySQL/MariaDB.' });
      return json(res, 200, await stopXamppService(body.service));
    }
    if (req.method === 'POST' && url.pathname === '/api/xampp/action') {
      const body = await readBody(req);
      const action = typeof body.action === 'string' ? body.action : '';
      if (!['shell', 'explorer', 'logs', 'config', 'admin'].includes(action)) return json(res, 400, { error: 'Ação do XAMPP não reconhecida.' });
      const component = typeof body.component === 'string' ? body.component : null;
      if (component && !XAMPP_ACTION_COMPONENTS.has(component)) return json(res, 400, { error: 'Componente inválido.' });
      return json(res, 200, { ok: true, ...(await performXamppAction(action, component)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/netstat') return json(res, 200, await listNetstatEntries());
    if (req.method === 'POST' && url.pathname === '/api/studio/restart') {
      json(res, 200, { restarting: true, message: 'O XAMPP Studio vai recarregar em alguns segundos.' });
      setTimeout(() => {
        const script = path.join(APP_ROOT, 'start.ps1');
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-AsAdmin'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
          cwd: APP_ROOT
        });
        // Uma falha de spawn aqui não pode virar uncaughtException depois
        // que a resposta de reinício já foi entregue ao navegador.
        child.once('error', () => {});
        child.unref();
      }, 400);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/services/integrate') {
      const body = await readBody(req);
      if (!['apache', 'mysql'].includes(body.service)) return json(res, 400, { error: 'Escolha Apache ou MySQL/MariaDB para integrar.' });
      return json(res, 201, await registerXamppService(body.service));
    }
    if (req.method === 'POST' && url.pathname === '/api/services/grant-control') {
      const body = await readBody(req);
      if (!['apache', 'mysql'].includes(body.service)) return json(res, 400, { error: 'Escolha Apache ou MySQL/MariaDB.' });
      return json(res, 200, await grantXamppServiceControl(body.service));
    }
    if (req.method === 'POST' && url.pathname === '/api/services/repair') {
      const body = await readBody(req);
      if (!['apache', 'mysql'].includes(body.service)) return json(res, 400, { error: 'Escolha Apache ou MySQL/MariaDB.' });
      return json(res, 200, await repairXamppService(body.service));
    }
    if (req.method === 'POST' && url.pathname === '/api/services/start-type') {
      const body = await readBody(req);
      // Allowlist: o endpoint repassa o nome ao helper elevado (UAC), então
      // só os dois serviços gerenciados pelo Studio são aceitos.
      const managed = [serviceNameFor('apache'), serviceNameFor('mysql')];
      if (!managed.includes(body.serviceName)) return json(res, 400, { error: 'Escolha o serviço Apache ou MySQL/MariaDB gerenciado pelo Studio.' });
      return json(res, 200, await setServiceStartType(body.serviceName, body.startType));
    }
    if (req.method === 'POST' && url.pathname === '/api/apache/port') {
      const body = await readBody(req);
      const result = await changeApachePort(body.port);
      return json(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/api/versions') return json(res, 200, getVersionsWithDllChecks());
    if (req.method === 'GET' && url.pathname === '/api/dlls') return json(res, 200, { registry: syncDllRegistry() });
    if (req.method === 'POST' && url.pathname === '/api/dlls/refresh') return json(res, 200, { registry: persistDllRegistry() });
    if (req.method === 'POST' && url.pathname === '/api/dlls/verify') {
      const body = await readBody(req);
      if (typeof body.phpRoot !== 'string' || !path.isAbsolute(body.phpRoot)) return json(res, 400, { error: 'Informe o caminho absoluto do runtime PHP.' });
      const targetRoot = path.resolve(body.phpRoot);
      if ((!isInside(path.join(APP_ROOT, 'runtimes'), targetRoot) && !isInside(XAMPP_ROOT, targetRoot)) || !fs.existsSync(path.join(targetRoot, 'php.exe'))) {
        return json(res, 400, { error: 'O runtime precisa estar dentro do XAMPP configurado ou de runtimes/ do XAMPP Studio.' });
      }
      const registry = currentDllRegistry();
      return json(res, 200, { ...verifyRuntimeDlls(targetRoot, registry.dlls), registry });
    }
    if (req.method === 'POST' && url.pathname === '/api/dlls/search') {
      const body = await readBody(req);
      if (typeof body.phpRoot !== 'string' || !path.isAbsolute(body.phpRoot)) return json(res, 400, { error: 'Informe o caminho absoluto do runtime PHP.' });
      return json(res, 200, await searchMissingDlls(body.phpRoot));
    }
    if (req.method === 'POST' && url.pathname === '/api/pecl/versions') {
      const body = await readBody(req);
      if (typeof body.phpRoot !== 'string' || !path.isAbsolute(body.phpRoot)) return json(res, 400, { error: 'Informe o caminho absoluto do runtime PHP.' });
      if (typeof body.dll !== 'string' && typeof body.package !== 'string') return json(res, 400, { error: 'Informe a DLL ou o pacote PECL.' });
      return json(res, 200, await searchPeclVersions(body.phpRoot, body.dll, body.package, body.refresh === true));
    }
    if (req.method === 'POST' && ['/api/dlls/auto-install', '/api/extensions/download'].includes(url.pathname)) {
      const body = await readBody(req);
      if (typeof body.phpRoot !== 'string' || !path.isAbsolute(body.phpRoot)) return json(res, 400, { error: 'Informe o caminho absoluto do runtime PHP.' });
      if (typeof body.dll !== 'string' && typeof body.package !== 'string') return json(res, 400, { error: 'Informe a DLL ou o pacote PECL.' });
      const downloadOnly = url.pathname === '/api/extensions/download';
      managedPhpRoot(body.phpRoot);
      extensionName(body.package || body.dll);
      const job = jobManager.create(downloadOnly ? 'php-extension.download' : 'php-extension.install', {
        phpRoot: path.resolve(body.phpRoot),
        dll: typeof body.dll === 'string' ? body.dll : null,
        package: typeof body.package === 'string' ? body.package : null,
        buildFile: typeof body.buildFile === 'string' ? body.buildFile : null
      }, context => downloadOnly
        ? installPeclExtension(body.phpRoot, body.dll, body.package, body.buildFile, context, true)
        : withPhpRuntimeEdit(managedPhpRoot(body.phpRoot), () => installPeclExtension(body.phpRoot, body.dll, body.package, body.buildFile, context)));
      return json(res, 202, { job });
    }
    if (req.method === 'GET' && url.pathname === '/api/php/releases') return json(res, 200, await listWindowsPhpReleases());
    if (req.method === 'GET' && url.pathname === '/api/apache/releases') return json(res, 200, await listWindowsApacheReleases());
    if (req.method === 'GET' && url.pathname === '/api/apache/prepared') return json(res, 200, { runtimes: listPreparedApacheRuntimes() });
    if (req.method === 'POST' && url.pathname === '/api/apache/install') {
      const body = await readBody(req);
      if (typeof body.version !== 'string' || typeof body.build !== 'string') return json(res, 400, { error: 'Informe versão e build do Apache listados.' });
      return json(res, 201, await downloadWindowsApacheRuntime(body.version, body.build));
    }
    if (req.method === 'POST' && url.pathname === '/api/apache/install-async') {
      const body = await readBody(req);
      if (typeof body.version !== 'string' || typeof body.build !== 'string') return json(res, 400, { error: 'Informe versão e build do Apache listados.' });
      const job = jobManager.create('apache.install', { version: body.version, build: body.build }, context => {
        context.step('download', 'running', `Baixando Apache ${body.version} build ${body.build}.`);
        return downloadWindowsApacheRuntime(body.version, body.build).then(result => {
          context.step('download', 'succeeded', result.alreadyPrepared ? `Apache ${result.version} já estava preparado.` : `Apache ${result.version} preparado e SHA-256 conferido.`);
          return result;
        });
      });
      return json(res, 202, { job });
    }
    if (req.method === 'GET' && url.pathname === '/api/mysql/releases') return json(res, 200, await listDatabaseReleases({ limit: 8 }));
    if (req.method === 'GET' && url.pathname === '/api/mysql/prepared') return json(res, 200, { runtimes: listPreparedMySqlRuntimes() });
    if (req.method === 'POST' && url.pathname === '/api/mysql/install-async') {
      const body = await readBody(req);
      if (typeof body.releaseId !== 'string') return json(res, 400, { error: 'Informe a versão do banco selecionada no catálogo.' });
      const job = jobManager.create('mysql.install', { releaseId: body.releaseId }, context => downloadWindowsDatabaseRuntime(body.releaseId, context));
      return json(res, 202, { job });
    }
    if (req.method === 'POST' && url.pathname === '/api/mysql/switch') {
      const body = await readBody(req);
      if (typeof body.mysqlRoot !== 'string' || !path.isAbsolute(body.mysqlRoot)) return json(res, 400, { error: 'Escolha um runtime MySQL/MariaDB preparado.' });
      return json(res, 200, await switchMySqlRuntime(body.mysqlRoot));
    }
    if (req.method === 'POST' && url.pathname === '/api/php/extensions/prepare-async') {
      const body = await readBody(req);
      if (typeof body.phpRoot !== 'string' || !path.isAbsolute(body.phpRoot)) return json(res, 400, { error: 'Escolha uma versão PHP preparada.' });
      const root = preparedPhpRoot(body.phpRoot);
      const type = 'php.extensions.prepare';
      const active = jobManager.list({ type, limit: 100 }).find(item =>
        samePath(item.payload.phpRoot, root) && ['queued', 'running'].includes(item.status));
      const job = active || jobManager.create(type, { phpRoot: root }, context => preparePhpExtensions(root, context));
      return json(res, 202, { job });
    }
    if (req.method === 'POST' && (url.pathname === '/api/php/install' || url.pathname === '/api/php/install-async')) {
      const body = await readBody(req);
      if (typeof body.version !== 'string' || !/^\d+\.\d+\.\d+(?:-\d+)?$/.test(body.version)) return json(res, 400, { error: 'Informe a versão PHP da lista oficial.' });
      if (url.pathname.endsWith('-async')) {
        const existing = jobManager.list({ type: 'php.install', limit: 100 }).find(item =>
          item.payload.version === body.version && ['queued', 'running'].includes(item.status));
        const job = existing || jobManager.create('php.install', { version: body.version }, context => downloadWindowsPhpRuntime(body.version, context));
        return json(res, 202, { job });
      }
      return json(res, 201, await downloadWindowsPhpRuntime(body.version));
    }
    if (req.method === 'POST' && (url.pathname === '/api/environment/activate' || url.pathname === '/api/environment/switch')) {
      const body = await readBody(req);
      if (typeof body.phpRoot !== 'string' || !path.isAbsolute(body.phpRoot)) return json(res, 400, { error: 'Escolha um runtime PHP instalado.' });
      if (body.apacheRoot != null && (typeof body.apacheRoot !== 'string' || !path.isAbsolute(body.apacheRoot))) return json(res, 400, { error: 'Escolha um runtime Apache preparado.' });
      if (phpActivationInProgress) return json(res, 409, { error: 'Já existe uma troca de PHP em andamento. Aguarde a conclusão.' });
      if (editingPhpRoots.size) return json(res, 409, { error: 'Aguarde a conclusão da configuração do PHP antes de ativar outra versão.' });
      phpActivationInProgress = true;
      try {
        const standalone = body.mode === 'standalone' || (url.pathname === '/api/environment/activate' && body.mode !== 'legacy');
        if (!standalone) return json(res, 200, await switchEnvironment(body.phpRoot, body.apacheRoot || null));
        const previous = readEnvironmentState();
        writeEnvironmentState(await buildStandaloneModeState(previous));
        try {
          return json(res, 200, await switchStandaloneEnvironment(body.phpRoot, body.apacheRoot || null));
        } catch (error) {
          writeEnvironmentState(previous);
          throw error;
        }
      } finally {
        phpActivationInProgress = false;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/php/settings') return json(res, 200, readPhpSettings(url.searchParams.get('phpRoot')));
    if (req.method === 'POST' && url.pathname === '/api/php/settings') {
      const body = await readBody(req);
      const root = managedPhpRoot(body.phpRoot);
      return json(res, 200, await withPhpRuntimeEdit(root, () => applyPhpSettings(body.values, root)));
    }
    if (req.method === 'GET' && url.pathname === '/api/performance') return json(res, 200, getPerformanceSettings());
    if (req.method === 'POST' && url.pathname === '/api/performance/apply') {
      const body = await readBody(req);
      return json(res, 200, await applyPerformanceSettings(body.apacheShare));
    }
    if (req.method === 'GET' && url.pathname === '/api/firewall/logs') {
      let filters;
      try { filters = readFirewallFilters(url.searchParams); }
      catch (error) { return json(res, 400, { error: error.message }); }
      const { files, piped, windowsLogging } = await firewallLogFiles();
      const blocked = new Set(managedBlockedIps().map(item => item.ip));
      const result = readFirewallPage(files, { ...filters, blocked });
      return json(res, 200, { ...result, piped, windowsLogging, checkedAt: new Date().toISOString() });
    }
    if (req.method === 'POST' && url.pathname === '/api/firewall/logs/open') {
      const { id } = await readBody(req);
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return json(res, 400, { error: 'Selecione um arquivo da lista de logs.' });
      if (process.platform !== 'win32') return json(res, 400, { error: 'O Bloco de Notas está disponível no Windows.' });
      const { files } = await firewallLogFiles();
      let file;
      try { file = editorLogPath(files, id); }
      catch (error) {
        if (['EACCES', 'EPERM'].includes(error.code)) return json(res, 403, { error: 'O Windows negou acesso ao arquivo. Abra o Studio como administrador.' });
        if (error.code !== 'ENOENT') throw error;
      }
      if (!file) return json(res, 404, { error: 'O arquivo de log não está mais disponível. Atualize os registros.' });
      const notepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
      await launchDetached(notepad, [file]);
      return json(res, 200, { opened: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/firewall/blocks') return json(res, 200, { blockedIps: managedBlockedIps(), cloudflareActive: Boolean(firewallState().cloudflare?.active) });
    if (req.method === 'GET' && url.pathname === '/api/firewall/body-capture') return json(res, 200, getBodyCaptureStatus());
    if (req.method === 'POST' && url.pathname === '/api/firewall/body-capture') {
      const body = await readBody(req);
      if (typeof body.active !== 'boolean') return json(res, 400, { error: 'Informe se a captura filtrada deve ser ativada ou desativada.' });
      return json(res, 200, await setBodyCapture(body.active));
    }
    if (req.method === 'POST' && url.pathname === '/api/firewall/block') {
      const body = await readBody(req);
      return json(res, 201, await blockFirewallIp(body.ip));
    }
    if (req.method === 'POST' && url.pathname === '/api/firewall/unblock') {
      const body = await readBody(req);
      return json(res, 200, await unblockFirewallIp(body.ip));
    }
    if (req.method === 'GET' && url.pathname === '/api/firewall/cloudflare/preview') return json(res, 200, await cloudflarePreview());
    if (req.method === 'POST' && url.pathname === '/api/firewall/cloudflare') {
      const body = await readBody(req);
      if (typeof body.active !== 'boolean') return json(res, 400, { error: 'Informe se a restrição Cloudflare deve ser ativada ou removida.' });
      return json(res, 200, await setCloudflareRestriction(body.active));
    }
    if (req.method === 'GET' && url.pathname === '/api/extensions/search') {
      return json(res, 200, await searchExtensionCatalog(url.searchParams.get('q')));
    }
    if (req.method === 'POST' && url.pathname === '/api/runtime/inspect') {
      const body = await readBody(req);
      return json(res, 200, inspectRuntime(body.path));
    }
    if (req.method === 'POST' && url.pathname === '/api/sql/analyze') {
      const body = await readBody(req);
      if (typeof body.sql !== 'string') return json(res, 400, { error: 'Envie o texto SQL no campo sql.' });
      return json(res, 200, analyzeSql(body.sql));
    }
    if (req.method === 'POST' && url.pathname === '/api/backup') return json(res, 201, await createBackup());
    if (STATIC_FILES.has(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      const [file, contentType] = STATIC_FILES.get(url.pathname);
      const bytes = fs.readFileSync(path.join(APP_ROOT, file));
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': bytes.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // A interface não usa CDN, scripts inline nem imagens externas; o
        // único data: é o favicon. A CSP fecha a porta a injeções.
        'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'"
      });
      return res.end(req.method === 'HEAD' ? undefined : bytes);
    }
    return json(res, 404, { error: 'Rota não encontrada.' });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
}

const server = http.createServer(handler);
server.requestTimeout = 8000;
server.headersTimeout = 5000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`XAMPP Studio em http://127.0.0.1:${PORT}`);
  console.log(`XAMPP monitorado: ${XAMPP_ROOT}`);
  console.log('Acesso restrito ao computador local; alteracoes exigem confirmacao na interface.');
});
