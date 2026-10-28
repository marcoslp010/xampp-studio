'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/**
 * Diagnóstico exportável do ambiente local.
 *
 * Junta em um único arquivo as evidências que respondem "por que o site
 * quebrou?": versões em uso, hashes dos executáveis, configuração efetiva do
 * Apache, diretivas do php.ini, serviço do Windows (incluindo o ImagePath),
 * donos das portas, compatibilidade PHP×Apache, certificado TLS, últimas
 * operações e o fim do log de erros do Apache.
 *
 * Nada é alterado: o relatório é gerado apenas com leitura.
 */

function sha256File(file) {
  try {
    const hash = createHash('sha256');
    hash.update(fs.readFileSync(file));
    return hash.digest('hex');
  } catch { return null; }
}

function fileInfo(file) {
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    return { path: file, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: sha256File(file) };
  } catch { return { path: file, missing: true }; }
}

function tailFile(file, lines = 40, maxBytes = 256 * 1024) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const start = Math.max(0, size - Math.max(1024, Number(maxBytes) || 0));
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const chunk = fs.readSync(handle, buffer, read, buffer.length - read, start + read);
      if (!chunk) break;
      read += chunk;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Number(lines) || 40));
  } catch { return []; }
  finally { if (handle !== undefined) try { fs.closeSync(handle); } catch {} }
}

function markdownCell(value) {
  return String(value ?? '—').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function fenceLine(value) {
  return String(value ?? '').replace(/```/g, '``\u200B`');
}

/** Diretivas do php.ini que ajudam a explicar diferenças de ambiente. */
function phpIniHighlights(contents) {
  const interesting = [
    'extension_dir', 'memory_limit', 'max_execution_time', 'post_max_size', 'upload_max_filesize',
    'date.timezone', 'error_log', 'log_errors', 'display_errors', 'opcache.enable', 'opcache.memory_consumption',
    'default_socket_timeout', 'mysqli.default_socket', 'pdo_mysql.default_socket', 'openssl.cafile', 'openssl.capath'
  ];
  const lines = String(contents || '').split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    if (/^\s*[;#]/.test(line)) continue;
    const match = line.match(/^\s*([a-z0-9_.]+)\s*=\s*(.*?)\s*$/i);
    if (!match) continue;
    if (!interesting.includes(match[1].toLowerCase())) continue;
    values[match[1]] = match[2].replace(/\s*[;#].*$/, '').trim();
  }
  return values;
}

/** Diretivas efetivas do Apache que definem o carregamento do PHP. */
function apacheDirectives(files) {
  const wanted = ['ServerRoot', 'DocumentRoot', 'Listen', 'LoadModule', 'LoadFile', 'SetEnv', 'ErrorLog', 'CustomLog', 'SSLCertificateFile', 'SSLCertificateKeyFile'];
  const result = [];
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const match = line.match(/^\s*([A-Za-z]+)\s+(.*)$/);
      if (!match || !wanted.includes(match[1])) continue;
      result.push({ file, directive: match[1], value: match[2].trim() });
    }
  }
  return result;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

/** Relatório em Markdown, pronto para colar num chamado ou commit. */
function renderDiagnosticsMarkdown(report) {
  const lines = [];
  const push = (value = '') => lines.push(value);
  push('# Diagnóstico do XAMPP Studio');
  push();
  push(`- Gerado em: ${report.generatedAt}`);
  push(`- Agente: ${report.studio.node} em ${report.studio.platform} · porta ${report.studio.port} · ${report.studio.windowsAdmin ? 'administrador' : 'usuário comum'}`);
  push(`- Modo: ${report.environment.mode} · raiz do XAMPP: ${report.environment.xamppRoot}`);
  push();
  push('## Componentes');
  push();
  push('| Componente | Versão | Executável | SHA-256 | Estado |');
  push('|---|---|---|---|---|');
  for (const [name, item] of Object.entries(report.components)) {
    push(`| ${markdownCell(name)} | ${markdownCell(item.version || '—')} | ${markdownCell(item.executable ? `\`${item.executable}\`` : '—')} | ${item.sha256 ? item.sha256.slice(0, 16) + '…' : '—'} | ${item.running ? 'em execução' : 'parado'} |`);
  }
  push();
  push('## Serviços do Windows');
  push();
  push('| Serviço | Estado | Comando (ImagePath) |');
  push('|---|---|---|');
  for (const service of report.services) {
    push(`| ${markdownCell(service.serviceName)} | ${markdownCell(service.stateLabel || service.state)} | ${markdownCell(service.imagePath ? `\`${service.imagePath}\`` : '—')} |`);
  }
  push();
  push('## Portas');
  push();
  for (const [port, owner] of Object.entries(report.ports)) {
    push(`- **${markdownCell(port)}**: ${markdownCell(owner.active ? (owner.summary || 'em uso') : 'livre')}${owner.managed ? ' (gerenciado pelo Studio)' : ''}`);
  }
  push();
  push('## Compatibilidade PHP × Apache');
  push();
  for (const item of report.compatibility) {
    push(`- PHP ${markdownCell(item.version)}: ${item.compatible ? 'compatível' : `**incompatível** — ${markdownCell(item.summary || 'conflitos de símbolos')}`}`);
    for (const conflict of item.conflicts || []) {
      push(`  - ${markdownCell(conflict.extension)} precisa de ${markdownCell((conflict.missing || []).join(', '))} em ${markdownCell(conflict.dll)}`);
    }
  }
  push();
  if (report.certificate) {
    push('## Certificado TLS do runtime');
    push();
    push(`- Chave: ${markdownCell(report.certificate.bits || '—')} bits · ${markdownCell(report.certificate.subject || '—')}`);
    push(`- Válido até: ${markdownCell(report.certificate.notAfter || '—')}`);
    push();
  }
  push('## Diretivas relevantes do php.ini');
  push();
  push('```ini');
  for (const [key, value] of Object.entries(report.phpIniHighlights || {})) push(`${key} = ${fenceLine(value)}`);
  push('```');
  push();
  push('## Últimas operações');
  push();
  if (!report.jobs.length) push('- Nenhuma operação registrada.');
  for (const job of report.jobs) {
    push(`- **${markdownCell(job.type)}** · ${markdownCell(job.status)} · ${markdownCell(job.createdAt)}${job.error ? ` · ${markdownCell(job.error)}` : ''}`);
  }
  push();
  push('## Fim do log de erros do Apache');
  push();
  push('```');
  for (const line of report.logs.apacheError) push(fenceLine(line));
  push('```');
  push();
  push('## Fim do log de erros do MySQL/MariaDB');
  push();
  push('```');
  for (const line of report.logs.mysqlError) push(fenceLine(line));
  push('```');
  push();
  return lines.join('\r\n');
}

module.exports = {
  apacheDirectives,
  fileInfo,
  formatBytes,
  phpIniHighlights,
  renderDiagnosticsMarkdown,
  sha256File,
  tailFile
};
