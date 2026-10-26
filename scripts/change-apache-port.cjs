'use strict';

/**
 * Troca a porta do Apache em uso.
 *
 *   node scripts/change-apache-port.cjs 8080
 *
 * O script copia o httpd em uso, reescreve Listen/ServerName, valida com
 * "httpd -t", reinicia o serviço do Windows e confere que a nova porta
 * responde. Se qualquer etapa falhar, a configuração anterior é restaurada.
 *
 * Não precisa de elevação: o Studio já libera o controle do serviço Apache
 * para o usuário atual (DACL), então "sc start/stop" funciona normalmente.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');

const execFileAsync = promisify(execFile);
const APP_ROOT = path.resolve(__dirname, '..');
const BACKUP_ROOT = path.join(APP_ROOT, 'backups');
const { activeApacheRuntime, readText, serviceNameFor, writeAtomically } = require('../lib/runtime-state.cjs');
const { apachePrimaryPort, rewriteApacheListenPort } = require('../lib/apache-config.cjs');

function log(message) {
  console.log(message);
}

function serviceState(serviceName) {
  try {
    const output = execFileSync('sc.exe', ['query', serviceName], { encoding: 'utf8', windowsHide: true });
    // O Windows responde "STATE" em inglês e "ESTADO" em português.
    return Number(output.match(/^\s*(?:STATE|ESTADO)\s*:\s*(\d+)/im)?.[1] || 0) || null;
  } catch {
    return null;
  }
}

async function waitForService(serviceName, expected, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = serviceState(serviceName);
    if (state === expected) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Inicia o serviço tentando de novo.
 *
 * O Windows responde 1056 ("uma cópia já está sendo executada") enquanto o
 * processo anterior ainda está encerrando; repetir Some resolve isso.
 */
async function startService(serviceName, attempts = 6) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await execFileAsync('sc.exe', ['start', serviceName], { timeout: 30000, windowsHide: true });
    } catch (error) {
      const details = `${error.stdout || ''} ${error.stderr || ''}`.trim();
      lastError = new Error(details || error.message);
      // 1056: a instância anterior ainda está encerrando. O Windows
      // concludes a partida sozinho; o que importa é o estado final.
      if (!/1056/i.test(details)) throw lastError;
    }
    if (await waitForService(serviceName, 4, 30000)) return true;
    lastError = lastError || new Error(`O serviço não atingiu o estado RUNNING (estado ${serviceState(serviceName)}).`);
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  throw lastError || new Error('Não consegui iniciar o serviço.');
}

async function waitForPort(port, timeoutMs = 20000) {
  const net = require('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const done = value => { socket.destroy(); resolve(value); };
      socket.setTimeout(500);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
    if (open) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Informe uma porta entre 1024 e 65535. Exemplo: node scripts/change-apache-port.cjs 8080');
  }
  const apache = activeApacheRuntime();
  const config = apache.config;
  const contents = readText(config);
  if (!contents) throw new Error(`Não consegui ler a configuração: ${config}`);
  const current = apachePrimaryPort(contents);
  if (current === port) {
    log(`O Apache já escuta na porta ${port}.`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BACKUP_ROOT, `port-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, path.basename(config));
  fs.copyFileSync(config, backupFile);
  log(`Backup: ${backupFile}`);

  // O nome real do serviço vem do estado do ambiente: no modo legado é
  // "Apache2.4", no independente é "XAMPPStudio-Apache" (ou o nome que o
  // usuário configurou).
  const serviceName = serviceNameFor('apache');
  const restore = async () => {
    writeAtomically(config, fs.readFileSync(backupFile));
    const state = serviceState(serviceName);
    if (state === 4) {
      await execFileAsync('sc.exe', ['stop', serviceName], { timeout: 30000, windowsHide: true }).catch(() => {});
      await waitForService(serviceName, 1, 40000);
    }
    await startService(serviceName).catch(() => {});
  };

  try {
    writeAtomically(config, rewriteApacheListenPort(contents, port));
    const check = await execFileAsync(apache.executable, ['-t', '-d', apache.root, '-f', apache.config], { cwd: apache.root, timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 });
    if (!/Syntax OK/i.test(`${check.stdout}\n${check.stderr}`)) throw new Error('A configuração não passou na validação (httpd -t).');

    const state = serviceState(serviceName);
    if (state === 4) {
      await execFileAsync('sc.exe', ['stop', serviceName], { timeout: 30000, windowsHide: true });
      await waitForService(serviceName, 1, 40000);
    }
    await startService(serviceName);
    const responding = await waitForPort(port, 20000);
    if (!responding) throw new Error(`O serviço subiu, mas a porta ${port} não respondeu.`);

    log(`Apache migrado: ${current} -> ${port}`);
    log(`Site: http://localhost:${port}`);
    log(`SHA-256 do httpd.conf anterior: ${createHash('sha256').update(fs.readFileSync(backupFile)).digest('hex')}`);
  } catch (error) {
    log(`Falhou: ${error.message}`);
    await restore();
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
