'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Estado do runtime ativo do XAMPP Studio.
 *
 * As raízes e o caminho do estado ficam definidos neste módulo para que a
 * leitura do ambiente não dependa do servidor HTTP. O cache acompanha a
 * assinatura do arquivo para manter o mesmo resultado mesmo quando outro
 * processo troca o environment-state.json.
 */

const APP_ROOT = path.resolve(__dirname, '..');
const XAMPP_ROOT = process.env.XAMPP_ROOT || 'C:\\xampp';
const WORKSPACE_ROOT = path.join(APP_ROOT, 'workspace');
const ENVIRONMENT_STATE = path.join(APP_ROOT, 'environment-state.json');

let environmentStateCache = null;
let environmentStateCacheStamp = null;

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function writeAtomically(file, contents) {
  const temp = `${file}.xampp-studio-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents, { flag: 'wx' });
  try { fs.renameSync(temp, file); }
  catch (error) { fs.rmSync(temp, { force: true }); throw error; }
}

function environmentStateStamp() {
  try {
    const stat = fs.statSync(ENVIRONMENT_STATE);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino || 0}`;
  } catch {
    return null;
  }
}

function cloneEnvironmentState(value) {
  return JSON.parse(JSON.stringify(value));
}

function readEnvironmentState() {
  const stamp = environmentStateStamp();
  if (environmentStateCache !== null && stamp === environmentStateCacheStamp) return cloneEnvironmentState(environmentStateCache);
  try {
    const value = JSON.parse(readText(ENVIRONMENT_STATE));
    environmentStateCache = value && typeof value === 'object' ? value : {};
  } catch {
    environmentStateCache = {};
  }
  environmentStateCacheStamp = stamp;
  return cloneEnvironmentState(environmentStateCache);
}

function writeEnvironmentState(state) {
  const value = state && typeof state === 'object' ? state : {};
  const contents = JSON.stringify(value, null, 2);
  writeAtomically(ENVIRONMENT_STATE, contents);
  environmentStateCache = JSON.parse(contents);
  environmentStateCacheStamp = environmentStateStamp();
  return cloneEnvironmentState(environmentStateCache);
}

function runtimeMode() {
  const state = readEnvironmentState();
  const configured = state.mode || process.env.XAMPP_STUDIO_MODE;
  if (configured === 'standalone' || configured === 'legacy') return configured;
  return fs.existsSync(path.join(XAMPP_ROOT, 'properties.ini')) || fs.existsSync(path.join(XAMPP_ROOT, 'apache'))
    ? 'legacy'
    : 'standalone';
}

function isStandaloneMode() {
  return runtimeMode() === 'standalone';
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function activeApacheRuntime() {
  const state = readEnvironmentState();
  const defaultRoot = path.join(XAMPP_ROOT, 'apache');
  const defaultRuntime = {
    root: defaultRoot,
    executable: path.join(defaultRoot, 'bin', 'httpd.exe'),
    config: path.join(defaultRoot, 'conf', 'httpd.conf'),
    version: state.apacheVersion || null,
    source: 'XAMPP importado'
  };
  if (typeof state.apacheRoot !== 'string' || !state.apacheRoot.trim()) return defaultRuntime;
  const resolved = path.resolve(state.apacheRoot);
  if (!fs.existsSync(resolved)) return defaultRuntime;
  const metadataPath = path.join(resolved, 'xampp-studio-runtime.json');
  if (!fs.existsSync(metadataPath)) {
    return {
      root: resolved,
      executable: path.join(resolved, 'bin', 'httpd.exe'),
      config: state.apacheConfig || path.join(resolved, 'conf', 'httpd.conf'),
      version: state.apacheVersion || null,
      source: samePath(resolved, defaultRoot) ? 'XAMPP importado' : 'Ambiente independente'
    };
  }
  const metadata = JSON.parse(readText(metadataPath));
  const generatedConfig = path.join(resolved, 'conf', 'xampp-studio-httpd.conf');
  const config = state.apacheConfig || (fs.existsSync(generatedConfig) ? generatedConfig : path.join(resolved, 'conf', 'httpd.conf'));
  return { ...metadata, root: resolved, executable: path.join(resolved, 'bin', 'httpd.exe'), config, source: 'XAMPP Studio' };
}

function activeMySqlRuntime() {
  const state = readEnvironmentState();
  const defaultRoot = path.join(XAMPP_ROOT, 'mysql');
  const defaultRuntime = {
    root: defaultRoot,
    executable: path.join(defaultRoot, 'bin', 'mysqld.exe'),
    config: path.join(defaultRoot, 'bin', 'my.ini'),
    version: state.mysqlVersion || null,
    product: state.mysqlProduct || null,
    source: 'XAMPP importado'
  };
  if (typeof state.mysqlRoot !== 'string' || !state.mysqlRoot.trim()) return defaultRuntime;
  const resolved = path.resolve(state.mysqlRoot);
  if (!fs.existsSync(resolved)) return defaultRuntime;
  const metadataPath = path.join(resolved, 'studio-runtime.json');
  if (!fs.existsSync(metadataPath)) {
    return {
      root: resolved,
      executable: path.join(resolved, 'bin', 'mysqld.exe'),
      config: state.mysqlConfig || path.join(resolved, 'my.ini'),
      version: state.mysqlVersion || null,
      product: state.mysqlProduct || null,
      source: samePath(resolved, defaultRoot) ? 'XAMPP importado' : 'Ambiente independente'
    };
  }
  const metadata = JSON.parse(readText(metadataPath));
  return {
    ...metadata,
    root: resolved,
    executable: path.join(resolved, 'bin', 'mysqld.exe'),
    config: state.mysqlConfig || path.join(resolved, 'my.ini'),
    source: 'XAMPP Studio'
  };
}

function parseIniValue(contents, key) {
  const match = contents.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'im'));
  return match ? match[1].replace(/^['"]|['"]$/g, '') : null;
}

function getConfig() {
  const state = readEnvironmentState();
  const properties = readText(path.join(XAMPP_ROOT, 'properties.ini'));
  const configuredPhpRoot = typeof state.phpRoot === 'string' && state.phpRoot.trim() ? state.phpRoot : null;
  const phpRoot = path.resolve(configuredPhpRoot || parseIniValue(properties, 'php_binary_directory') || path.join(XAMPP_ROOT, 'php'));
  const apacheRuntime = activeApacheRuntime();
  const apacheConf = state.apacheConfig
    || (isStandaloneMode() ? apacheRuntime.config : path.join(XAMPP_ROOT, 'apache', 'conf', 'extra', 'httpd-xampp.conf'));
  const configText = readText(apacheConf);
  const activeModule = configText.match(/^\s*LoadModule\s+php_module\s+"([^"]+php[^"\\/]*apache[^"\\/]*\.dll)"/im)?.[1] || null;
  const phpIniDir = configText.match(/^\s*PHPINIDir\s+"([^"]+)"/im)?.[1] || null;
  const phpVersion = state.phpVersion || parseIniValue(properties, 'base_stack_version')?.split('-')[0] || null;
  return { phpRoot, apacheConf, activeModule, phpIniDir, phpVersion, mode: runtimeMode(), apacheRuntime, mysqlRuntime: activeMySqlRuntime() };
}

function canWrite(file) {
  try { fs.accessSync(file, fs.constants.W_OK); return true; } catch { return false; }
}

/**
 * Garante que o executável do serviço esteja entre aspas. Sem isso, um
 * ImagePath como "C:\Program Files\...\httpd.exe -k runservice" é recusado
 * pelo SCM com "Parâmetro incorreto" (ERRO_INVALID_PARAMETER).
 * A implementação vive em lib/service-command.cjs.
 */
function serviceNameFor(component) {
  const state = readEnvironmentState();
  const override = component === 'apache' ? state.apacheServiceName : component === 'mysql' ? state.mysqlServiceName : null;
  if (typeof override === 'string' && override.trim()) return override.trim();
  if (component === 'apache') return isStandaloneMode() ? 'XAMPPStudio-Apache' : 'Apache2.4';
  if (component === 'mysql') return isStandaloneMode() ? 'XAMPPStudio-MySQL' : 'mysql';
  throw new Error('Componente de serviço inválido.');
}

module.exports = {
  APP_ROOT,
  ENVIRONMENT_STATE,
  WORKSPACE_ROOT,
  XAMPP_ROOT,
  activeApacheRuntime,
  activeMySqlRuntime,
  canWrite,
  getConfig,
  isInside,
  isStandaloneMode,
  parseIniValue,
  readEnvironmentState,
  readText,
  runtimeMode,
  samePath,
  serviceNameFor,
  writeAtomically,
  writeEnvironmentState
};
