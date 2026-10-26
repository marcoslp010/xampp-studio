'use strict';

// Pure planning and preflight rules, shared by the API and isolated tests.
const fs = require('node:fs');
const path = require('node:path');
const bounded = (value, min, max) => Math.max(min, Math.min(max, value));

function performanceLimits(apacheShare, ramBytes, logicalProcessors) {
  const ramMiB = Math.max(256, Math.floor(ramBytes / (1024 * 1024)));
  const cpus = Math.max(1, logicalProcessors);
  const serviceMemory = Math.floor(ramMiB * .8);
  const apacheMemory = Math.floor(serviceMemory * apacheShare / 100);
  const mysqlMemory = serviceMemory - apacheMemory;
  const threads = bounded(Math.round(cpus * 8 * (apacheShare / 50)), 8, 192);
  return {
    totalMemoryMiB: ramMiB, logicalProcessors: cpus, reservedPercent: 20,
    apacheShare, mysqlShare: 100 - apacheShare, apacheMemoryMiB: apacheMemory, mysqlMemoryMiB: mysqlMemory,
    apacheThreads: threads,
    phpMemoryMiB: bounded(Math.floor(Math.floor(apacheMemory / threads * .65) / 8) * 8, 16, 512),
    mysqlBufferPoolMiB: bounded(Math.floor(mysqlMemory * .5), 64, Math.max(64, Math.floor(ramMiB * .5))),
    mysqlConnections: bounded(Math.floor(mysqlMemory * .25 / 8), 10, 500)
  };
}

function performanceFileIssues({ environment, apache, mysql, phpRoot }, exists = fs.existsSync) {
  const required = [
    ['Executável Apache', apache.executable], ['Configuração Apache', apache.config],
    ['Executável PHP', path.join(phpRoot, 'php.exe')], ['Configuração PHP', path.join(phpRoot, 'php.ini')],
    ['Executável MySQL/MariaDB', mysql.executable], ['Configuração MySQL/MariaDB', mysql.config]
  ];
  const issues = [];
  for (const [label, key, relative] of [
    ['Apache', 'apacheRoot', ['bin', 'httpd.exe']], ['PHP', 'phpRoot', ['php.exe']], ['MySQL/MariaDB', 'mysqlRoot', ['bin', 'mysqld.exe']]
  ]) {
    if (environment[key] && !exists(path.join(environment[key], ...relative))) issues.push(`${label}: a versão selecionada não existe em ${environment[key]}. Corrija a seleção do ambiente antes de aplicar.`);
  }
  for (const [label, file] of required) if (!exists(file)) issues.push(`${label} não encontrado: ${file}`);
  return issues;
}

function performanceServiceIssues(services) {
  const issues = [];
  for (const [component, service] of Object.entries(services)) {
    const label = component === 'apache' ? 'Apache' : 'MySQL/MariaDB';
    if (service.registered !== false && !service.managed) issues.push(service.reason || `${label}: não foi possível confirmar o controle do serviço.`);
    else if (service.managed && ![1, 4].includes(service.state)) issues.push(`${label}: aguarde a transição do serviço no Windows antes de aplicar.`);
  }
  return issues;
}

function assertMySqlLimits(output, limits) {
  const read = key => Number(String(output).match(new RegExp(`^${key}\\s+(\\d+)\\s*$`, 'mi'))?.[1]);
  if (read('innodb-buffer-pool-size') !== limits.mysqlBufferPoolMiB * 1024 * 1024 || read('max-connections') !== limits.mysqlConnections) {
    throw new Error('O MySQL/MariaDB não carregou os limites esperados do arquivo selecionado.');
  }
}

module.exports = { performanceLimits, performanceFileIssues, performanceServiceIssues, assertMySqlLimits };
