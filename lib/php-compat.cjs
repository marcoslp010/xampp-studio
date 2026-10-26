'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readPeImports, readPeImportSymbols, readPeExports } = require('./pe-imports.cjs');

/**
 * Compatibilidade entre runtime PHP, serviço Apache e Windows.
 *
 * Este módulo concentra a lógica que decide se um runtime PHP pode carregar
 * no contexto do Apache, quais DLLs precisam de `LoadFile` e se o arranque
 * falhou. Fica separado do servidor HTTP para permitir testes automatizados.
 *
 * O problema real que ele resolve: no Windows o carregador resolve DLLs pelo
 * NOME do arquivo. O Apache já carrega `libssl-3-x64.dll`/`libcrypto-3-x64.dll`
 * (OpenSSL do mod_ssl); quando a extensão `curl` do PHP 8.5.12 é carregada,
 * ela passa a usar a cópia do Apache. Com o OpenSSL 3.1.3 do Apache 2.4.58
 * falta o símbolo `SSL_get0_group_name` (OpenSSL 3.2+) e o site fica sem
 * `curl_init()`, mesmo com `extension=curl` no php.ini.
 */

const PHP_CORE_DLL = /^php\d*(?:ts|apache2_4|phpdbg)\.dll$/i;

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extensionDllName(value) {
  const requested = path.basename(String(value).replace(/\\/g, '/'));
  if (/\.dll$/i.test(requested)) return requested;
  return requested.toLowerCase().startsWith('php_') ? `${requested}.dll` : `php_${requested}.dll`;
}

/** Diretivas de extensão ativas de um php.ini (comentadas são ignoradas). */
function phpExtensionDirectives(contents) {
  const directives = [];
  for (const line of String(contents || '').split(/\r?\n/)) {
    if (/^\s*[;#]/.test(line)) continue;
    const match = line.match(/^\s*(zend_extension|extension)\s*=\s*(.*?)\s*$/i);
    if (!match) continue;
    const value = match[2].replace(/\s*[;#].*$/, '').trim().replace(/^['"]|['"]$/g, '');
    if (!value) continue;
    const dll = extensionDllName(value);
    const name = value.replace(/\\/g, '/').split('/').pop().replace(/^php_/i, '').replace(/\.dll$/i, '') || dll;
    directives.push({ name, dll, directive: match[1].toLowerCase() });
  }
  return directives;
}

/**
 * Lista os arquivos de configuração do Apache, seguindo Include/IncludeOptional.
 */
function apacheConfigFiles(apacheRoot, configPath) {
  const files = [];
  const seen = new Set();
  const visit = file => {
    if (!file) return;
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key) || !fs.existsSync(file)) return;
    seen.add(key);
    files.push(file);
    const text = readText(file);
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const match = line.match(/^\s*Include(?:Optional)?\s+(.+?)\s*$/i);
      if (!match) continue;
      let target = match[1].trim().replace(/^['"]|['"]$/g, '').replace(/\$\{SRVROOT\}/gi, apacheRoot.replace(/\\/g, '/'));
      // O Apache resolve Include relativo ao ServerRoot, não à pasta do
      // arquivo que inclui ("conf/extra/httpd-ssl.conf" mora na raiz).
      if (!path.isAbsolute(target)) target = path.join(apacheRoot, target);
      if (target.includes('*')) {
        const directory = path.dirname(target);
        const pattern = path.basename(target)
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*');
        if (fs.existsSync(directory)) {
          for (const name of fs.readdirSync(directory)) {
            if (new RegExp(`^${pattern}$`, 'i').test(name)) visit(path.join(directory, name));
          }
        }
        continue;
      }
      visit(target);
    }
  };
  visit(configPath);
  return files;
}

/**
 * DLLs que o Apache carrega já no arranque (importadas pelos módulos ativos).
 * Essas bibliotecas vencem o runtime do PHP: o Windows resolve dependências
 * pelo nome do arquivo, então o processo fica com a versão do Apache.
 */
function apacheStartupLibraries(apacheRoot, configFiles = []) {
  const loaded = new Map();
  const binDirectory = path.join(apacheRoot, 'bin');
  for (const file of configFiles) {
    const text = readText(file);
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const match = line.match(/^\s*LoadModule\s+(\S+)\s+"?([^"\s]+)"?/i);
      if (!match) continue;
      let modulePath = match[2].replace(/\$\{SRVROOT\}/gi, apacheRoot.replace(/\\/g, '/'));
      if (!path.isAbsolute(modulePath)) modulePath = path.join(apacheRoot, modulePath);
      if (!fs.existsSync(modulePath)) continue;
      for (const name of readPeImports(modulePath)) {
        const candidate = path.join(binDirectory, name);
        if (fs.existsSync(candidate)) loaded.set(name.toLowerCase(), candidate);
      }
    }
  }
  return loaded;
}

/**
 * Confere se as extensões do runtime podem carregar no contexto do Apache.
 * Devolve uma lista de conflitos com o símbolo que falta em cada caso.
 */
function phpRuntimeApacheConflicts(root, phpIniContents, apacheRoot, configFiles = []) {
  const startup = apacheStartupLibraries(apacheRoot, configFiles);
  if (!startup.size) return [];
  const conflicts = [];
  const extDirectory = path.join(root, 'ext');
  const seen = new Set();
  for (const item of phpExtensionDirectives(phpIniContents || '')) {
    const file = path.join(extDirectory, item.dll);
    if (!fs.existsSync(file)) continue;
    for (const entry of readPeImportSymbols(file)) {
      const provided = startup.get(entry.dll.toLowerCase());
      if (!provided || !entry.functions.length) continue;
      const key = `${item.name}|${entry.dll.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const exports = new Set(readPeExports(provided));
      const missing = entry.functions.filter(name => !exports.has(name));
      if (missing.length) conflicts.push({ extension: item.name, dll: entry.dll, missing, provided });
    }
  }
  return conflicts;
}

function describeApacheConflicts(conflicts, apacheVersion) {
  return conflicts
    .map(item => `${item.extension} exige ${item.missing.join(', ')} de ${item.dll}, mas o Apache ${apacheVersion || 'instalado'} usa ${path.basename(item.provided)} sem esses símbolos`)
    .join('; ');
}

/**
 * Descobre as DLLs nativas que o runtime precisa carregar no processo do Apache.
 *
 * O XAMPP original resolvia isso definindo `C:\xampp\php` no PATH do processo
 * (xampp_shell.bat). Quando o Apache sobe como serviço do Windows — ou é
 * iniciado pelo Studio — esse PATH não existe e o Windows não encontra
 * `brotlidec.dll` e companhia.
 *
 * A correção é carregar com LoadFile as DLLs que o Apache NÃO carrega no
 * arranque. As que já entram no processo (OpenSSL do mod_ssl, por exemplo)
 * não podem ser substituídas: o Windows resolve pelo nome do arquivo.
 */
function phpRuntimeDependencyDlls(root, phpIniContents, apacheRoot = null, configFiles = []) {
  const extDirectory = path.join(root, 'ext');
  const loadedByApache = apacheRoot ? apacheStartupLibraries(apacheRoot, configFiles) : new Map();
  const queue = [];
  for (const item of phpExtensionDirectives(phpIniContents || '')) {
    const file = path.join(extDirectory, item.dll);
    if (fs.existsSync(file)) queue.push(file);
  }
  const resolved = new Map();
  const visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    const key = file.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    for (const name of readPeImports(file)) {
      const candidate = path.join(root, name);
      if (!fs.existsSync(candidate)) continue;
      const base = path.basename(candidate);
      if (PHP_CORE_DLL.test(base)) continue;
      const lower = base.toLowerCase();
      if (loadedByApache.has(lower)) continue;
      if (resolved.has(lower)) continue;
      resolved.set(lower, candidate);
      queue.push(candidate);
    }
  }
  return [...resolved.values()].sort((a, b) => a.localeCompare(b));
}

function apacheErrorLogPath(apacheRoot) {
  return path.join(apacheRoot, 'logs', 'error.log');
}

function apacheErrorLogSize(apacheRoot) {
  try { return fs.statSync(apacheErrorLogPath(apacheRoot)).size; } catch { return 0; }
}

/**
 * Lê o trecho do error.log gerado depois do último arranque do Apache e
 * devolve as extensões que o PHP não conseguiu carregar.
 */
function apacheExtensionLoadFailures(apacheRoot, sinceOffset) {
  const file = apacheErrorLogPath(apacheRoot);
  let text = '';
  try {
    const stat = fs.statSync(file);
    if (stat.size <= sinceOffset) return [];
    const length = Math.min(stat.size - sinceOffset, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(file, 'r');
    fs.readSync(handle, buffer, 0, length, sinceOffset);
    fs.closeSync(handle);
    text = buffer.toString('utf8');
  } catch { return []; }
  const failures = new Set();
  for (const match of text.matchAll(/Unable to load dynamic library\s+'([^']+)'/gi)) failures.add(match[1]);
  for (const match of text.matchAll(/Unable to load dynamic library\s+"([^"]+)"/gi)) failures.add(match[1]);
  return [...failures];
}

/**
 * Reescreve a configuração do XAMPP para um runtime PHP novo.
 *
 * A raiz antiga só é trocada quando aparece como segmento inteiro do caminho:
 * sem essa trava, "C:/xampp/php" também reescreveria "C:/xampp/phpMyAdmin" e
 * o alias do phpMyAdmin viraria "...php-8.5.12-ts-x64MyAdmin".
 */
function rewriteXamppPhpConfig(contents, oldRoot, newRoot, phpModule, tsRuntime, phpIniContents = '', apacheRoot = null, apacheFiles = []) {
  const oldVariants = new Set([oldRoot, String(oldRoot).replace(/\\/g, '/'), String(oldRoot).replace(/\//g, '\\')]);
  let output = contents;
  for (const variant of oldVariants) {
    if (!variant) continue;
    const escaped = escapeRegExp(variant);
    // Substitui a raiz somente quando ela é um segmento inteiro do caminho.
    // Sem esta trava, "C:/xampp/php" também reescreveria "C:/xampp/phpMyAdmin".
    output = output.replace(new RegExp(`${escaped}(?=[\\\\/"'\\s;)]|$)`, 'gi'), String(newRoot).replace(/\\/g, '/'));
  }
  const dependencies = phpRuntimeDependencyDlls(newRoot, phpIniContents, apacheRoot, apacheFiles);
  const dependencyFiles = new Map(dependencies.map(file => [path.basename(file).toLowerCase(), file]));
  const oldRootNormalized = String(oldRoot || '').replace(/\\/g, '/').toLowerCase();
  const newRootNormalized = String(newRoot || '').replace(/\\/g, '/').toLowerCase();
  const pointsToPhpRuntime = value => {
    const normalized = String(value).replace(/\\/g, '/');
    const lower = normalized.toLowerCase();
    if (/\/runtimes\/php-/i.test(normalized)) return true;
    if (oldRootNormalized && lower.startsWith(oldRootNormalized)) return true;
    if (newRootNormalized && lower.startsWith(newRootNormalized)) return true;
    return false;
  };
  let moduleSeen = false;
  let tsSeen = false;
  const missing = [];
  const removed = [];
  const loadedDependencies = new Set();
  const lines = output.split(/\r?\n/).map(line => {
    if (/^\s*SetEnv\s+MIBDIRS\b/i.test(line)) return `SetEnv MIBDIRS "${path.join(newRoot, 'extras', 'mibs').replace(/\\/g, '/')}"`;
    if (/^\s*SetEnv\s+PHPRC\b/i.test(line)) return `SetEnv PHPRC "${String(newRoot).replace(/\\/g, '/')}"`;
    if (/^\s*SetEnv\s+PHP_PEAR_SYSCONF_DIR\b/i.test(line)) return `SetEnv PHP_PEAR_SYSCONF_DIR "${String(newRoot).replace(/\\/g, '/')}"`;
    if (/^\s*LoadModule\s+php_module\b/i.test(line)) {
      moduleSeen = true;
      return `LoadModule php_module "${path.join(newRoot, phpModule).replace(/\\/g, '/')}"`;
    }
    const load = line.match(/^(\s*)LoadFile\s+"?([^"\s]+)"?/i);
    if (!load || /^\s*[#;]/.test(line)) return line;
    const oldFile = path.basename(load[2]);
    if (/^php\d*ts\.dll$/i.test(oldFile)) {
      tsSeen = true;
      return `LoadFile "${path.join(newRoot, tsRuntime).replace(/\\/g, '/')}"`;
    }
    const dependency = dependencyFiles.get(oldFile.toLowerCase());
    if (dependency) {
      loadedDependencies.add(oldFile.toLowerCase());
      return `LoadFile "${path.join(newRoot, path.basename(dependency)).replace(/\\/g, '/')}"`;
    }
    if (/^(?:libpq|libsqlite3)\.dll$/i.test(oldFile)) {
      if (!fs.existsSync(path.join(newRoot, oldFile))) {
        missing.push(oldFile);
        return `# XAMPP Studio: ${oldFile} não existe no runtime PHP selecionado.\n# ${line.trim()}`;
      }
      return `LoadFile "${path.join(newRoot, oldFile).replace(/\\/g, '/')}"`;
    }
    // Remove DLLs de runtime PHP que o novo runtime não usa mais.
    if (pointsToPhpRuntime(load[2])) {
      removed.push(oldFile);
      return `# XAMPP Studio: ${oldFile} não é mais necessário neste runtime PHP.`;
    }
    return line;
  });
  const pendingDependencies = [...dependencyFiles.entries()].filter(([name]) => !loadedDependencies.has(name));
  if (pendingDependencies.length) {
    const anchor = lines.findIndex(line => /^\s*LoadFile\s+"?.*php\d*ts\.dll/i.test(line));
    const extra = pendingDependencies.map(([, file]) => `LoadFile "${path.join(newRoot, path.basename(file)).replace(/\\/g, '/')}"`);
    const position = anchor >= 0 ? anchor + 1 : lines.length;
    lines.splice(position, 0, ...extra);
  }
  output = lines.join('\r\n');
  if (!moduleSeen) throw new Error('Não encontrei LoadModule php_module ativo em httpd-xampp.conf.');
  if (!tsSeen) throw new Error('Não encontrei LoadFile do runtime Thread Safe do PHP em httpd-xampp.conf.');
  return { text: output, missing, removed, dependencies: dependencies.map(file => path.basename(file)) };
}

module.exports = {
  PHP_CORE_DLL,
  apacheConfigFiles,
  apacheErrorLogPath,
  apacheErrorLogSize,
  apacheExtensionLoadFailures,
  apacheStartupLibraries,
  describeApacheConflicts,
  escapeRegExp,
  extensionDllName,
  phpExtensionDirectives,
  phpRuntimeApacheConflicts,
  phpRuntimeDependencyDlls,
  rewriteXamppPhpConfig
};
