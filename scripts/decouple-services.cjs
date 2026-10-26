'use strict';

/**
 * Ativa o ambiente totalmente independente do XAMPP Studio.
 *
 *   node scripts/decouple-services.cjs
 *
 * O que muda:
 *
 *  · o XAMPP volta ao estado original (properties.ini aponta para C:\xampp\php
 *    e a versão 8.2.12) — o Studio não mexe mais no painel do XAMPP;
 *  · o estado do Studio (environment-state.json) passa a guardar tudo:
 *    runtimes, porta, serviços e modo "standalone";
 *  · os serviços próprios XAMPPStudio-Apache e XAMPPStudio-MySQL são
 *    registrados com os executáveis do Studio;
 *  · os serviços legados (Apache2.4 e mysql) são parados e passam a iniciar
 *    manualmente, para não disputarem as mesmas portas a cada boot.
 *
 * Nada é apagado: os dados do XAMPP continuam em C:\xampp\mysql\data e o
 * Apache antigo continua instalado.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const APP_ROOT = path.resolve(__dirname, '..');
const XAMPP_ROOT = process.env.XAMPP_ROOT || 'C:\\xampp';
const STUDIO_URL = `http://127.0.0.1:${process.env.XAMPP_STUDIO_PORT || 43197}`;
const ENVIRONMENT_STATE = path.join(APP_ROOT, 'environment-state.json');
const LEGACY_SERVICES = ['Apache2.4', 'mysql'];

function log(message) {
  console.log(message);
}

async function api(route, body) {
  const response = await fetch(`${STUDIO_URL}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: STUDIO_URL },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 200) }; }
  if (!response.ok) throw new Error(parsed?.error || `O Studio respondeu ${response.status}.`);
  return parsed;
}

async function serviceState(serviceName) {
  try {
    const { stdout } = await execFileAsync('sc.exe', ['query', serviceName], { timeout: 8000, windowsHide: true });
    return Number(stdout.match(/^\s*(?:STATE|ESTADO)\s*:\s*(\d+)/im)?.[1] || 0) || null;
  } catch {
    return null;
  }
}

async function stopService(serviceName) {
  if (await serviceState(serviceName) === 1) return;
  await execFileAsync('sc.exe', ['stop', serviceName], { timeout: 40000, windowsHide: true }).catch(() => {});
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (await serviceState(serviceName) === 1) return;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  log(`    Aviso: ${serviceName} não confirmou a parada.`);
}

async function main() {
  const runtimeRoot = path.join(APP_ROOT, 'runtimes');
  const apacheRoot = path.join(runtimeRoot, 'apache-2.4.69-261002-win64');
  const phpRoot = path.join(runtimeRoot, 'php-8.5.12-ts-x64');
  const mysqlRoot = path.join(runtimeRoot, 'mariadb-13.1.1-winx64');

  log('1/6 · Devolvendo o XAMPP ao estado original...');
  const propertiesPath = path.join(XAMPP_ROOT, 'properties.ini');
  if (fs.existsSync(propertiesPath)) {
    let properties = fs.readFileSync(propertiesPath, 'utf8');
    const update = (text, key, value) => {
      const line = new RegExp(`^\\s*${key}\\s*=.*$`, 'im');
      return line.test(text) ? text.replace(line, `${key}=${value}`) : `${text.trimEnd()}\r\n${key}=${value}\r\n`;
    };
    properties = update(properties, 'php_binary_directory', path.join(XAMPP_ROOT, 'php'));
    properties = update(properties, 'base_stack_version', '8.2.12-0');
    fs.writeFileSync(propertiesPath, properties, 'utf8');
    log('    properties.ini: php_binary_directory e base_stack_version restaurados.');
  }

  log('2/6 · Gravando o estado independente do Studio...');
  const previous = fs.existsSync(ENVIRONMENT_STATE) ? JSON.parse(fs.readFileSync(ENVIRONMENT_STATE, 'utf8')) : {};
  const state = {
    ...previous,
    mode: 'standalone',
    phpRoot,
    phpVersion: '8.5.12',
    apacheRoot,
    apacheConfig: path.join(apacheRoot, 'conf', 'xampp-studio-httpd.conf'),
    apacheVersion: '2.4.69',
    apacheServiceName: 'XAMPPStudio-Apache',
    mysqlRoot,
    mysqlConfig: path.join(mysqlRoot, 'my.ini'),
    mysqlVersion: '13.1.1',
    mysqlProduct: 'mariadb',
    mysqlServiceName: 'XAMPPStudio-MySQL'
  };
  fs.writeFileSync(ENVIRONMENT_STATE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  log(`    Estado: ${ENVIRONMENT_STATE}`);

  log('3/6 · Parando os serviços legados...');
  for (const name of LEGACY_SERVICES) {
    await stopService(name);
    log(`    ${name}: parado.`);
  }

  log('4/6 · Registrando os serviços próprios do Studio...');
  await api('/api/services/integrate', { service: 'apache' });
  log('    XAMPPStudio-Apache registrado.');
  await api('/api/services/integrate', { service: 'mysql' });
  log('    XAMPPStudio-MySQL registrado.');

  log('5/6 · Iniciando os serviços próprios...');
  await api('/api/services/restart', { service: 'apache' });
  log('    XAMPPStudio-Apache no ar.');
  await api('/api/services/restart', { service: 'mysql' });
  log('    XAMPPStudio-MySQL no ar.');

  log('6/6 · Desativando a inicialização automática dos serviços legados...');
  for (const name of LEGACY_SERVICES) {
    await api('/api/services/start-type', { serviceName: name, startType: 'demand' });
    log(`    ${name}: inicialização manual.`);
  }

  log('\nEstado final:');
  for (const name of [...LEGACY_SERVICES, 'XAMPPStudio-Apache', 'XAMPPStudio-MySQL']) {
    log(`    ${name}: ${await serviceState(name) === 4 ? 'rodando' : 'parado'}`);
  }
}

main().catch(error => {
  console.error(`\nFalhou: ${error.message}`);
  process.exit(1);
});
