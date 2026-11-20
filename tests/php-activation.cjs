'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { apachePrimaryPort } = require('../lib/apache-config.cjs');
const { extensionDllName, phpExtensionDirectives, rewriteXamppPhpConfig } = require('../lib/php-compat.cjs');
const { isInside, samePath, readText, writeAtomically } = require('../lib/runtime-state.cjs');

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

function fixture(t, mode, { state = 4, syntax = true, responsive = true } = {}) {
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
  const events = [];
  for (const name of ['php.exe', 'php8apache2_4.dll', 'php8ts.dll']) writeAtomically(path.join(target, name), '');
  writeAtomically(phpIni, 'memory_limit=256M');
  writeAtomically(apache.config, 'Listen 8088');
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
    phpExtensionDirectives, rewriteXamppPhpConfig, apachePrimaryPort,
    currentDllRegistry: () => ({ dlls: [] }), verifyRuntimeDlls: () => ({ compatible: true }),
    collectDllRegistry: () => ({}), persistDllRegistry: () => ({}),
    apacheConfigFiles: () => [], phpRuntimeApacheConflicts: () => [], apacheErrorLogSize: () => 0, apacheExtensionLoadFailures: () => [],
    makeStandaloneApacheConfig: () => ({ config: generatedFile, text: 'Listen 8088' }),
    probePhpRuntime: () => {
      assert.ok(readText(phpIni).includes(target.replace(/\\/g, '/') + '/ext'), 'a validação deve usar o ini final');
      return { version: '8.2.2', modules: [], threadSafety: 'TS' };
    },
    execFileAsync: file => ({ stdout: file === apache.executable && syntax ? 'Syntax OK' : '', stderr: '' }),
    inspectXamppService: service, waitForXamppService: (_, desired) => { assert.equal(state, desired); return service(); },
    runWindowsServiceAction: action => { events.push(action); state = action === 'start' ? 4 : 1; },
    readServiceCommand: () => 'original', quoteServiceCommand: command => command, apacheServiceCommand: () => 'new',
    serviceCommandMatches: (a, b) => a === b, changeApacheServiceCommand: command => events.push(command),
    checkPort: port => { events.push(`check ${port}`); return false; },
    waitForPort: port => { events.push(`wait ${port}`); return responsive; }
  });
  vm.runInContext(routines, context);
  return { run: () => context.switchEnvironment(target), context, events, target, config, phpIni, stateFile, generatedFile };
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
}

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
    fs, path, readText, phpExtensionDirectives,
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
