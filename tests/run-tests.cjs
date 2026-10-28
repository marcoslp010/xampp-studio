'use strict';

/**
 * Testes do XAMPP Studio.
 *
 * Executar com: node tests/run-tests.cjs
 *
 * A suíte cobre as regras que quebraram o ambiente local durante a troca de
 * versão: a colisão de DLLs por nome no Windows (OpenSSL do Apache contra o
 * OpenSSL exigido pelo PHP), a reescrita do httpd-xampp.conf, o comando do
 * serviço do Windows e a leitura das tabelas PE.
 *
 * Os testes usam os arquivos reais da instalação local quando existem e,
 * quando não, constroem fixtures temporárias — nenhum teste altera o ambiente.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const {
  apacheConfigFiles,
  apacheExtensionLoadFailures,
  apacheStartupLibraries,
  describeApacheConflicts,
  extensionDllName,
  phpExtensionDirectives,
  phpRuntimeApacheConflicts,
  phpRuntimeDependencyDlls,
  rewriteXamppPhpConfig
} = require('../lib/php-compat.cjs');
const {
  normalizeServiceCommand,
  quoteServiceCommand,
  serviceCommandMatches
} = require('../lib/service-command.cjs');
const { readPeExports, readPeImportSymbols, readPeImports } = require('../lib/pe-imports.cjs');
const {
  apacheDenyRules,
  apacheListenPorts,
  apachePrimaryPort,
  apacheServerName,
  rewriteApacheListenPort
} = require('../lib/apache-config.cjs');
const { isInside, readText, writeAtomically } = require('../lib/runtime-state.cjs');
const { renderDiagnosticsMarkdown, tailFile } = require('../lib/diagnostics.cjs');

const XAMPP_ROOT = process.env.XAMPP_ROOT || 'C:\\xampp';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIMES = path.join(PROJECT_ROOT, 'runtimes');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const temporaryPaths = [];

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function findRuntime(prefix) {
  if (!fs.existsSync(RUNTIMES)) return null;
  const entry = fs.readdirSync(RUNTIMES).find(name => name.startsWith(prefix));
  return entry ? path.join(RUNTIMES, entry) : null;
}

// ---------------------------------------------------------------------------
// php.ini
// ---------------------------------------------------------------------------

test('phpExtensionDirectives lê diretivas ativas e ignora comentadas', () => {
  const ini = [
    ';extension=curl',
    'extension=php_curl.dll',
    'extension = mysqli',
    'zend_extension=opcache',
    '[PHP]',
    'extension_dir="C:/xampp/php/ext"'
  ].join('\r\n');
  const directives = phpExtensionDirectives(ini);
  assert.deepEqual(directives.map(item => item.dll), ['php_curl.dll', 'php_mysqli.dll', 'php_opcache.dll']);
  assert.equal(directives[1].name, 'mysqli');
});

test('extensionDllName normaliza o nome da DLL', () => {
  assert.equal(extensionDllName('curl'), 'php_curl.dll');
  assert.equal(extensionDllName('php_curl'), 'php_curl.dll');
  assert.equal(extensionDllName('php_curl.dll'), 'php_curl.dll');
  assert.equal(extensionDllName('C:/xampp/php/ext/php_curl.dll'), 'php_curl.dll');
});

// ---------------------------------------------------------------------------
// Comando do serviço do Windows
// ---------------------------------------------------------------------------

test('quoteServiceCommand coloca o executável entre aspas', () => {
  assert.equal(
    quoteServiceCommand('C:\\Program Files\\xampp\\apache\\bin\\httpd.exe -k runservice'),
    '"C:\\Program Files\\xampp\\apache\\bin\\httpd.exe" -k runservice'
  );
  assert.equal(quoteServiceCommand('"C:\\xampp\\apache\\bin\\httpd.exe" -k runservice'), '"C:\\xampp\\apache\\bin\\httpd.exe" -k runservice');
});

test('serviceCommandMatches rejeita ImagePath com espaço inicial', () => {
  const expected = '"C:\\xampp\\apache\\bin\\httpd.exe" -k runservice';
  assert.equal(serviceCommandMatches(expected, expected), true);
  assert.equal(serviceCommandMatches(` ${expected}`, expected), false, 'espaço inicial é recusado pelo SCM');
  assert.equal(serviceCommandMatches('C:\\xampp\\apache\\bin\\httpd.exe -k runservice', expected), true, 'comparação ignora aspas');
  assert.equal(serviceCommandMatches('"C:\\outro\\httpd.exe" -k runservice', expected), false);
});

test('normalizeServiceCommand remove aspas e espaços extras', () => {
  assert.equal(normalizeServiceCommand('  "C:\\xampp\\httpd.exe"   -k   runservice '), 'c:\\xampp\\httpd.exe -k runservice');
});

// ---------------------------------------------------------------------------
// Configuração do Apache
// ---------------------------------------------------------------------------

test('apacheConfigFiles segue Include e IncludeOptional', () => {
  const root = temporaryDirectory('studio-apache-conf-');
  const conf = path.join(root, 'conf');
  writeFile(path.join(conf, 'httpd.conf'), [
    'ServerRoot "C:/apache"',
    'Include conf/extra/httpd-ssl.conf',
    'IncludeOptional conf/extra/nao-existe.conf',
    'Include conf/extra/*.conf'
  ].join('\r\n'));
  writeFile(path.join(conf, 'extra', 'httpd-ssl.conf'), 'LoadModule ssl_module modules/mod_ssl.so');
  writeFile(path.join(conf, 'extra', 'httpd-vhosts.conf'), 'Listen 8080');
  const files = apacheConfigFiles(root, path.join(conf, 'httpd.conf'));
  const names = files.map(file => path.basename(file));
  assert.ok(names.includes('httpd.conf'));
  assert.ok(names.includes('httpd-ssl.conf'));
  assert.ok(names.includes('httpd-vhosts.conf'));
  assert.ok(!names.includes('nao-existe.conf'), 'IncludeOptional de arquivo ausente não entra na lista');
});

test('rewriteXamppPhpConfig não corrompe o caminho do phpMyAdmin', () => {
  const original = [
    'LoadModule php_module "C:/xampp/php/php8apache2_4.dll"',
    'LoadFile "C:/xampp/php/php8ts.dll"',
    'Alias /phpmyadmin "C:/xampp/phpMyAdmin/"',
    'SetEnv PHPRC "C:/xampp/php"'
  ].join('\r\n');
  const result = rewriteXamppPhpConfig(original, 'C:/xampp/php', 'C:/xampp/htdocs/new-xampper/runtimes/php-8.5.12-ts-x64', 'php8apache2_4.dll', 'php8ts.dll', '', null, []);
  assert.ok(result.text.includes('Alias /phpmyadmin "C:/xampp/phpMyAdmin/"'), 'o alias do phpMyAdmin precisa ficar intacto');
  assert.ok(!result.text.includes('php-8.5.12-ts-x64MyAdmin'), 'a raiz antiga não pode ser trocada dentro de outro nome de pasta');
  assert.ok(result.text.includes('LoadModule php_module "C:/xampp/htdocs/new-xampper/runtimes/php-8.5.12-ts-x64/php8apache2_4.dll"'));
  assert.ok(result.text.includes('SetEnv PHPRC "C:/xampp/htdocs/new-xampper/runtimes/php-8.5.12-ts-x64"'));
});

test('rewriteXamppPhpConfig recusa configuração sem o módulo do PHP', () => {
  assert.throws(
    () => rewriteXamppPhpConfig('Alias /phpmyadmin "C:/xampp/phpMyAdmin/"', 'C:/xampp/php', 'C:/novo', 'php8apache2_4.dll', 'php8ts.dll', '', null, []),
    /LoadModule php_module/
  );
});

test('rewriteXamppPhpConfig remove DLLs do runtime antigo que não existem mais', () => {
  const original = [
    'LoadModule php_module "C:/xampp/php/php8apache2_4.dll"',
    'LoadFile "C:/xampp/php/php8ts.dll"',
    'LoadFile "C:/xampp/php/php_pgsql.dll"'
  ].join('\r\n');
  const result = rewriteXamppPhpConfig(original, 'C:/xampp/php', 'C:/novo/php', 'php8apache2_4.dll', 'php8ts.dll', '', null, []);
  assert.ok(result.removed.includes('php_pgsql.dll'));
  assert.ok(result.text.includes('# XAMPP Studio: php_pgsql.dll não é mais necessário neste runtime PHP.'));
});

// ---------------------------------------------------------------------------
// Tabelas PE e compatibilidade
// ---------------------------------------------------------------------------

test('readPeImports e readPeExports leem uma DLL real do Windows', () => {
  const candidates = [
    path.join(XAMPP_ROOT, 'apache', 'bin', 'libcrypto-3-x64.dll'),
    path.join(XAMPP_ROOT, 'apache', 'bin', 'libssl-3-x64.dll'),
    path.join(XAMPP_ROOT, 'php', 'php8ts.dll')
  ];
  const dll = candidates.find(file => fs.existsSync(file));
  if (!dll) {
    assert.ok(true, 'sem binários locais para ler');
    return;
  }
  const imports = readPeImports(dll);
  assert.ok(Array.isArray(imports));
  const exports = readPeExports(dll);
  assert.ok(exports.length > 0, 'a DLL deve exportar símbolos');
});

test('readPeImportSymbols devolve as funções importadas por extensão', () => {
  const runtime = findRuntime('php-8.5.12');
  const curl = runtime ? path.join(runtime, 'ext', 'php_curl.dll') : null;
  if (!curl || !fs.existsSync(curl)) {
    assert.ok(true, 'sem php_curl.dll local para inspecionar');
    return;
  }
  const entries = readPeImportSymbols(curl);
  const ssl = entries.filter(entry => /libcrypto|libssl/i.test(entry.dll));
  assert.ok(ssl.length > 0, 'php_curl.dll importa a biblioteca do OpenSSL');
  const required = ssl.flatMap(entry => entry.functions);
  assert.ok(required.includes('SSL_get0_group_name'), 'símbolo exigido pelo PHP 8.5 (OpenSSL 3.2+)');
});

test('phpRuntimeApacheConflicts acusa o PHP 8.5 no Apache com OpenSSL antigo', () => {
  const runtime = findRuntime('php-8.5.12');
  const oldApache = path.join(XAMPP_ROOT, 'apache');
  if (!runtime || !fs.existsSync(path.join(oldApache, 'bin', 'httpd.exe'))) {
    assert.ok(true, 'sem o par de runtimes local para comparar');
    return;
  }
  const ini = fs.readFileSync(path.join(runtime, 'php.ini'), 'utf8');
  const files = apacheConfigFiles(oldApache, path.join(oldApache, 'conf', 'httpd.conf'));
  const conflicts = phpRuntimeApacheConflicts(runtime, ini, oldApache, files);
  assert.ok(conflicts.length > 0, 'o Apache antigo usa um OpenSSL sem os símbolos exigidos');
  assert.ok(conflicts.some(item => item.extension === 'curl'));
  assert.ok(describeApacheConflicts(conflicts, '2.4.58').includes('curl'));
});

test('phpRuntimeApacheConflicts aprova o PHP 8.5 no Apache 2.4.69', () => {
  const runtime = findRuntime('php-8.5.12');
  const apache = findRuntime('apache-2.4.69');
  if (!runtime || !apache) {
    assert.ok(true, 'sem o runtime Apache novo local');
    return;
  }
  const ini = fs.readFileSync(path.join(runtime, 'php.ini'), 'utf8');
  const config = path.join(apache, 'conf', 'xampp-studio-httpd.conf');
  const files = apacheConfigFiles(apache, fs.existsSync(config) ? config : path.join(apache, 'conf', 'httpd.conf'));
  const conflicts = phpRuntimeApacheConflicts(runtime, ini, apache, files);
  assert.deepEqual(conflicts, [], 'com OpenSSL 3.5.9 não há conflito');
});

test('apacheStartupLibraries encontra o OpenSSL carregado pelo mod_ssl', () => {
  const apache = path.join(XAMPP_ROOT, 'apache');
  if (!fs.existsSync(path.join(apache, 'bin', 'httpd.exe'))) {
    assert.ok(true, 'sem Apache local');
    return;
  }
  const files = apacheConfigFiles(apache, path.join(apache, 'conf', 'httpd.conf'));
  const loaded = apacheStartupLibraries(apache, files);
  const names = [...loaded.keys()];
  assert.ok(names.includes('libssl-3-x64.dll'), 'o mod_ssl carrega o OpenSSL do Apache');
  assert.ok(names.includes('libcrypto-3-x64.dll'));
});

test('phpRuntimeDependencyDlls não repete DLL que o Apache já carrega', () => {
  const runtime = findRuntime('php-8.5.12');
  const apache = findRuntime('apache-2.4.69');
  if (!runtime || !apache) {
    assert.ok(true, 'sem runtimes locais');
    return;
  }
  const ini = fs.readFileSync(path.join(runtime, 'php.ini'), 'utf8');
  const config = path.join(apache, 'conf', 'xampp-studio-httpd.conf');
  const files = apacheConfigFiles(apache, fs.existsSync(config) ? config : path.join(apache, 'conf', 'httpd.conf'));
  const dependencies = phpRuntimeDependencyDlls(runtime, ini, apache, files).map(file => path.basename(file).toLowerCase());
  const loaded = [...apacheStartupLibraries(apache, files).keys()];
  for (const name of dependencies) {
    assert.ok(!loaded.includes(name), `${name} já é carregado pelo Apache e não pode ser carregado de novo`);
  }
});

test('apacheExtensionLoadFailures lê as falhas de carregamento do log', () => {
  const root = temporaryDirectory('studio-apache-log-');
  const log = path.join(root, 'logs', 'error.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'primeira linha\n', 'utf8');
  const offset = fs.statSync(log).size;
  fs.appendFileSync(log, "PHP Warning: Unable to load dynamic library 'brotlidec.dll'\n", 'utf8');
  const failures = apacheExtensionLoadFailures(root, offset);
  assert.deepEqual(failures, ['brotlidec.dll']);
  assert.deepEqual(apacheExtensionLoadFailures(root, fs.statSync(log).size), [], 'sem trecho novo não há falhas');
});

test('apacheListenPorts lê a porta real e ignora comentários', () => {
  const contents = [
    '# Listen 8080',
    'Listen 80',
    'Listen 444',
    '  Listen 0.0.0.0:8081'
  ].join('\r\n');
  assert.deepEqual(apacheListenPorts(contents), [80, 444, 8081]);
  assert.equal(apachePrimaryPort(contents), 80);
  assert.equal(apachePrimaryPort('sem Listen'), 80);
});

test('rewriteApacheListenPort troca a porta e ajusta o ServerName', () => {
  const contents = ['Listen 80', 'ServerName localhost:80', 'DocumentRoot "C:/xampp/htdocs"'].join('\r\n');
  const updated = rewriteApacheListenPort(contents, 8080);
  assert.deepEqual(apacheListenPorts(updated), [8080]);
  assert.match(updated, /ServerName localhost:8080/);
  assert.match(updated, /DocumentRoot "C:\/xampp\/htdocs"/);
  assert.equal(apacheServerName(updated), 'localhost:8080');
});

test('rewriteApacheListenPort preserva o endereço e recusa porta inválida', () => {
  const updated = rewriteApacheListenPort('Listen 0.0.0.0:80\n', 8081);
  assert.match(updated, /Listen 0\.0\.0\.0:8081/);
  assert.throws(() => rewriteApacheListenPort('Listen 80', 70000), /entre 1 e 65535/);
  assert.throws(() => rewriteApacheListenPort('Listen 80', 0), /entre 1 e 65535/);
});

test('apacheDenyRules nega workspace, logs, downloads e os estados da raiz', () => {
  const rules = apacheDenyRules('C:/xampp/htdocs/new-xampper');
  // workspace/ guarda credenciais do MySQL, data dir e despejos SQL.
  assert.match(rules, /<Directory "C:\/xampp\/htdocs\/new-xampper\/workspace">\s*Require all denied/s);
  assert.match(rules, /<Directory "C:\/xampp\/htdocs\/new-xampper\/logs">\s*Require all denied/s);
  assert.match(rules, /<Directory "C:\/xampp\/htdocs\/new-xampper\/downloads">\s*Require all denied/s);
  assert.match(rules, /<Directory "C:\/xampp\/htdocs\/new-xampper\/backups">\s*Require all denied/s);
  // Estados de runtime da raiz também ficam bloqueados.
  assert.match(rules, /dll-registry\\\.json/);
  assert.match(rules, /performance-state\\\.json/);
  assert.match(rules, /firewall-state\\\.json/);
  assert.match(rules, /request-body-log\\\.php/);
});

test('apacheDenyRules re-libera o documentRoot publicado dentro do workspace', () => {
  const root = 'C:/xampp/htdocs/new-xampper';
  const documentRoot = `${root}/workspace/htdocs`;
  const rules = apacheDenyRules(root, [documentRoot]);
  // A pasta workspace continua negada…
  assert.match(rules, /<Directory "C:\/xampp\/htdocs\/new-xampper\/workspace">\s*Require all denied/s);
  // …mas o documentRoot interno recebe seu próprio bloco de liberação,
  // porque no Apache o <Directory> mais específico vence o genérico.
  assert.match(rules, /<Directory "C:\/xampp\/htdocs\/new-xampper\/workspace\/htdocs">\s*Require all granted/s);
});

test('readPeImports não lança em DLL malformada e devolve vazio', () => {
  // Cabeçalhos MZ/PE válidos, corpo truncado: os RVAs de delay import caem
  // fora do buffer — antes da correção isso virava RangeError cru no meio
  // de uma troca de versão.
  const directory = temporaryDirectory('pe-malformada-');
  const file = path.join(directory, 'broken.dll');
  const buffer = Buffer.alloc(0x100, 0);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.write('PE\0\0', 0x40, 'ascii');
  fs.writeFileSync(file, buffer);
  assert.deepEqual(readPeImports(file), []);
  assert.deepEqual(readPeExports(file), []);
  assert.deepEqual(readPeImportSymbols(file), []);
});

test('isInside rejeita travessia e aceita apenas caminhos internos', () => {
  const parent = PROJECT_ROOT;
  assert.equal(isInside(parent, path.join(parent, 'lib', 'services.cjs')), true);
  assert.equal(isInside(parent, parent), true);
  assert.equal(isInside(parent, path.resolve(parent, '..', 'arquivo-externo.js')), false);
  assert.equal(isInside(parent, `${parent}-vizinho`), false);
  assert.equal(isInside(parent, path.parse(parent).root), false);
});

// ---------------------------------------------------------------------------
// Estado, logs e diagnóstico
// ---------------------------------------------------------------------------

test('readText ignora BOM e writeAtomically cria a pasta de destino', () => {
  const root = temporaryDirectory('studio-state-');
  const file = path.join(root, 'nested', 'state.json');
  writeAtomically(file, JSON.stringify({ a: 1 }));
  writeAtomically(file, JSON.stringify({ a: 2 }));
  assert.deepEqual(JSON.parse(readText(file)), { a: 2 });
  const bom = path.join(root, 'bom.json');
  fs.writeFileSync(bom, '\uFEFF{"ok":true}', 'utf8');
  assert.deepEqual(JSON.parse(readText(bom)), { ok: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), []);
});

test('tailFile lê apenas o fim do arquivo e descarta a linha truncada', () => {
  const root = temporaryDirectory('studio-tail-');
  const file = path.join(root, 'error.log');
  const lines = Array.from({ length: 200 }, (_, index) => `linha ${String(index).padStart(3, '0')} ${'x'.repeat(80)}`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  assert.deepEqual(tailFile(file, 3, 400), lines.slice(-3));
  assert.deepEqual(tailFile(path.join(root, 'missing.log')), []);
});

test('renderDiagnosticsMarkdown neutraliza pipes e cercas vindas do ambiente', () => {
  const report = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    studio: { node: 'v20', platform: 'win32', port: 43197, windowsAdmin: false },
    environment: { mode: 'standalone', xamppRoot: 'C:/xampp' },
    components: { PHP: { version: '8.5|12', executable: 'C:/xampp/php/php.exe', sha256: 'a'.repeat(64), running: true } },
    services: [{ serviceName: 'Apache|Teste', state: 'running', stateLabel: 'em execução', imagePath: 'C:/x|y/httpd.exe' }],
    ports: { 80: { active: true, summary: 'httpd|8080', managed: true } },
    compatibility: [],
    certificate: null,
    phpIniHighlights: { memory_limit: '512M|1G' },
    jobs: [{ type: 'x|y', status: 'succeeded', createdAt: '2026-01-01', error: 'linha1\nlinha2' }],
    logs: { apacheError: ['antes', '```', 'depois'], mysqlError: [] }
  };
  const markdown = renderDiagnosticsMarkdown(report);
  assert.match(markdown, /8\.5\\\|12/);
  assert.match(markdown, /Apache\\\|Teste/);
  assert.ok(markdown.includes('linha1 linha2'));
  assert.ok(markdown.includes('``\u200B`'));
  assert.equal(markdown.split(/\r?\n/).filter(line => line === '```').length, 5);
});

// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log(`✓ ${item.name}`);
    } catch (error) {
      failed++;
      console.error(`✗ ${item.name}`);
      console.error(`  ${error.message.split('\n').slice(0, 6).join('\n  ')}`);
    }
  }
  for (const directory of temporaryPaths) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${tests.length - failed}/${tests.length} testes passaram.`);
  process.exit(failed ? 1 : 0);
})();
