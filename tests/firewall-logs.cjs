'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { logSources, readFirewallFilters, readFirewallPage, editorLogPath } = require('../lib/firewall-logs.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio firewall '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'httpd.conf');
  const apache = path.join(root, 'logs', 'site access.log');
  const windows = path.join(root, 'pfirewall_Private.log');
  const php = path.join(root, 'body.jsonl');
  fs.mkdirSync(path.dirname(apache));
  fs.writeFileSync(config, 'Define SRVROOT "' + root + '"\nServerRoot "${SRVROOT}"\nInclude "vhosts.conf"');
  fs.writeFileSync(path.join(root, 'vhosts.conf'), 'CustomLog "logs/site access.log" combined\nTransferLog "logs/site access.log"\nGlobalLog "|rotatelogs access.log" common');
  const logs = logSources({ root, config }, [windows], php);
  const read = (options = {}) => readFirewallPage(logs.files, { page: 1, query: '', type: '', blocked: new Set(), ...options });
  return { ...logs, apache, windows, php, read };
}

test('lê o log do virtual host, ordena linhas novas e filtra antes de paginar', t => {
  const f = fixture(t);
  const request = i => '192.0.2.1 - - [21/Nov/2026:09:00:00 -0300] "GET /item/' + i + ' HTTP/1.1" 200 12\n';
  fs.writeFileSync(f.apache, Array.from({ length: 205 }, (_, i) => request(i)).join(''));
  assert.equal(f.piped, true);
  assert.equal(f.files.filter(file => file.type === 'apache').length, 1);
  const first = f.read({ blocked: new Set(['192.0.2.1']) });
  assert.deepEqual(first.pagination, { page: 1, pages: 3, pageSize: 100, total: 205 });
  assert.equal(first.entries.length, 100);
  assert.equal(first.entries[0].path, '/item/204');
  assert.equal(first.entries[0].blocked, true);
  assert.equal(first.entries[0].timestamp, '2026-11-21T12:00:00.000Z');
  assert.equal(f.read({ page: 2 }).entries[0].path, '/item/104');
  assert.equal(f.read({ page: 999 }).entries.length, 5);
  assert.deepEqual(f.read({ query: '/item/104' }).entries.map(entry => entry.path), ['/item/104']);
  fs.appendFileSync(f.apache, request(205));
  assert.equal(f.read().entries[0].path, '/item/205');
  assert.equal(editorLogPath(f.files, first.entries[0].logId), fs.realpathSync(f.apache));
  assert.equal(editorLogPath(f.files, '../httpd.conf'), null);
});

test('preserva o cabeçalho W3C fora do trecho final e espera por linhas completas', t => {
  const f = fixture(t);
  const row = '2026-11-21 12:01:00 198.51.100.7 DROP 203.0.113.1 443 TCP';
  fs.writeFileSync(f.windows, '#Time Format: UTC\r\n#Fields: date time src-ip action dst-ip dst-port protocol\r\n'
    + (row + ' ' + 'x'.repeat(1100) + '\r\n').repeat(2100) + row);
  fs.writeFileSync(f.php + '.1', JSON.stringify({
    ip: '192.0.2.4', method: 'POST', timestamp: '2026-11-21T12:03:00Z', body: { token: '[oculto]' }
  }) + '\n');
  const first = f.read();
  assert.equal(first.entries[0].source, 'PHP · corpo filtrado');
  const filtered = f.read({ type: 'windows', query: 'drop' });
  assert.equal(filtered.entries[0].ip, '198.51.100.7');
  assert.equal(filtered.entries[0].path, '203.0.113.1 · porta 443');
  assert.equal(filtered.entries[0].timestamp, '2026-11-21T12:01:00.000Z');
  assert.equal(filtered.sources.find(file => file.type === 'windows').limited, true);
  assert.equal(filtered.sources.find(file => file.type === 'apache').status, 'missing');
  assert.ok(filtered.pagination.total > 100 && filtered.pagination.total < 2000);
  fs.appendFileSync(f.windows, '\r\n');
  assert.equal(f.read({ type: 'windows' }).entries[0].raw, row);
});

test('combina IP exato, método, resultado, texto, período e bloqueio antes de paginar', t => {
  const f = fixture(t);
  const request = (ip, method, date, target, status) =>
    ip + ' - - [' + date + ' +0000] "' + method + ' /' + target + ' HTTP/1.1" ' + status + ' 12\n';
  fs.writeFileSync(f.apache, [
    request('2001:db8::1', 'POST', '21/Nov/2026:12:00:00', 'login', 403),
    request('2001:db8::10', 'POST', '21/Nov/2026:12:00:00', 'login', 403),
    request('2001:db8::1', 'GET', '21/Nov/2026:12:00:00', 'login', 403),
    request('2001:db8::1', 'POST', '21/Nov/2026:12:00:00', 'login', 201),
    request('2001:db8::1', 'POST', '21/Nov/2026:12:00:00', 'checkout', 403),
    request('2001:db8::1', 'POST', '21/Nov/2026:11:59:59', 'login', 403)
  ].join(''));
  const now = Date.parse('2026-11-21T12:15:00.000Z');
  const filters = readFirewallFilters(new URLSearchParams({
    page: 2, ip: '2001:0db8:0:0:0:0:0:1', method: 'post', status: '4xx', source: 'apache', q: 'LOGIN', period: '15m', blocked: '1'
  }), now);
  const page = f.read({ ...filters, blocked: new Set(['2001:db8:0:0::1']) });
  assert.equal(page.pagination.page, 1);
  assert.deepEqual(page.entries.map(item => [item.ip, item.method, item.status, item.timestamp, item.path, item.blocked]), [
    ['2001:db8::1', 'POST', '403', '2026-11-21T12:00:00.000Z', '/login', true]
  ]);
  assert.equal(f.read(filters).pagination.total, 0);
  const custom = readFirewallFilters(new URLSearchParams({ from: '2026-11-21T12:00:00.000Z', to: '2026-11-21T12:00:00.000Z', status: '403' }));
  assert.equal(f.read(custom).pagination.total, 4);
  for (const [params, expected] of [
    [{ ip: '192.0.2' }, /IPv4 ou IPv6/],
    [{ status: 'other' }, /resultado válido/],
    [{ from: '2026-11-30T00:00:00.000Z', to: '2026-11-21T23:59:59.999Z' }, /Confira as datas/],
    [{ from: '2026-02-30T00:00:00.000Z' }, /Confira as datas/]
  ]) {
    assert.throws(() => readFirewallFilters(new URLSearchParams(params)), expected);
  }
});
