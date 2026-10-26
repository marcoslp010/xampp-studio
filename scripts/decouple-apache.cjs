'use strict';

/**
 * Desacopla o Apache em uso do XAMPP instalado.
 *
 *   node scripts/decouple-apache.cjs
 *
 * O que ele faz, nesta ordem:
 *
 *  1. copia para o runtime os arquivos conf/extra que faltam (httpd-proxy,
 *     httpd-ajp e httpd-xampp vêm do XAMPP, mas passam a viver no runtime);
 *  2. reescreve os Include da configuração ativa para apontar para o
 *     conf/extra do próprio runtime;
 *  3. corrige o Define SRVROOT, que ainda apontava para C:/xampp/apache;
 *  4. acrescenta regras <Directory> que negam acesso aos arquivos de
 *     gerenciador (server.cjs, environment-state.json, backups/, runtimes/…)
 *     caso o Studio morasse dentro do DocumentRoot;
 *  5. valida com "httpd -t", reinicia o serviço e confere a resposta.
 *
 * Qualquer falha restaura o httpd.conf anterior.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const APP_ROOT = path.resolve(__dirname, '..');
const { activeApacheRuntime, readText, writeAtomically } = require('../lib/runtime-state.cjs');
const { apacheDenyRules, apachePrimaryPort } = require('../lib/apache-config.cjs');

const SERVICE_NAME = 'Apache2.4';
// Arquivos de configuração que o runtime passa a ter como próprios.
// O httpd-ssl.conf entra na lista porque usa caminho relativo
// ("conf/ssl.crt/server.crt"), resolvido contra o ServerRoot do runtime —
// exatamente onde o Studio gerou o certificado de 2048 bits. A cópia do
// Apache Lounge aponta para "conf/server.crt", que não existe no runtime.
const EXTRA_FILES = [
  'httpd-proxy.conf', 'httpd-ajp.conf', 'httpd-xampp.conf', 'httpd-userdir.conf',
  'httpd-autoindex.conf', 'httpd-languages.conf', 'httpd-info.conf',
  'httpd-vhosts.conf', 'httpd-default.conf', 'proxy-html.conf', 'httpd-ssl.conf'
];

function log(message) {
  console.log(message);
}

function serviceState(serviceName) {
  try {
    const output = execFileSync('sc.exe', ['query', serviceName], { encoding: 'utf8', windowsHide: true });
    return Number(output.match(/^\s*(?:STATE|ESTADO)\s*:\s*(\d+)/im)?.[1] || 0) || null;
  } catch {
    return null;
  }
}

async function waitForService(serviceName, expected, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serviceState(serviceName) === expected) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function startService(serviceName) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await execFileAsync('sc.exe', ['start', serviceName], { timeout: 30000, windowsHide: true });
    } catch (error) {
      const details = `${error.stdout || ''} ${error.stderr || ''}`.trim();
      if (!/1056/i.test(details)) throw new Error(details || error.message);
    }
    if (await waitForService(serviceName, 4, 30000)) return true;
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  throw new Error('Não consegui iniciar o serviço do Apache.');
}

async function main() {
  const apache = activeApacheRuntime();
  const config = apache.config;
  const original = readText(config);
  if (!original) throw new Error(`Não consegui ler a configuração: ${config}`);

  const backupDir = path.join(APP_ROOT, 'backups', `decouple-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(config, path.join(backupDir, path.basename(config)));
  log(`Backup: ${path.join(backupDir, path.basename(config))}`);

  // 1. Arquivos de configuração que faltam no runtime.
  const runtimeExtra = path.join(apache.root, 'conf', 'extra');
  const xamppExtra = path.join('C:\\xampp', 'apache', 'conf', 'extra');
  fs.mkdirSync(runtimeExtra, { recursive: true });
  for (const name of EXTRA_FILES) {
    const target = path.join(runtimeExtra, name);
    const source = path.join(xamppExtra, name);
    if (!fs.existsSync(source)) {
      log(`Ignorado (não existe no XAMPP): ${name}`);
      continue;
    }
    if (fs.existsSync(target) && fs.readFileSync(target).equals(fs.readFileSync(source))) continue;
    fs.copyFileSync(source, target);
    log(`Importado para o runtime: conf/extra/${name}`);
  }

  // 2 e 3. Include e SRVROOT apontando para o runtime.
  let rewritten = 0;
  let text = original.split(/\r?\n/).map(line => {
    if (/^\s*Define\s+SRVROOT\b/i.test(line)) return `Define SRVROOT "${apache.root.replace(/\\/g, '/')}"`;
    const include = line.match(/^(\s*Include(?:Optional)?\s+)(.+?)\s*$/i);
    if (!include || /^\s*#/.test(line)) return line;
    let includePath = include[2].trim().replace(/^['"]|['"]$/g, '');
    const extra = includePath.match(/[/\\]conf[/\\]extra[/\\]([^/\\]+)$/i);
    if (!extra) return line;
    const own = path.join(runtimeExtra, extra[1]);
    if (!fs.existsSync(own)) return line;
    const next = own.replace(/\\/g, '/');
    if (next === includePath) return line;
    rewritten++;
    return `${include[1]}"${next}"`;
  }).join('\r\n');

  // 4. Regras de bloqueio do conteúdo de gerenciador.
  const denyRules = apacheDenyRules(APP_ROOT);
  const DENY_MARKER = '# XAMPP STUDIO: BLOQUEIO DO GERENCIADOR';
  if (!text.includes(DENY_MARKER)) {
    text = `${text.trimEnd()}\r\n\r\n${DENY_MARKER}\r\n${denyRules}\r\n`;
    log('Regras de bloqueio do gerenciador acrescentadas.');
  } else {
    log('Regras de bloqueio do gerenciador já presentes.');
  }

  const remaining = text.split(/\r?\n/).filter(line => /^\s*Include/i.test(line) && /xampp|[\\/]apache[\\/]conf/i.test(line));
  if (remaining.length) {
    log(`Includes ainda apontando para o XAMPP:\n  ${remaining.join('\n  ')}`);
  } else {
    log(`Includes atualizados: ${rewritten} apontam agora para o conf/extra do runtime.`);
  }

  try {
    writeAtomically(config, text);
    const check = await execFileAsync(apache.executable, ['-t', '-d', apache.root, '-f', apache.config], { cwd: apache.root, timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 });
    if (!/Syntax OK/i.test(`${check.stdout}\n${check.stderr}`)) throw new Error('A configuração não passou na validação (httpd -t).');

    if (serviceState(SERVICE_NAME) === 4) {
      await execFileAsync('sc.exe', ['stop', SERVICE_NAME], { timeout: 30000, windowsHide: true });
      await waitForService(SERVICE_NAME, 1, 40000);
    }
    await startService(SERVICE_NAME);

    const port = apachePrimaryPort(readText(config));
    log(`Apache desacoplado. Porta em uso: ${port}`);
    log(`DocumentRoot/ServerRoot agora resolvem dentro de: ${apache.root}`);
  } catch (error) {
    writeAtomically(config, original);
    log(`Falhou: ${error.message}`);
    log('Configuração restaurada.');
    if (serviceState(SERVICE_NAME) === 1) await startService(SERVICE_NAME).catch(() => {});
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
