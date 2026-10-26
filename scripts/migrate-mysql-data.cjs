'use strict';

/**
 * Migra os bancos do MySQL do XAMPP para o runtime isolado do Studio.
 *
 *   node scripts/migrate-mysql-data.cjs
 *
 * Nada é apagado: os dados do XAMPP continuam onde estão e o runtime isolado
 * recebe uma cópia. O import acontece numa instância temporária na porta
 * 3307, enquanto o MySQL antigo continua servindo na 3306 — ou seja, sem
 * indisponibilidade.
 *
 * Etapas:
 *  1. despeja os bancos de usuário do MySQL antigo (sem os bancos de sistema);
 *  2. sobe o runtime isolado na 3307 e importa o despejo;
 *  3. compara a quantidade de tabelas de cada banco antes e depois;
 *  4. desliga a instância temporária.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const APP_ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.join(APP_ROOT, 'workspace');
const RUNTIME_ROOT = path.join(APP_ROOT, 'runtimes', 'mariadb-13.1.1-winx64');
const BIN = path.join(RUNTIME_ROOT, 'bin');
const MYSQL_ROOT = path.join('C:\\xampp', 'mysql');
const TEMP_PORT = 3307;
const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

function log(message) {
  console.log(message);
}

function readCredentials() {
  const file = path.join(WORKSPACE, 'mysql', 'credentials', 'mariadb-13.1.1-winx64.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function listDatabases(host, port, user, password) {
  const args = [`--host=${host}`, `--port=${port}`, `--user=${user}`, '--batch', '--skip-column-names', '-e', 'SHOW DATABASES;'];
  // A senha nunca vai para a linha de comando (legível por qualquer processo
  // via Win32_Process.CommandLine): usa a variável de ambiente MYSQL_PWD.
  const { stdout } = await execFileAsync(path.join(MYSQL_ROOT, 'bin', 'mysql.exe'), args, { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: mysqlClientEnv(password) });
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

async function tableCount(host, port, user, password, database) {
  const args = [`--host=${host}`, `--port=${port}`, `--user=${user}`, '--batch', '--skip-column-names', '-e',
    `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${database.replace(/'/g, "''")}';`];
  const { stdout } = await execFileAsync(path.join(MYSQL_ROOT, 'bin', 'mysql.exe'), args, { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024, env: mysqlClientEnv(password) });
  return Number(stdout.trim() || 0);
}

function mysqlClientEnv(password) {
  return password ? { ...process.env, MYSQL_PWD: password } : process.env;
}

async function waitForPort(port, timeoutMs = 60000) {
  const net = require('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const done = value => { socket.destroy(); resolve(value); };
      socket.setTimeout(600);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
    if (open) return true;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  return false;
}

async function main() {
  const credentials = readCredentials();
  const backupDir = path.join(WORKSPACE, 'mysql', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const dumpFile = path.join(backupDir, `xampp-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);

  log('1/4 · Listando bancos do MySQL antigo...');
  const databases = (await listDatabases('localhost', 3306, 'root', '')).filter(name => !SYSTEM_DATABASES.has(name));
  if (!databases.length) throw new Error('Nenhum banco de usuário encontrado no MySQL antigo.');
  log(`    Bancos: ${databases.join(', ')}`);

  const before = {};
  for (const database of databases) before[database] = await tableCount('localhost', 3306, 'root', '', database);
  log(`    Tabelas antes: ${Object.entries(before).map(([name, count]) => `${name}=${count}`).join(', ')}`);

  log('2/4 · Despejando os bancos...');
  const dumpArgs = [
    '--host=localhost', '--port=3306', '--user=root',
    '--databases', ...databases,
    '--single-transaction', '--routines', '--events', '--triggers',
    '--add-drop-table', '--default-character-set=utf8mb4',
    '--result-file=' + dumpFile
  ];
  await execFileAsync(path.join(MYSQL_ROOT, 'bin', 'mysqldump.exe'), dumpArgs, { timeout: 30 * 60 * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const dumpBytes = fs.statSync(dumpFile).size;
  log(`    Despejo: ${dumpFile} (${(dumpBytes / 1024 / 1024).toFixed(1)} MB)`);

  log(`3/4 · Subindo o runtime isolado na porta ${TEMP_PORT} para importar...`);
  const server = spawn(path.join(BIN, 'mariadbd.exe'), [
    `--defaults-file=${path.join(RUNTIME_ROOT, 'my.ini')}`,
    `--port=${TEMP_PORT}`
  ], { detached: false, stdio: 'ignore', windowsHide: true, cwd: RUNTIME_ROOT });
  let temporary = true;
  const stopTemporary = async () => {
    if (!temporary) return;
    temporary = false;
    // O desligamento administrativo vem PRIMEIRO: dá ao InnoDB o tempo de
    // fazer flush limpo dos dados recém-importados. O kill é só fallback
    // para um processo que não saiu — TerminateProcess no meio de uma
    // escrita força crash recovery.
    try {
      const adminArgs = ['--host=127.0.0.1', `--port=${TEMP_PORT}`, '--user=root', 'shutdown'];
      await execFileAsync(path.join(BIN, 'mariadb-admin.exe'), adminArgs, { timeout: 20000, windowsHide: true, env: mysqlClientEnv(credentials.password) });
    } catch { /* o kill abaixo cobre o caso de o shutdown não ter funcionado */ }
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 10000);
      server.once('close', () => { clearTimeout(timer); resolve(); });
    });
    try { process.kill(server.pid); } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  };

  try {
    if (!await waitForPort(TEMP_PORT, 60000)) throw new Error(`O runtime isolado não respondeu na porta ${TEMP_PORT}.`);
    log(`    Runtime no ar. Importando o despejo...`);
    const importArgs = [
      `--host=127.0.0.1`, `--port=${TEMP_PORT}`, '--user=root',
      '--default-character-set=utf8mb4', '--max-allowed-packet=512M'
    ];
    // mariadb.exe lê o despejo pela entrada padrão: o arquivo é canalizado
    // para o stdin e o processo precisa terminar com código 0. A senha vai
    // pelo ambiente (MYSQL_PWD), nunca pela linha de comando.
    const child = spawn(path.join(BIN, 'mariadb.exe'), importArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: mysqlClientEnv(credentials.password) });
    const stderr = [];
    child.stderr.on('data', chunk => stderr.push(chunk.toString()));
    child.stdout.on('data', () => {});
    const timeout = setTimeout(() => child.kill(), 30 * 60 * 1000);
    fs.createReadStream(dumpFile).pipe(child.stdin);
    const code = await new Promise(resolve => child.once('close', resolve));
    clearTimeout(timeout);
    if (code !== 0) throw new Error(`A importação falhou: ${stderr.join('').slice(0, 400) || `código ${code}`}`);

    log('4/4 · Conferindo as tabelas importadas...');
    const after = {};
    for (const database of databases) after[database] = await tableCount('127.0.0.1', TEMP_PORT, 'root', credentials.password, database);
    log(`    Tabelas depois: ${Object.entries(after).map(([name, count]) => `${name}=${count}`).join(', ')}`);
    const divergentes = databases.filter(name => before[name] !== after[name]);
    if (divergentes.length) throw new Error(`Contagem de tabelas divergente em: ${divergentes.join(', ')}.`);
    log(`\nMigração concluída: ${databases.length} bancos, ${Object.values(after).reduce((a, b) => a + b, 0)} tabelas.`);
    log(`Despejo preservado em: ${dumpFile}`);
  } finally {
    await stopTemporary();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
