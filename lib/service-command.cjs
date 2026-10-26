'use strict';

const path = require('node:path');

/**
 * Normalização do comando de inicialização dos serviços do Windows.
 *
 * Dois detalhes do SCM do Windows quebram a troca de runtime:
 *
 * 1. O `ImagePath` não aceita espaço inicial — `StartService FALHA 87`
 *    ("Parâmetro incorreto") quando o valor gravado começa com um espaço.
 * 2. Alterar o registro não notifica o SCM: o Windows continua usando o
 *    comando antigo e o serviço falha ao subir.
 *
 * Por isso o comando é normalizado (executável sempre entre aspas) e a
 * comparação é estrita, sem tolerar o espaço inicial.
 */

/** Normaliza para comparação: sem aspas, sem espaços duplicados, minúsculo. */
function normalizeServiceCommand(value) {
  return String(value || '').replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Garante que o executável do serviço esteja entre aspas. Sem isso, um
 * ImagePath como "C:\Program Files\...\httpd.exe -k runservice" é recusado
 * pelo SCM com "Parâmetro incorreto" (ERRO_INVALID_PARAMETER).
 */
function quoteServiceCommand(command) {
  const value = String(command || '').trim();
  if (!value || value.startsWith('"')) return value;
  const match = value.match(/^(.+?\.exe)\s*(.*)$/i);
  if (!match) return value;
  return `"${match[1]}" ${match[2]}`.trim();
}

/**
 * O SCM recusa ImagePath com espaço inicial, então o comando gravado precisa
 * ser exatamente o esperado — sem espaços sobrando na frente.
 */
function serviceCommandMatches(stored, expected) {
  if (!stored || !expected) return false;
  if (/^\s/.test(stored)) return false;
  return normalizeServiceCommand(stored) === normalizeServiceCommand(expected);
}

/** Caminho do executável configurado no comando do serviço. */
function serviceExecutableFromCommand(command) {
  const value = String(command || '').trim();
  const quoted = value.match(/^"([^"]+)"/);
  if (quoted) return quoted[1];
  const plain = value.match(/^(.+?\.exe)\b/i);
  return plain ? plain[1] : null;
}

/** Pasta do executável configurado no comando do serviço. */
function serviceDirectoryFromCommand(command) {
  const executable = serviceExecutableFromCommand(command);
  return executable ? path.dirname(executable) : null;
}

/** Comando completo de um serviço do Apache (executável + flags + config). */
function apacheServiceCommand(runtime, serviceName) {
  return `"${runtime.executable}" -k runservice -n "${serviceName}" -d "${runtime.root}" -f "${runtime.config}"`;
}

/** Comando completo de um serviço do MySQL/MariaDB. */
function mysqlServiceCommand(runtime) {
  return `"${runtime.executable}" --defaults-file="${runtime.config}"`;
}

module.exports = {
  apacheServiceCommand,
  mysqlServiceCommand,
  normalizeServiceCommand,
  quoteServiceCommand,
  serviceCommandMatches,
  serviceDirectoryFromCommand,
  serviceExecutableFromCommand
};
