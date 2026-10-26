'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extensionName, parsePeclBuilds, searchExtensionCatalog } = require('../lib/extension-catalog.cjs');

test('normaliza requisitos Composer e nomes DLL; rejeita caminhos e URLs', () => {
  for (const name of ['ext-opentelemetry', 'opentelemetry', 'php_opentelemetry.dll', ' EXT-OpenTelemetry ']) assert.equal(extensionName(name), 'opentelemetry');
  for (const name of ['../curl', 'https://evil.test/a', 'C:\\php\\ext\\curl.dll', '..', 'ext-', 'a/b']) assert.throws(() => extensionName(name));
});

const directory = 'https://downloads.php.net/~windows/pecl/releases/opentelemetry/1.4.2/';
const target = { phpMinor: '8.2', threadSafety: 'ts', architecture: 'x64', compiler: 'VS16' };
const file = 'php_opentelemetry-1.4.2-8.2-ts-vs16-x64.zip';
test('exige PHP, TS/NTS, compilador e arquitetura correspondentes', () => {
  const files = [file, file.replace('-ts-', '-nts-'), file.replace('vs16', 'vs17'), file.replace('x64', 'x86'), file.replace('8.2', '8.3')];
  const result = parsePeclBuilds(files.map(f => `<a href="${f}">DLL</a>`).join(''), directory, target);
  assert.equal(result.length, 4);
  assert.deepEqual(result.filter(b => b.compatible).map(b => b.file), [file]);
  assert.equal(parsePeclBuilds(`<a href="${file}">`, directory, { ...target, architecture: null })[0].compatible, false);
});

test('recusa origem externa, HTTP, outro pacote ou release; elimina duplicatas', () => {
  const urls = [file, file, `http://downloads.php.net/~windows/pecl/releases/opentelemetry/1.4.2/${file}`, `https://evil.test/${file}`, `${directory.replace('/1.4.2/', '/1.4.1/')}${file}`, `${directory}${file.replace('opentelemetry', 'curl')}`, `https://user@downloads.php.net/~windows/pecl/releases/opentelemetry/1.4.2/${file}`];
  const result = parsePeclBuilds(urls.map(url => `<a href='${url}'>`).join(''), directory, target);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, directory + file);
});

test('ext-opentelemetry pesquisa opentelemetry e combina PECL com PIE', async () => {
  const urls = [];
  const result = await searchExtensionCatalog('ext-opentelemetry', async url => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ results: [{ name: 'open-telemetry/ext-opentelemetry' }] }), text: async () => '<a><r><v>1.4.2</v></r></a>' };
  });
  assert.equal(new URL(urls[0]).searchParams.get('q'), 'opentelemetry');
  assert.equal(result.packages.length, 2);
  assert.ok(result.packages.every(p => p.extension === 'opentelemetry'));
});

test('consulta direta PECL continua quando Packagist falha', async () => {
  const result = await searchExtensionCatalog('php_opentelemetry.dll', async url => {
    if (String(url).includes('packagist')) throw new Error('offline');
    return { ok: true, text: async () => '<v>1.4.2</v>' };
  });
  assert.equal(result.packages[0].extension, 'opentelemetry');
  assert.equal(result.warnings.length, 1);
});

test('pacote PECL inexistente não vira resultado inventado', async () => {
  const result = await searchExtensionCatalog('unknown-extension', async url => String(url).includes('packagist')
    ? { ok: true, json: async () => ({ results: [] }) }
    : { ok: false, status: 404 });
  assert.deepEqual(result.packages, []);
});

test('falha das fontes é erro, não catálogo vazio', async () => {
  await assert.rejects(searchExtensionCatalog('redis', async () => { throw new Error('offline'); }), /indisponível/);
});

test('downloads pertencem ao caminho exato do PHP, mesmo com versões iguais', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { listExtensionDownloads } = require('../lib/extension-downloads.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-extension-downloads-'));
  const firstRoot = path.join(directory, 'php-a');
  const secondRoot = path.join(directory, 'php-b');
  const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333'];
  try {
    ids.forEach((id, index) => {
      const folder = path.join(directory, id);
      fs.mkdirSync(folder);
      const manifest = { dll: 'php_opentelemetry.dll', build: file, phpVersion: '8.2.12', ...(index < 2 ? { phpRoot: index ? secondRoot : firstRoot } : {}) };
      fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(folder, manifest.dll), 'fixture');
      fs.writeFileSync(path.join(folder, manifest.build), 'fixture');
    });
    assert.equal(listExtensionDownloads(directory, firstRoot).length, 1);
    assert.equal(listExtensionDownloads(directory, secondRoot).length, 1);
    assert.equal(listExtensionDownloads(directory, path.join(directory, 'php-c')).length, 0);
    assert.equal(listExtensionDownloads(directory, firstRoot, id => id === ids[2] ? { payload: { phpRoot: firstRoot } } : null).length, 2);
    fs.unlinkSync(path.join(directory, ids[0], 'php_opentelemetry.dll'));
    assert.equal(listExtensionDownloads(directory, firstRoot).length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
