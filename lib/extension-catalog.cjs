'use strict';

const path = require('node:path');

function extensionName(value) {
  const name = String(value || '').trim().replace(/^ext-/i, '').replace(/^php_/i, '').replace(/\.dll$/i, '').toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,79}$/.test(name)) throw new Error('Informe o nome da extensão, como ext-opentelemetry, opentelemetry ou php_opentelemetry.dll.');
  return name;
}

function parsePeclBuilds(html, directoryUrl, target) {
  const builds = new Map();
  const directory = new URL(directoryUrl);
  for (const match of html.matchAll(/href=["']([^"']+\.zip)["']/gi)) {
    let url;
    try { url = new URL(match[1].replace(/&amp;/g, '&'), directory); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== 'downloads.php.net' || url.port || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(directory.pathname)) continue;
    const file = path.posix.basename(url.pathname);
    const parts = file.match(/^php_([a-z0-9_-]+)-(\d+\.\d+\.\d+)-(\d+\.\d+)-(nts|ts)-(vs\d+|vc\d+)-(x64|x86)\.zip$/i);
    if (!parts || `${parts[1]}/${parts[2]}/`.toLowerCase() !== directory.pathname.split('/releases/')[1]?.toLowerCase()) continue;
    if (target.phpMinor !== parts[3]) continue;
    const build = { file, url: url.href, package: parts[1], release: parts[2], phpVersion: parts[3], threadSafety: parts[4].toLowerCase(), compiler: parts[5].toUpperCase(), architecture: parts[6].toLowerCase() };
    build.compatible = build.threadSafety === target.threadSafety && build.compiler === String(target.compiler || '').toUpperCase() && build.architecture === target.architecture;
    builds.set(file, build);
  }
  return [...builds.values()].sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.file.localeCompare(b.file));
}

async function searchExtensionCatalog(query, fetcher = fetch) {
  const term = typeof query === 'string' ? query.trim() : '';
  if (term.length < 2 || term.length > 80) throw new Error('Digite entre 2 e 80 caracteres para pesquisar.');
  let directName = null;
  try { directName = extensionName(term); } catch {}
  const endpoint = new URL('https://packagist.org/search.json');
  endpoint.searchParams.set('type', 'php-ext');
  endpoint.searchParams.set('q', directName || term);
  endpoint.searchParams.set('per_page', '20');
  const request = async (url, type) => {
    const response = await fetcher(url, { headers: { accept: type, 'user-agent': 'XAMPP-Studio-extension-catalog/0.2' }, signal: AbortSignal.timeout(9000) });
    if (!response.ok) throw new Error(`Catálogo respondeu HTTP ${response.status}.`);
    return response;
  };
  const [packagist, pecl] = await Promise.allSettled([
    request(endpoint, 'application/json').then(response => response.json()),
    directName ? request(`https://pecl.php.net/rest/r/${directName}/allreleases.xml`, 'application/xml').then(response => response.text()) : Promise.resolve(null)
  ]);
  const packages = [];
  const warnings = [];
  if (pecl.status === 'fulfilled' && /<v>[^<]+<\/v>/.test(pecl.value || '')) {
    packages.push({ name: `ext-${directName}`, extension: directName, source: 'PECL · DLL Windows', description: `Extensão PHP ${directName}. Consulte os builds Windows compatíveis com o PHP selecionado.`, url: `https://pecl.php.net/package/${directName}`, downloads: 0, favorites: 0 });
  } else if (pecl.status === 'rejected' && !/HTTP 404/.test(pecl.reason.message)) warnings.push(`Consulta PECL indisponível: ${pecl.reason.message}`);
  if (packagist.status === 'fulfilled' && Array.isArray(packagist.value.results)) {
    for (const item of packagist.value.results.slice(0, 20)) {
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(item.name || '')) continue;
      let extension = null;
      try { extension = extensionName(item.name.split('/')[1]); } catch {}
      packages.push({ name: item.name, extension, source: 'Packagist · PIE', description: String(item.description || 'Sem descrição publicada.').slice(0, 500), url: `https://packagist.org/packages/${item.name}`, downloads: Number.isFinite(item.downloads) ? item.downloads : 0, favorites: Number.isFinite(item.favers) ? item.favers : 0 });
    }
  } else warnings.push('Packagist indisponível. A consulta direta ao PECL continua disponível.');
  if (!packages.length && warnings.length) throw new Error(warnings.join(' '));
  return { query: term, normalizedQuery: directName || term, source: 'PECL + Packagist', packages, warnings, checkedAt: new Date().toISOString() };
}

module.exports = { extensionName, parsePeclBuilds, searchExtensionCatalog };
