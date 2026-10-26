'use strict';

const path = require('node:path');

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

function compareVersions(left, right) {
  const a = String(left).split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
  const b = String(right).split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

async function fetchText(url, timeoutMs = 9000) {
  const response = await fetch(url, {
    headers: { accept: 'text/html', 'user-agent': 'XAMPP-Studio/0.2' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`A fonte respondeu HTTP ${response.status}.`);
  return response.text();
}

function uniqueVersions(values) {
  return [...new Set(values)].filter(version => /^\d+\.\d+\.\d+$/.test(version));
}

async function listMysqlReleases(limit = 8) {
  const indexUrl = 'https://downloads.mysql.com/archives/community/';
  const indexHtml = await fetchText(indexUrl, 12000);
  const versions = uniqueVersions([...indexHtml.matchAll(/<option\s+value="(\d+\.\d+\.\d+)"/gi)].map(match => match[1]))
    .sort((left, right) => compareVersions(right, left));
  if (!versions.length) throw new Error('O MySQL não publicou versões arquivadas compatíveis com Windows.');
  const selected = [...versions.slice(0, limit)];
  for (const line of ['8.4', '8.0']) {
    const candidate = versions.find(version => version.startsWith(`${line}.`));
    if (candidate && !selected.includes(candidate)) selected.push(candidate);
  }
  const releases = await Promise.all(selected.map(async version => {
    const filesUrl = `https://downloads.mysql.com/archives/community/?tpl=files&version=${version}&os=3`;
    try {
      const html = await fetchText(filesUrl, 10000);
      const href = html.match(/href="([^"]*mysql-[^"]*-winx64\.zip)"/i)?.[1];
      const md5 = html.match(/MD5:\s*<code[^>]*>([a-f0-9]{32})<\/code>/i)?.[1];
      if (!href) return null;
      const url = new URL(href, 'https://downloads.mysql.com').href;
      return {
        id: `mysql-${version}-winx64`,
        product: 'mysql',
        label: `MySQL Community Server ${version}`,
        version,
        architecture: 'Win64',
        channel: version.startsWith('8.4.') ? 'LTS' : version.startsWith('8.0.') ? 'LTS anterior' : 'Innovation',
        url,
        checksum: md5 ? { algorithm: 'md5', value: md5 } : null,
        signatureUrl: new URL(`/archives/gpg/?file=mysql-${version}-winx64.zip&p=23`, 'https://downloads.mysql.com').href,
        source: 'MySQL Community Archives · official',
        sourceUrl: filesUrl
      };
    } catch {
      return null;
    }
  }));
  return releases.filter(Boolean);
}

async function listMariadbReleases(limit = 8) {
  const indexUrl = 'https://archive.mariadb.org/';
  const indexHtml = await fetchText(indexUrl, 12000);
  const versions = uniqueVersions([...indexHtml.matchAll(/href="mariadb-(\d+\.\d+\.\d+)\/"/gi)].map(match => match[1]))
    .sort((left, right) => compareVersions(right, left));
  if (!versions.length) throw new Error('O MariaDB não publicou versões arquivadas.');
  const selected = [...versions.slice(0, limit)];
  for (const line of ['11.4', '10.11']) {
    const candidate = versions.find(version => version.startsWith(`${line}.`));
    if (candidate && !selected.includes(candidate)) selected.push(candidate);
  }
  const releases = await Promise.all(selected.map(async version => {
    const versionUrl = `${indexUrl}mariadb-${version}/`;
    try {
      const versionHtml = await fetchText(versionUrl, 10000);
      if (!/href="winx64-packages\/"/i.test(versionHtml)) return null;
      const directoryUrl = `${versionUrl}winx64-packages/`;
      const html = await fetchText(directoryUrl, 10000);
      const href = html.match(/href="(mariadb-[^"]+-winx64\.zip)"/i)?.[1];
      if (!href) return null;
      const url = new URL(href, directoryUrl).href;
      const checksumUrl = new URL('sha256sums.txt', directoryUrl).href;
      const checksumText = await fetchText(checksumUrl, 10000);
      const filename = path.posix.basename(new URL(url).pathname);
      const checksum = checksumText.split(/\r?\n/).map(line => line.trim()).find(line => line.endsWith(filename))?.match(/^([a-f0-9]{64})\s+/i)?.[1];
      return {
        id: `mariadb-${version}-winx64`,
        product: 'mariadb',
        label: `MariaDB Server ${version}`,
        version,
        architecture: 'Win64',
        channel: 'Stable archive',
        url,
        checksum: checksum ? { algorithm: 'sha256', value: checksum } : null,
        signatureUrl: new URL(`${filename}.asc`, directoryUrl).href,
        source: 'MariaDB Archive · official',
        sourceUrl: directoryUrl
      };
    } catch {
      return null;
    }
  }));
  return releases.filter(Boolean);
}

async function listDatabaseReleases({ limit = 8 } = {}) {
  const cacheKey = `database-releases:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value;
  const [mysqlResult, mariadbResult] = await Promise.allSettled([
    listMysqlReleases(limit),
    listMariadbReleases(limit)
  ]);
  const releases = [
    ...(mysqlResult.status === 'fulfilled' ? mysqlResult.value : []),
    ...(mariadbResult.status === 'fulfilled' ? mariadbResult.value : [])
  ].sort((left, right) => {
    if (left.product !== right.product) return left.product === 'mysql' ? -1 : 1;
    return compareVersions(right.version, left.version);
  });
  const result = {
    releases,
    providers: [
      { id: 'mysql', label: 'MySQL Community Server', available: mysqlResult.status === 'fulfilled', error: mysqlResult.status === 'rejected' ? mysqlResult.reason.message : null },
      { id: 'mariadb', label: 'MariaDB Server', available: mariadbResult.status === 'fulfilled', error: mariadbResult.status === 'rejected' ? mariadbResult.reason.message : null }
    ],
    checkedAt: new Date().toISOString()
  };
  cache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

module.exports = { listDatabaseReleases, compareVersions };
