'use strict';

/**
 * Leitura e reescrita das diretivas de rede do Apache.
 *
 * A porta do Apache não é fixa: quando outro programa (Docker, WSL, IIS)
 * ocupa a 80, o runtime pode passar a escutar em outra porta. These helpers
 * leem o valor real do httpd em uso e reescrevem o par Listen/ServerName de
 * forma consistente.
 */

/** Portas declaradas pela diretiva Listen (ignora comentários). */
function apacheListenPorts(contents) {
  const ports = [];
  for (const line of String(contents || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = line.match(/^\s*Listen\s+(?:[^\s:]*:)?(\d{2,5})\s*$/i);
    if (match) ports.push(Number(match[1]));
  }
  return ports;
}

/** A porta principal do Apache: a primeira declarada em Listen. */
function apachePrimaryPort(contents) {
  return apacheListenPorts(contents)[0] || 80;
}

/**
 * Troca a porta principal por outra, mantendo a forma do endereço original
 * (por exemplo, "Listen 0.0.0.0:80" continua com o host) e ajustando o
 * ServerName para que os links gerados usem a porta certa.
 */
function rewriteApacheListenPort(contents, nextPort) {
  const port = Number(nextPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Porta inválida: use um número entre 1 e 65535.');
  }
  let output = String(contents || '');
  let replaced = false;
  output = output.replace(/^([ \t]*Listen[ \t]+)([^\s:]*:)?(\d{2,5})[ \t]*$/im, (match, prefix, host = '', current) => {
    if (replaced) return match;
    replaced = true;
    return `${prefix}${host}${port}`;
  });
  if (!replaced) {
    output = `${output}\r\n\r\n# XAMPP Studio: porta do runtime\r\nListen ${port}\r\n`;
  }
  const previous = apachePrimaryPort(contents);
  if (previous && previous !== port) {
    output = output.replace(/^([ \t]*ServerName[ \t]+)([^\s:]+):(\d{2,5})([ \t]*)$/im, `$1$2:${port}$4`);
  }
  return output;
}

/** Extrai o par host:porta do ServerName (quando houver). */
function apacheServerName(contents) {
  for (const line of String(contents || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = line.match(/^\s*ServerName\s+(\S+)/i);
    if (match) return match[1];
  }
  return null;
}

/**
 * Diretivas <Directory> que negam acesso ao conteúdo de gerenciador.
 *
 * O Studio costuma morar dentro do DocumentRoot (por exemplo em
 * C:/xampp/htdocs/new-xampper). Sem estas regras, qualquer visitante
 * consegue baixar server.cjs, environment-state.json e o índice de backups/.
 * A pasta workspace/ concentra os dados sensíveis: credenciais do MySQL em
 * texto puro, o diretório de dados do banco e despejos SQL — por isso ela é
 * negada por padrão. Quando o documentRoot publicado vive DENTRO de uma
 * pasta negada (workspace/htdocs no modo independente, por exemplo), o
 * caminho liberado recebe um bloco <Directory> próprio: no Apache, o bloco
 * mais específico vence o genérico.
 * Só o conteúdo realmente publicado continua acessível.
 */
function apacheDenyRules(appRoot, allowedPaths = []) {
  const root = String(appRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) return '';
  const normalize = item => String(item).replace(/\\/g, '/').replace(/\/+$/, '');
  const allowed = new Set(allowedPaths.map(item => normalize(item).toLowerCase()));
  const inside = (parent, child) => {
    const value = normalize(child).toLowerCase();
    return value === parent || value.startsWith(`${parent}/`);
  };
  const denials = [
    'lib', 'scripts', 'tests', 'jobs', 'backups', 'runtimes', 'node_modules', '.git', '.playwright-cli',
    // workspace/ guarda credenciais do banco, data dir e despejos SQL;
    // logs/ e downloads/ carregam registros de requisições e pacotes.
    'workspace', 'logs', 'downloads'
  ].filter(name => !allowed.has(`${root}/${name}`.toLowerCase()));
  const files = [
    'server.cjs', 'environment-state.json', 'package.json', 'package-lock.json', 'start.ps1',
    'firewall.ps1', 'dll-registry.json', 'performance-state.json', 'firewall-state.json', 'request-body-log.php'
  ].filter(name => !allowed.has(`${root}/${name}`.toLowerCase()));
  const blocks = [];
  for (const name of [...denials, ...files]) {
    blocks.push(`<Directory "${root}/${name}">\n  Require all denied\n</Directory>`);
  }
  for (const allowedPath of allowedPaths) {
    const normalized = normalize(allowedPath);
    if (denials.some(name => inside(`${root}/${name}`.toLowerCase(), normalized))) {
      blocks.push(`<Directory "${normalized}">\n  Require all granted\n</Directory>`);
    }
  }
  blocks.push(`<Directory "${root}">\n  <FilesMatch "^(server\\.cjs|environment-state\\.json|package\\.json|package-lock\\.json|start\\.ps1|firewall\\.ps1|dll-registry\\.json|performance-state\\.json|firewall-state\\.json|request-body-log\\.php)$">\n    Require all denied\n  </FilesMatch>\n</Directory>`);
  return `# XAMPP STUDIO: BLOQUEIO DO GERENCIADOR\n${blocks.join('\n')}`;
}

module.exports = {
  apacheDenyRules,
  apacheListenPorts,
  apachePrimaryPort,
  apacheServerName,
  rewriteApacheListenPort
};
