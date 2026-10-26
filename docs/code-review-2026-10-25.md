# Revisão de código pré-release — 25/10/2026

Três revisões independentes (backend `server.cjs`, `lib/`+`scripts/`, frontend)
varreram o projeto antes da publicação no GitHub. Este documento condensa o
que **já foi corrigido** e o que **permanece em aberto**, priorizado para as
próximas versões. Números de linha referem-se aos arquivos na data da revisão.

## Corrigido nesta revisão

- `apacheDenyRules` nega `workspace/`, `logs/` e `downloads/` (+ estados da
  raiz no `FilesMatch`), com re-liberação do documentRoot interno — a senha
  root do MySQL vivia em pasta potencialmente servível por HTTP.
- Parser PE tolerante a DLL truncada (`null` em vez de `RangeError`).
- Troca de Apache no modo standalone recebia `executable` `undefined` e
  sempre falhava; agora usa a convenção `bin/httpd.exe` do runtime.
- `/api/services/start-type` com allowlist de nomes de serviço (o endpoint
  repassa ao helper elevado UAC).
- `trustedLocalRequest`: `Host: [::1]` e `Origin` sem porta (porta 80).
- `/api/studio/restart`: handler de `error` no spawn.
- `migrate-mysql-data.cjs`: shutdown administrativo antes do kill; senha via
  `MYSQL_PWD`, fora da linha de comando.
- Scripts standalone usam `serviceNameFor('apache')` em vez de
  `'Apache2.4'` fixo.
- Frontend: escapes faltantes (`detail`, `catalog.source`, `min`/`max`) e
  `safeUrl` restringindo `href` de catálogos externos a http(s).
- `.gitignore` blindando dados sensíveis; `LICENSE` MIT, `CONTRIBUTING.md`,
  `SECURITY.md`, CI no GitHub Actions, `package.json` com metadados.
- Suíte: 23 testes de regras + 8 do catálogo de extensões + destinos Admin +
  segurança do `start.ps1`, todos no verde; CI roda tudo em `windows-latest`.

## P1 — antes de considerar 1.0

1. **Serializar mutações de estado.** `firewall-state.json` sofre *lost-update*
   entre `block`/`unblock`/Cloudflare concorrentes → regras de firewall órfãs
   (impossíveis de remover pela UI). Instalação concorrente do mesmo release do
   banco pode **apagar o runtime recém-instalado** pelo outro fluxo no
   `rmSync(targetRoot)` do `catch`. Solução: fila de Promises (mutex em
   memória) por arquivo de estado + flag `ownCreated` antes de remover.
2. **Allowlist e validação de raízes no helper elevado** (`scripts/
   windows-service-helper.ps1`) e validação de `apache.root`/`mysql.root` no
   `registerXamppService` (o `managedPhpRoot` cobre só PHP hoje). É a
   superfície mais sensível de um agente público com broker UAC.
3. **Cadeia de suprimentos**: exigir SHA-256 (ou verificar GPG via
   `signatureUrl`) no MySQL — o MD5 publicado é só detector de corrupção;
   gravar/verificar checksum no fluxo PECL (hoje só TLS); rejeitar
   symlink/junction e nomes de dispositivo (`CON`, `NUL`, `COM1-9`) na
   extração `tar`; fazer download em streaming com limite em vez de carregar
   até 700 MB em Buffer.
4. **Semântica HTTP**: classe `ApiError(status, message)` — hoje todo erro de
   validação vira 500; `if (res.headersSent) { res.destroy(); return; }` no
   catch; HEAD nos estáticos; 403 consumindo o corpo do request.
5. **Perímetro web para o público**: header custom (`X-XAMPP-Studio`) em todas
   as rotas `/api/*` — GETs hoje confiam só no `Host`, e sites visitados podem
   *disparar* trabalho pesado (netstat/diagnóstico) mesmo sem ler a resposta.

## P2 — qualidade e arquitetura

- **Duplicações divergentes** (congelam correções): `compareVersions`
  (`server.cjs` × `lib/database-catalog.cjs`), `serviceExecutableFromCommand`
  (`lib/services.cjs` × `lib/service-command.cjs`, regexes diferentes),
  `apacheServiceCommand` (idem), `readBoundedTail` × `tailFile`,
  `serviceState`/`waitForPort`/`startService` repetidos nos 4 scripts
  standalone, `writeAtomically` × `writeJsonAtomically`. Consolidar em `lib/`.
- **Dead code**: `formatBytes`, `serviceDirectoryFromCommand`,
  `mysqlServiceCommand` (burlado por string manual em 2 pontos),
  `openssl: version ? null : null`, tautologia `apacheShare + (100 -
  apacheShare) !== 100`.
- **Divisão do `server.cjs`** (ordem de baixo risco): engine de php.ini →
  `lib/php-ini.cjs`; backups → `lib/backup.cjs`; firewall + captura de corpo →
  `lib/firewall.cjs`; catálogos/downloads → `lib/runtime-downloads.cjs`;
  trocas de ambiente → `lib/environment-switch.cjs` (por último, atrás de
  testes); roteador declarativo deixando `server.cjs` como composition root.
- `lib/services.cjs` (636 linhas): extrair `lib/ports.cjs`.
- Tolerância a BOM nos parsers de `httpd.conf`/`php.ini`/`properties.ini`
  (`\uFEFF` não casa `^\s*`).
- `jobs.cjs`: allowlist de campos em `publicJob` (payload inteiro é exposto
  hoje) + debounce no `persist()` síncrono por `step`.
- `diagnostics.cjs`: escape de `|`/newline no Markdown; `tailFile` lê o log
  inteiro na memória (limitar por offset, como `php-compat.cjs`).
- Retenção de `backups/` (acumulam sem limite); cap LRU no cache de versões
  PECL; `analyzeSql` O(n²) em corpos com `/*` sem fechamento (limitar input);
  CSP no HTML; `canWrite` com `openSync('a')` em vez de `accessSync(W_OK)`;
  retry do `startWindowsServiceWithRetry` filtrando erro 1060 (serviço
  inexistente); limpeza de órfãos `<token>.*` em `jobs/service-helper/` no
  boot; `Get-ControlSddl` do helper concede ao SID do processo elevado (se o
  UAC responder com outra conta, o grant erra o alvo).
- Scripts `decouple-*.cjs`: descobrir runtimes por metadados em vez de nomes
  de pasta fixos; respeitar `XAMPP_ROOT`; `decouple-services.cjs` exige o
  Studio rodando (orquestra via HTTP) — documentar.
- `firewall.ps1`: restringir `block` a IPs públicos; tolerar
  `-DisabledRulesBase64` vazio.
- **Frontend** (revisão de UI): `monitorJob` roda polling infinito — cancelar
  ao fechar o modal, tratar retry transitório, TTL e prune de
  `state.activeJobs`; `saveVersions` nunca é chamado (persistência de
  versões morta) e a copy offline é enganosa; `js/api.js` sem
  timeout/`AbortController`; abas ARIA sem navegação por setas/tabpanel e
  sem skip-link (fazer um passe de axe); `showModal` aceita HTML bruto —
  manter a disciplina de escape nos callers ao dividir o `app.js`
  (toda divisão exige adicionar o novo `js/*` ao `STATIC_FILES`).

## P3 — cosmético

- Comentários PT-BR com trechos EN sem querer ("Repetir few segundos",
  "concludes a partida").
- User-agents de versão dispersos (`XAMPP-Studio/0.1`, `.../0.2`).
- Portas 3306/80 hardcode em ~10 pontos → constantes.
- `renamear` `database-catalog.cjs` → `db-releases.cjs` (catálogo de
  *releases*).

## Cobertura de testes que ainda falta

- Path traversal e allowlist de destinos (hoje só regras pontuais têm teste).
- `renderDiagnosticsMarkdown` (escape) e `writeAtomically`/`serviceNameFor`
  do `runtime-state.cjs` — funções puras, fáceis.
- Smoke de `firewall.ps1` com stubs (padrão `start-safety.ps1`).
- Fluxo de ativar standalone com Apache baixado (regressão do bug corrigido).
