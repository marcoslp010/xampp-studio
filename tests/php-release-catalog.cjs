'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const runtimeState = require('../lib/runtime-state.cjs');

const source = fs.readFileSync(path.join(__dirname, '../server.cjs'), 'utf8');
const start = source.indexOf('function compareVersions(');
const end = source.indexOf('async function listWindowsApacheReleases(', start);
assert.ok(start >= 0 && end > start);

function catalogFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-php-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const xampp = path.join(root, 'xampp');
  const app = path.join(root, 'studio');
  const bundled = path.join(xampp, 'php');
  fs.mkdirSync(bundled, { recursive: true });
  const state = {};
  const probes = [];
  const engines = new Map();
  const feeds = {};
  const packageBase = 'https://downloads.php.net/~windows/releases/';
  const context = vm.createContext({
    fs, path, Buffer, AbortSignal, XAMPP_ROOT: xampp, APP_ROOT: app,
    readText: runtimeState.readText, isInside: runtimeState.isInside,
    require(name) { assert.equal(name, './lib/runtime-state.cjs'); return runtimeState; },
    readEnvironmentState: () => state,
    async execFileAsync(file, args) {
      assert.equal(args[0], '-n');
      probes.push(file);
      return { stdout: engines.get(file) };
    },
    async fetch(url) {
      assert.equal(url, packageBase + 'releases.json');
      return { ok: true, json: async () => feeds };
    }
  });
  vm.runInContext(source.slice(start, end), context);
  function php(directory, identity, machine) {
    fs.mkdirSync(directory, { recursive: true });
    const pe = Buffer.alloc(512);
    pe.write('MZ');
    pe.writeUInt32LE(128, 0x3c);
    pe.write('PE\0\0', 128);
    pe.writeUInt16LE(machine, 132);
    const executable = path.join(directory, 'php.exe');
    fs.writeFileSync(executable, pe);
    engines.set(fs.realpathSync(executable), identity);
    return executable;
  }
  function zip(name) { return { zip: { path: name, sha256: 'a'.repeat(64), size: '32MB' } }; }
  return { root, xampp, bundled, app, feeds, state, probes, php, zip, packageBase, list: context.listWindowsPhpReleases };
}

test('o patch da série ativa usa o build oficial TS x64 e preserva a revisão do pacote', async t => {
  const f = catalogFixture(t);
  const active = path.join(f.app, 'runtimes', 'php-test');
  f.state.phpRoot = active;
  f.php(active, '8.2.35|TS', 0x8664);
  const metadata = path.join(active, 'studio-runtime.json');
  f.feeds['8.2'] = { version: '8.2.35-1', 'nts-vs16-x64': f.zip('nts.zip'), 'ts-vs16-x86': f.zip('x86.zip'), 'ts-vs16-x64': f.zip('patch.zip') };
  f.feeds['8.3'] = { version: '8.3.1', 'ts-vs16-x64': f.zip('next.zip') };
  let result = await f.list();
  assert.equal(result.warning, null);
  assert.equal(result.versions.length, 2);
  assert.equal(result.versions[1].url, f.packageBase + 'patch.zip');
  assert.equal(result.versions[1].compiler, 'VS16');
  fs.writeFileSync(metadata, JSON.stringify({ version: '8.2.35-1' }));
  result = await f.list();
  assert.equal(result.currentVersion, '8.2.35-1');
  assert.equal(result.versions.length, 1);
  assert.equal(result.versions[0].version, '8.3.1');
});

test('PHP removido usa o executável incluído e retorna a pasta correta para migrar o ini', async t => {
  const f = catalogFixture(t);
  f.state.phpRoot = path.join(f.app, 'runtimes', 'removido');
  f.php(f.bundled, '8.2.12|NTS', 0x014c);
  f.feeds['8.2'] = { version: '8.2.36', 'ts-vs16-x64': f.zip('wrong.zip'), 'nts-vs16-x86': f.zip('nts-x86.zip') };
  const result = await f.list();
  assert.equal(result.baseline.root, f.bundled);
  assert.ok(result.warning.includes('PHP incluído no XAMPP'));
  assert.equal(result.threadSafety, 'NTS');
  assert.equal(result.architecture, 'x86');
  assert.equal(result.versions[0].url, f.packageBase + 'nts-x86.zip');
});

test('a propriedade do XAMPP não autoriza executar um PHP externo e ARM64 não é tratado como x64', async t => {
  const f = catalogFixture(t);
  const external = path.join(f.root, 'fora-do-xampp');
  f.php(external, '8.3.0|TS', 0x8664);
  fs.writeFileSync(path.join(f.xampp, 'properties.ini'), 'php_binary_directory=' + external);
  f.php(f.bundled, '8.2.12|TS', 0xaa64);
  await assert.rejects(f.list(), /x86 ou x64/);
  assert.equal(f.probes.length, 0);
});
