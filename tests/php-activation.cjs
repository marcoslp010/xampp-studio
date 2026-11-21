'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { apachePrimaryPort } = require('../lib/apache-config.cjs');
const { apacheErrorLogPath, apacheErrorLogSize, apacheExtensionLoadFailures, apacheStartupLogDetail, escapeRegExp, extensionDllName, isBuiltinOpcache, phpExtensionDirectives, rewriteXamppPhpConfig } = require('../lib/php-compat.cjs');
const { isInside, samePath, readText, writeAtomically } = require('../lib/runtime-state.cjs');
const { APACHE_PORT_TIMEOUT_MS, APACHE_START_TIMEOUT_MS, serviceExitCodes } = require('../lib/services.cjs');

// Carrega as rotinas de ativação sem iniciar a API ou abrir serviços do Windows.
const source = fs.readFileSync(path.join(__dirname, '../server.cjs'), 'utf8');
function functionsBetween(first, last) {
  const begin = source.indexOf(first);
  const end = source.indexOf(last, begin);
  assert.ok(begin >= 0 && end > begin);
  return source.slice(begin, end);
}
const routines = [
  functionsBetween('function activePhpIni(', 'function migratePhpIni('),
  functionsBetween('function setPhpExtensionDirectory(', 'function apacheCertificateStatus('),
  functionsBetween('function createSwitchBackup(', 'async function changeApachePort('),
  functionsBetween('async function switchStandaloneEnvironment(', 'async function getApacheVersion(')
].join('\n');

function fixture(t, mode, { state = 4, syntax = true, responsive = true, startupFails = false } = {}) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-php-'));
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  const xampp = path.join(app, 'xampp');
  const target = path.join(app, 'runtimes', 'PHP 8.2');
  const apacheRoot = path.join(xampp, 'apache');
  const apache = { root: apacheRoot, config: path.join(apacheRoot, 'conf', 'httpd.conf'), executable: path.join(apacheRoot, 'bin', 'httpd.exe'), version: '2.4.0' };
  const config = { phpRoot: path.join(xampp, 'php'), phpVersion: '8.2.1', apacheConf: path.join(apacheRoot, 'conf', 'extra', 'httpd-xampp.conf') };
  const phpIni = path.join(target, 'php.ini');
  const stateFile = path.join(app, 'environment-state.json');
  const generatedFile = path.join(apacheRoot, 'conf', 'xampp-studio-httpd.conf');
  const errorLog = path.join(apacheRoot, 'logs', 'active error.log');
  const apacheConfig = 'Listen 8088\nErrorLog "logs/active error.log"';
  const events = [];
  const startupTimeouts = [];
  let starts = 0;
  for (const name of ['php.exe', 'php8apache2_4.dll', 'php8ts.dll']) writeAtomically(path.join(target, name), '');
  writeAtomically(phpIni, 'memory_limit=256M');
  writeAtomically(apache.config, apacheConfig);
  writeAtomically(errorLog, '[core:error] Erro de uma tentativa anterior\n');
  writeAtomically(apache.executable, '');
  writeAtomically(path.join(xampp, 'properties.ini'), 'base_stack_version=8.2.1-0');
  writeAtomically(config.apacheConf, 'LoadFile "C:/PHP antigo/php8ts.dll"\nLoadModule php_module "C:/PHP antigo/php8apache2_4.dll"\nPHPINIDir "C:/ini antigo"');
  const service = () => ({ managed: true, state, serviceName: 'Apache' });
  const context = vm.createContext({
    fs, path, process: { platform: 'win32' }, createHash, readText, writeAtomically, isInside, samePath,
    APP_ROOT: app, XAMPP_ROOT: xampp, BACKUP_ROOT: path.join(app, 'backups'), ENVIRONMENT_STATE: stateFile,
    getConfig: () => config, activeApacheRuntime: () => apache, isStandaloneMode: () => mode === 'standalone',
    getVersions: () => [{ version: '8.2.2', root: target, architecture: 'x64', threadSafety: 'TS' }],
    readEnvironmentState: () => JSON.parse(readText(stateFile) || '{}'),
    writeEnvironmentState: value => writeAtomically(stateFile, JSON.stringify(value)),
    phpExtensionDirectives, isBuiltinOpcache, rewriteXamppPhpConfig, apachePrimaryPort,
    currentDllRegistry: () => ({ dlls: [] }), verifyRuntimeDlls: () => ({ compatible: true }),
    collectDllRegistry: () => ({}), persistDllRegistry: () => ({}),
    apacheConfigFiles: () => [], phpRuntimeApacheConflicts: () => [],
    APACHE_PORT_TIMEOUT_MS, APACHE_START_TIMEOUT_MS, apacheErrorLogPath, apacheErrorLogSize, apacheExtensionLoadFailures, apacheStartupLogDetail,
    makeStandaloneApacheConfig: () => ({ config: generatedFile, text: apacheConfig }),
    probePhpRuntime: () => {
      assert.ok(readText(phpIni).includes(target.replace(/\\/g, '/') + '/ext'), 'a validação deve usar o ini final');
      return { version: '8.2.2', modules: [], threadSafety: 'TS' };
    },
    execFileAsync: file => ({ stdout: file === apache.executable && syntax ? 'Syntax OK' : '', stderr: '' }),
    inspectXamppService: service,
    waitForXamppService: (_, desired, timeout) => {
      if (desired === 4) startupTimeouts.push(timeout);
      if (desired === 4 && state === 1) throw Error('O Apache ficou parado (estado Windows 1).');
      assert.equal(state, desired);
      return service();
    },
    runWindowsServiceAction: action => {
      events.push(action);
      if (action === 'start' && ++starts === 1 && startupFails) {
        fs.appendFileSync(errorLog, '[mpm_winnt:error] AH00451: Não foi possível abrir a porta\n');
      } else {
        state = action === 'start' ? 4 : 1;
      }
    },
    readServiceCommand: () => 'original', quoteServiceCommand: command => command, apacheServiceCommand: () => 'new',
    serviceCommandMatches: (a, b) => a === b, changeApacheServiceCommand: command => events.push(command),
    checkPort: port => { events.push(`check ${port}`); return false; },
    waitForPort: (port, timeout) => { assert.equal(timeout, 45000); events.push(`wait ${port}`); return responsive; }
  });
  vm.runInContext(routines, context);
  return { run: () => context.switchEnvironment(target), context, events, target, config, phpIni, stateFile, generatedFile, startupTimeouts };
}

for (const mode of ['legacy', 'standalone']) {
  test(`${mode}: erro de sintaxe restaura arquivos sem parar o Apache original`, async t => {
    const f = fixture(t, mode, { syntax: false });
    await assert.rejects(f.run(), /Syntax OK/);
    assert.deepEqual(f.events, []);
    assert.equal(readText(f.phpIni), 'memory_limit=256M');
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.equal(fs.existsSync(f.generatedFile), false);
    assert.ok(readText(f.config.apacheConf).includes('ini antigo'));
  });

  test(`${mode}: falha na porta da nova versão recoloca o serviço e os arquivos originais`, async t => {
    const f = fixture(t, mode, { responsive: false });
    writeAtomically(f.generatedFile, 'configuração anterior');
    await assert.rejects(f.run(), /8088/);
    assert.deepEqual(f.events, ['new', 'stop', 'start', 'wait 8088', 'stop', 'original', 'start']);
    assert.equal(fs.existsSync(f.stateFile), false);
    assert.equal(readText(f.generatedFile), 'configuração anterior');
    assert.ok(readText(f.config.apacheConf).includes('ini antigo'));
  });

  test(`${mode}: Apache parado permanece parado e a porta verificada é a configurada`, async t => {
    const f = fixture(t, mode, { state: 1 });
    const result = await f.run();
    assert.equal(result.apacheRestarted, false);
    assert.deepEqual(f.events, ['check 8088', 'new']);
    assert.equal(JSON.parse(readText(f.stateFile)).phpRoot, f.target);
    if (mode === 'legacy') assert.ok(readText(f.config.apacheConf).includes(`PHPINIDir "${f.target.replace(/\\/g, '/')}"`));
  });

  test(`${mode}: falha na partida exibe somente erros novos do arquivo e restaura o Apache`, async t => {
    const f = fixture(t, mode, { startupFails: true });
    await assert.rejects(f.run(), error => {
      assert.match(error.message, /estado Windows 1/);
      assert.match(error.message, /active error\.log/);
      assert.match(error.message, /AH00451/);
      assert.doesNotMatch(error.message, /tentativa anterior/);
      assert.match(error.message, /As configurações anteriores foram restauradas/);
      return true;
    });
    assert.deepEqual(f.startupTimeouts, [120000, 120000]);
    assert.deepEqual(f.events, ['new', 'stop', 'start', 'original', 'start']);
  });
}

test('espera o Apache que sobe devagar e identifica o Apache que volta ao estado parado', async () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '../lib/services.cjs'), 'utf8');
  const begin = serviceSource.indexOf('async function waitForXamppService(');
  const end = serviceSource.indexOf('async function waitForPort(', begin);
  let time = 0;
  let status = () => ({ state: time >= 70000 ? 4 : 2 });
  const context = vm.createContext({
    Date: { now: () => time },
    setTimeout: (resolve, duration) => { time += duration; resolve(); },
    inspectXamppService: () => ({ managed: true, label: 'Apache', ...status() })
  });
  vm.runInContext(serviceSource.slice(begin, end), context);
  const wait = () => context.waitForXamppService('apache', 4, APACHE_START_TIMEOUT_MS);
  assert.equal((await wait()).state, 4);
  assert.equal(time, 70000);

  time = 0;
  status = () => time ? { state: 1, win32ExitCode: 1066, serviceExitCode: 1 } : { state: 2 };
  await assert.rejects(wait(), /estado Windows 1.*Windows 1066, serviço 1/);
  assert.equal(time, 500);

  time = 0;
  status = () => ({ state: 2 });
  await assert.rejects(wait(), /estado Windows 2.*120 segundos/);
  assert.equal(time, 120000);
  assert.deepEqual(serviceExitCodes('WIN32_EXIT_CODE : 1066 (0x42a)\nSERVICE_EXIT_CODE : 1 (0x1)'), { win32ExitCode: 1066, serviceExitCode: 1 });
  assert.deepEqual(serviceExitCodes('CÓDIGO_DE_SAÍDA_DO_WIN32 : 1066 (0x42a)\nCÓDIGO_DE_SAÍDA_DO_SERVIÇO : 1 (0x1)'), { win32ExitCode: 1066, serviceExitCode: 1 });
});

test('a migração usa PHPINIDir válido do Apache e recorre ao ini do runtime quando ausente', t => {
  const f = fixture(t, 'legacy');
  const dir = path.join(f.config.phpRoot, 'web');
  const config = { ...f.config, phpIniDir: dir };
  assert.equal(f.context.activePhpIni(config), path.join(f.config.phpRoot, 'php.ini'));
  writeAtomically(path.join(dir, 'php.ini'), 'memory_limit=64M');
  assert.equal(f.context.activePhpIni(config), path.join(dir, 'php.ini'));
});

test('o PHP preparado usa suas próprias extensões durante a validação e depois da publicação', t => {
  const f = fixture(t, 'legacy');
  f.context.extensionDllName = extensionDllName;
  vm.runInContext(functionsBetween('function migratePhpIni(', 'async function probePhpRuntime('), f.context);
  const staging = path.join(f.target, 'staging');
  writeAtomically(path.join(staging, 'ext', 'php_mysqli.dll'), '');
  writeAtomically(f.phpIni, [
    'memory_limit=192M', 'extension_dir=ext', 'extension_dir=C:/PHP-old/ext',
    'extension="C:/PHP-old/ext/php_mysqli.dll"', 'extension=redis'
  ].join('\r\n'));
  const prepared = f.context.migratePhpIni(f.phpIni, staging, '8.2.36');
  assert.deepEqual([...prepared.extensions.migrated], ['mysqli']);
  assert.equal(prepared.extensions.missing[0].dll, 'php_redis.dll');
  const published = f.context.setPhpExtensionDirectory(prepared.ini, f.target);
  for (const [ini, dir] of [[prepared.ini, staging], [published, f.target]]) {
    assert.ok(ini.includes('memory_limit=192M'));
    assert.match(ini, /^extension=php_mysqli\.dll$/m);
    const extDir = path.join(dir, 'ext').replace(/\\/g, '/');
    assert.deepEqual(ini.split(/\r?\n/).filter(line => line.startsWith('extension_dir=')), Array(2).fill(`extension_dir="${extDir}"`));
  }
});

test('a lista de versões deixa de apontar uma extensão instalada e habilitada como pendente', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ext-list-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const required = ['redis', 'apcu', 'opentelemetry'].map(name => ({
    name, dll: `php_${name}.dll`, directive: 'extension'
  }));
  const context = vm.createContext({
    fs, path, readText, phpExtensionDirectives, isBuiltinOpcache, samePath, APP_ROOT: root,
    currentDllRegistry: () => ({ dlls: [] }),
    getVersions: () => [{ root, missingExtensions: required }],
    activeApacheRuntime: () => null,
    verifyRuntimeDlls: () => ({})
  });
  vm.runInContext(functionsBetween('function existingFile(', 'function findRuntimeDllByPattern('), context);
  vm.runInContext(functionsBetween('function pendingPhpExtensions(', 'function activePhpIni('), context);
  const pending = () => Array.from(context.getVersionsWithDllChecks().versions[0].missingExtensions, item => item.name);
  for (const item of required) writeAtomically(path.join(root, 'ext', item.dll), 'test');
  writeAtomically(path.join(root, 'php.ini'), 'extension=redis\n;extension=apcu\nextension=php_opentelemetry.dll');
  assert.deepEqual(pending(), ['apcu']);
  writeAtomically(path.join(root, 'php.ini'), 'extension=redis\nextension=apcu\nextension=php_opentelemetry.dll');
  assert.deepEqual(pending(), []);
  fs.unlinkSync(path.join(root, 'ext', 'php_redis.dll'));
  assert.deepEqual(pending(), ['redis']);
  assert.equal(required.length, 3);
});

test('OPcache integrado do PHP 8.5 dispensa a DLL e preserva a política do php.ini', t => {
  const f = fixture(t, 'legacy');
  Object.assign(f.context, { extensionDllName });
  vm.runInContext(functionsBetween('function runtimeDllFiles(', 'const PECL_VERSION_CACHE'), f.context);
  vm.runInContext(functionsBetween('function migratePhpIni(', 'function setPhpExtensionDirectory('), f.context);
  const ini = 'zend_extension="C:/php antigo/ext/php_opcache.dll"\r\nopcache.enable=0\r\nopcache.enable_cli=0';
  const required = [{ name: 'opcache', dll: 'php_opcache.dll', kind: 'php_extension', directive: 'zend_extension' }];
  writeAtomically(f.phpIni, ini);
  const prepare = version => f.context.migratePhpIni(f.phpIni, f.target, version);
  assert.deepEqual(Array.from(prepare('8.4.12').extensions.missing, item => item.dll), ['php_opcache.dll']);
  const migrated = prepare('8.5.13');
  assert.equal(migrated.extensions.missing.length, 0);
  for (const text of [migrated.ini, f.context.ensureRequiredPhpExtensions(ini, required, '8.5.13')]) {
    assert.deepEqual(phpExtensionDirectives(text), []);
    assert.match(text, /^opcache.enable=0$/m);
    assert.match(text, /^opcache.enable_cli=0$/m);
  }
  assert.equal(f.context.verifyRuntimeDlls(f.target, required, '8.4.12').compatible, false);
  const builtin = f.context.verifyRuntimeDlls(f.target, required, '8.5.13').details[0];
  assert.equal(builtin.builtIn, true);
  assert.equal(builtin.path, null);
  f.context.execFileAsync = (_exe, args) => ({ stdout: args.includes('-m') ? 'Core\nredis\n' : '8.5.13|TS|64' });
  return assert.rejects(f.context.probePhpRuntime(f.target), /sem o OPcache integrado/);
});

test('Baixar pendentes preserva sucessos parciais e repete apenas extensões ausentes', async t => {
  const f = fixture(t, 'legacy');
  const item = name => ({ name, dll: `php_${name}.dll`, kind: 'php_extension', directive: 'extension' });
  const redis = item('redis');
  const legacy = { ...item('legado'), directive: 'zend_extension' };
  const unsupported = item('incompativel');
  const opcache = { ...item('opcache'), directive: 'zend_extension' };
  const downloads = [];
  let buildAvailable = false;
  Object.assign(f.context, {
    escapeRegExp, managedPhpRoot: value => value, phpBuildTarget: () => ({ version: '8.5.13', architecture: 'x64', threadSafety: 'ts' }),
    getVersions: () => [{ root: f.target, missingExtensions: [redis, legacy, unsupported] }],
    currentDllRegistry: () => ({ dlls: [redis, opcache] }), createPhpIniBackup: () => {},
    installPeclExtension: async (root, dll, _pkg, _build, _progress, _downloadOnly, requirement) => {
      downloads.push(dll);
      if (dll === unsupported.dll && !buildAvailable) throw Error('Sem build compatível');
      if (dll === legacy.dll) assert.equal(requirement.directive, 'zend_extension');
      writeAtomically(path.join(root, 'ext', dll), 'test');
      return { version: '1.0.0' };
    },
    probePhpRuntime: () => {
      const enabled = phpExtensionDirectives(readText(f.phpIni));
      assert.ok(enabled.some(item => item.name === 'redis'));
      assert.ok(enabled.some(item => item.name === 'legado' && item.directive === 'zend_extension'));
      assert.equal(enabled.some(item => item.name === 'opcache'), false);
      assert.equal(enabled.some(item => item.name === 'incompativel'), buildAvailable);
    }
  });
  vm.runInContext(functionsBetween('let phpActivationInProgress', 'function json('), f.context);
  vm.runInContext(functionsBetween('function runtimeDllFiles(', 'const PECL_VERSION_CACHE'), f.context);
  vm.runInContext(functionsBetween('function phpRequirementsForVersion(', 'function getVersionsWithDllChecks('), f.context);
  vm.runInContext(functionsBetween('function preparedPhpRoot(', 'async function downloadWindowsPhpRuntime('), f.context);
  writeAtomically(f.phpIni, 'zend_extension=opcache\nextension=incompativel\nextension="C:/php-antigo/ext/php_redis.dll" ; manter comentário');
  await assert.rejects(f.context.preparePhpExtensions(f.config.phpRoot), /inativa/);
  const first = f.context.preparePhpExtensions(f.target);
  await assert.rejects(f.context.preparePhpExtensions(f.target), /já está alterando/);
  const result = (await first).extensionPreparation;
  assert.match(readText(f.phpIni), /^extension=php_redis\.dll ; manter comentário$/m);
  assert.ok(!readText(f.phpIni).includes('php-antigo'));
  assert.deepEqual(Array.from(result.installed, item => item.dll), [redis.dll, legacy.dll]);
  assert.deepEqual(Array.from(result.pending, item => item.reason), ['Sem build compatível']);
  buildAvailable = true;
  assert.equal((await f.context.preparePhpExtensions(f.target)).extensionPreparation.pending.length, 0);
  assert.equal((await f.context.preparePhpExtensions(f.target)).extensionPreparation.installed.length, 0);
  assert.deepEqual(downloads, [redis.dll, legacy.dll, unsupported.dll, unsupported.dll]);
});
