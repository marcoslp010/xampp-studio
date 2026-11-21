'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isIP, SocketAddress } = require('node:net');
const { apacheConfigFiles } = require('./php-compat.cjs');
const { readText } = require('./runtime-state.cjs');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 2000;
const PAGE_SIZE = 100;
const PERIOD_MS = new Map([['15m', 900000], ['1h', 3600000], ['24h', 86400000], ['7d', 604800000]]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function apacheAccessLogPaths({ root, config }) {
  const files = apacheConfigFiles(root, config);
  const defines = new Map([['SRVROOT', root]]);
  const directives = [];
  for (const file of files) {
    for (const line of readText(file).split(/\r?\n/)) {
      const match = line.match(/^\s*(Define|ServerRoot|CustomLog|TransferLog|GlobalLog)\s+(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+(?:"([^"]*)"|'([^']*)'|(\S+)))?/i);
      if (!match) continue;
      const name = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4];
      if (name === 'define') defines.set(value, match[5] ?? match[6] ?? match[7] ?? '');
      else directives.push({ name, value });
    }
  }
  const expand = value => value.replace(/\$\{([^}]+)\}/g, (token, name) =>
    defines.get(name) ?? process.env[name] ?? token);
  const serverRoot = path.resolve(root, expand(directives.findLast(item => item.name === 'serverroot')?.value || root));
  const logs = directives.filter(item => item.name !== 'serverroot');
  if (!logs.length) return { paths: [path.join(serverRoot, 'logs', 'access.log')], piped: false };
  const paths = logs.map(item => expand(item.value))
    .filter(value => value && !/^\||^\$\{|^[/\\]{2}|^nul$|^\/dev\/null$/i.test(value) && !value.includes('${'))
    .map(value => path.resolve(serverRoot, value));
  return { paths, piped: logs.some(item => item.value.startsWith('|')) };
}

function readLogFile(file, includeHeader) {
  try {
    if (!fs.statSync(file).isFile()) return { status: 'unavailable', lines: [] };
    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const offset = Math.max(0, stat.size - MAX_BYTES);
      const buffer = Buffer.alloc(stat.size - offset);
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      let text = buffer.toString('utf8', 0, read).replace(/^\uFEFF/, '');
      if (offset) {
        const byte = Buffer.alloc(1);
        fs.readSync(fd, byte, 0, 1, offset - 1);
        if (byte[0] !== 10) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
      }
      // Uma gravação em andamento pode terminar depois da próxima leitura.
      const complete = text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/)
        .filter(line => line && (!includeHeader || !line.startsWith('#')));
      let header = includeHeader ? text.slice(0, 8192) : '';
      if (includeHeader && offset) {
        const prefix = Buffer.alloc(8192);
        const length = fs.readSync(fd, prefix, 0, prefix.length, 0);
        header = prefix.toString('utf8', 0, length);
      }
      return {
        status: 'readable',
        modifiedAt: stat.mtime.toISOString(),
        limited: offset > 0 || complete.length > MAX_LINES,
        header,
        lines: complete.slice(-MAX_LINES).reverse()
      };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    const status = error.code === 'ENOENT' ? 'missing' : ['EACCES', 'EPERM'].includes(error.code) ? 'denied' : 'unavailable';
    return { status, lines: [] };
  }
}

function apacheTimestamp(value) {
  const stamp = value.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  if (!stamp) return '';
  const month = MONTHS.indexOf(stamp[2]) + 1;
  if (!month) return '';
  return toIso(stamp[3] + '-' + String(month).padStart(2, '0') + '-' + stamp[1] + 'T' + stamp[4] + stamp[5] + ':' + stamp[6]);
}

function toIso(value) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? '' : timestamp.toISOString();
}

function parseApacheLine(raw) {
  const standard = raw.match(/^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"((?:\\.|[^"\\])*)"\s+(\d{3}|-)\s+\S+/);
  const ssl = standard ? null : raw.match(/^\[([^\]]+)\]\s+(\S+)\s+\S+\s+\S+\s+"((?:\\.|[^"\\])*)"\s+\S+/);
  if (!standard && !ssl) return null;
  const [method, target] = (standard?.[3] ?? ssl[3]).split(/\s+/);
  return {
    ip: standard?.[1] ?? ssl[2],
    method: target ? method : '—',
    path: target || method || '—',
    status: standard?.[4] || '—',
    timestamp: apacheTimestamp(standard?.[2] ?? ssl[1]),
    body: ''
  };
}

function windowsLogParser(header = '') {
  const fields = [...header.matchAll(/^#Fields:\s*([^\r\n]+)/gim)].at(-1)?.[1].trim().split(/\s+/)
    || ['date', 'time', 'action', 'protocol', 'src-ip', 'dst-ip', 'src-port', 'dst-port'];
  const utc = /^#Time Format:\s*(?:UTC|GMT)\s*$/im.test(header);
  return raw => {
    const values = raw.trim().split(/\s+/);
    const row = Object.fromEntries(fields.map((field, index) => [field, values[index]]));
    if (!row['src-ip'] || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) return null;
    return {
      ip: row['src-ip'], method: row.protocol || '—', path: [row['dst-ip'], row['dst-port'] && row['dst-port'] !== '-' ? 'porta ' + row['dst-port'] : ''].filter(Boolean).join(' · '),
      status: row.action || '—', timestamp: toIso(row.date + 'T' + row.time + (utc ? 'Z' : '')), body: ''
    };
  };
}

function parseBodyLine(raw) {
  try {
    const record = JSON.parse(raw);
    if (!record.ip || !record.method || typeof record.timestamp !== 'string') return null;
    return {
      ip: String(record.ip), method: String(record.method), path: String(record.path || '/'),
      status: String(record.status || '—'), timestamp: toIso(record.timestamp),
      body: typeof record.body === 'string' ? record.body : JSON.stringify(record.body ?? ''),
      raw: typeof record.raw === 'string' ? record.raw : raw
    };
  } catch { return null; }
}

function logSources(apache, windowsFiles, bodyFile) {
  const { paths, piped } = apacheAccessLogPaths(apache);
  const seen = new Set();
  const files = [];
  for (const [type, source, members] of [
    ['apache', 'Apache', paths],
    ['windows', 'Firewall do Windows', windowsFiles],
    ['php', 'PHP · corpo filtrado', [bodyFile, bodyFile + '.1']]
  ]) {
    for (const file of members) {
      if (!path.isAbsolute(file) || /^[/\\]{2}/.test(file)) continue;
      const key = path.resolve(file).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ id: createHash('sha256').update(key).digest('hex').slice(0, 32), type, source, path: file });
    }
  }
  return { files, piped };
}

function normalizedIp(value) {
  if (isIP(value) !== 6) return value.toLowerCase();
  const [address, scope] = value.toLowerCase().split('%');
  return new SocketAddress({ family: 'ipv6', address }).address + (scope ? '%' + scope : '');
}

function readFirewallFilters(params, now = Date.now()) {
  const page = Number(params.get('page') || 1);
  const query = (params.get('q') || '').trim().toLowerCase();
  const type = params.get('source') || '';
  const ip = (params.get('ip') || '').trim();
  const method = (params.get('method') || '').toUpperCase();
  const status = (params.get('status') || '').toUpperCase();
  const period = params.get('period') || '';
  const start = params.get('from') || '';
  const end = params.get('to') || '';
  const blockedOnly = params.get('blocked') === '1';
  const isTimestamp = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

  if (!Number.isSafeInteger(page) || page < 1 || query.length > 200 || !['', 'apache', 'windows', 'php'].includes(type)) {
    throw new Error('Confira a página, a fonte e o texto buscado.');
  }
  if (ip && (ip.length > 64 || !isIP(ip))) throw new Error('Informe um endereço IPv4 ou IPv6 completo.');
  if (method && !/^[A-Z][A-Z0-9-]{0,23}$/.test(method)) throw new Error('Selecione um método ou protocolo válido.');
  if (status && !/^(?:[1-5](?:\d{2}|XX)|ALLOW|DROP|MISSING)$/.test(status)) throw new Error('Selecione um resultado válido.');
  if ((period && (!PERIOD_MS.has(period) || start || end)) || (start && !isTimestamp(start)) ||
      (end && !isTimestamp(end)) || (start && end && start > end)) {
    throw new Error('Confira as datas. O início precisa ser anterior ou igual ao fim.');
  }
  return {
    page, query, type, ip: normalizedIp(ip), method, status, blockedOnly,
    from: period ? new Date(now - PERIOD_MS.get(period)).toISOString() : start,
    to: period ? new Date(now).toISOString() : end
  };
}

function matchesResult(value, filter) {
  const status = value.toUpperCase();
  if (filter === 'MISSING') return status === '—' || status === '-';
  if (filter === 'DROP') return status === 'DROP' || status === 'BLOCK';
  if (filter.endsWith('XX')) return /^[1-5]\d{2}$/.test(status) && status[0] === filter[0];
  return status === filter;
}

function readFirewallPage(files, { page, query, type, blocked, ip, method, status, blockedOnly, from, to }) {
  const blockedAddresses = new Set([...blocked].map(normalizedIp));
  const entries = [];
  const sources = files.map(file => {
    const log = readLogFile(file.path, file.type === 'windows');
    const parse = file.type === 'windows' ? windowsLogParser(log.header) : file.type === 'php' ? parseBodyLine : parseApacheLine;
    let count = 0;
    for (const raw of log.lines) {
      const entry = parse(raw);
      if (!entry) continue;
      count++;
      if (type && file.type !== type) continue;
      if (method && entry.method.toUpperCase() !== method) continue;
      if (status && !matchesResult(entry.status, status)) continue;
      if ((from || to) && (!entry.timestamp || (from && entry.timestamp < from) || (to && entry.timestamp > to))) continue;
      const address = ip || blockedAddresses.size ? normalizedIp(entry.ip) : '';
      const isBlocked = blockedAddresses.has(address);
      if ((ip && address !== ip) || (blockedOnly && !isBlocked)) continue;
      const item = { raw, ...entry, source: file.source, logId: file.id, blocked: isBlocked };
      if (!query || [item.ip, item.method, item.path, item.status, item.source, item.body, item.raw]
        .some(value => String(value).toLowerCase().includes(query))) entries.push(item);
    }
    return { ...file, status: log.status, modifiedAt: log.modifiedAt, limited: Boolean(log.limited), count, unrecognized: log.lines.length > 0 && count === 0 };
  });
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const start = (current - 1) * PAGE_SIZE;
  return { entries: entries.slice(start, start + PAGE_SIZE), sources, pagination: { page: current, pages, pageSize: PAGE_SIZE, total: entries.length } };
}

function editorLogPath(files, id) {
  const file = files.find(item => item.id === id);
  if (!file) return null;
  const resolved = fs.realpathSync(file.path);
  if (/^[/\\]{2}/.test(resolved) || !fs.statSync(resolved).isFile()) return null;
  fs.accessSync(resolved, fs.constants.R_OK);
  return resolved;
}

module.exports = { logSources, readFirewallFilters, readFirewallPage, editorLogPath };
