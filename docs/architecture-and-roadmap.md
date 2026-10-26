# Análise orientada por evidências e próximos passos

## 1. Como o REA foi usado

O [morluto/rea](https://github.com/morluto/rea) não é um gerenciador XAMPP. É um agente/MCP de engenharia reversa que preserva observações, hipóteses, contradições e próximos testes. Ele foi usado como **método de investigação**, não como dependência de runtime.

A análise local combinou:

1. inventário do projeto `new-xampper`;
2. leitura das configurações e do código do agente local;
3. `rea inspect-artifact` e `rea inspect-managed-artifact` sobre os binários instalados;
4. execução controlada dos próprios binários para identificar versão e compatibilidade;
5. testes de catálogo, checksum, extração, inicialização e rollback.

Fontes oficiais usadas para os catálogos:

- PHP para Windows: <https://windows.php.net/downloads/releases/releases.json>
- PECL para Windows: <https://downloads.php.net/~windows/pecl/releases/>
- Apache Lounge: <https://www.apachelounge.com/download/>
- MySQL Community Archives: <https://downloads.mysql.com/archives/community/>
- MariaDB Archive: <https://archive.mariadb.org/>

## 2. Evidências REA da instalação local

| Componente | Formato / arquitetura | SHA-256 observado | Evidência REA |
|---|---|---|---|
| `C:\xampp\apache\bin\httpd.exe` | PE32+ / x86_64 | `7bd994ae100f079c7c2e36414ec40c059b38d440f0c48e89c0946896c8b0aeea` | `ev_d69da3d934b5afb325fb58a42411942182b3eb9410b793b568dcd08faa0275c4` |
| `C:\xampp\mysql\bin\mysqld.exe` | PE32+ / x86_64 | `ee6380db7277e0a4ebe0ff255edd846eb3b4ee604804cf5db3bdde1be44b7e8a` | `ev_824232a4d853069623cc7f5d2e54667c926afac71cebb1c886b1fbe6535387a8` |
| `C:\xampp\php\php.exe` | PE32+ / x86_64 | `4043721b2d6a3d0e68d13b3daeab0a2c842b9e054ec4098b80e1aeab6a8456f3` | `ev_aa40ce910968becf49906a9c17c0de6da526f61b5f60233ce703bcbd85edbf88` |

Observações confirmadas pelo próprio ambiente:

- Apache `2.4.58`;
- PHP `8.2.12` Thread Safe, x64;
- MariaDB `10.4.32` (o executável se identifica como MariaDB);
- Apache e MariaDB usam serviços Windows `Apache2.4` e `mysql` quando migrados pelo XAMPP;
- o PHP ativo depende de `php8apache2_4.dll`, `php8ts.dll` e do conjunto de DLLs registradas no `php.ini`.

## 3. Acoplamentos encontrados antes da evolução

1. `server.cjs` usava `XAMPP_ROOT` como fonte implícita de executáveis, `php.ini`, `httpd-xampp.conf` e `my.ini`.
2. `properties.ini` era consultado para encontrar `php_binary_directory` e `base_stack_version`.
3. A troca de PHP reescrevia o `httpd-xampp.conf` do XAMPP e atualizava o `properties.ini`.
4. O status do banco não expunha claramente produto, versão, origem e dados usados.
5. O catálogo MySQL/MariaDB não existia.
6. O fluxo PECL apenas exibia links; download, extração, cópia e configuração exigiam passos manuais.
7. Downloads longos ocupavam a mesma requisição HTTP e não tinham estado persistente.

## 4. Arquitetura aplicada

### Fonte de verdade e modos

- `environment-state.json` guarda as raízes ativas de PHP, Apache e MySQL/MariaDB.
- `runtimeMode()` diferencia `legacy` e `standalone`.
- No modo independente, a configuração Apache é gerada em `xampp-studio-httpd.conf`, o `DocumentRoot` fica em `workspace/htdocs` e os serviços próprios são `XAMPPStudio-Apache` e `XAMPPStudio-MySQL`.
- No modo legado, `properties.ini`, `httpd-xampp.conf`, `Apache2.4` e `mysql` continuam aceitos para migração.

### Módulos de runtime

- **PHP**: catálogo oficial, DLLs registradas, ativação com backup e rollback.
- **Apache**: catálogo Apache Lounge, download assíncrono, SHA-256, extração isolada, `httpd -t` e ativação independente.
- **MySQL / MariaDB**: catálogo oficial duplo, checksum, `my.ini` próprio, dados isolados, senha aleatória e troca reversível do serviço.

### Jobs assíncronos

`lib/jobs.cjs` mantém fila, estados, passos, progresso e resultado em `jobs/job-state.json`. O servidor responde `202` ao criar a operação e a interface acompanha `GET /api/jobs/:id` por polling.

Fluxo PECL validado ponta a ponta:

```text
pesquisar PECL
  → selecionar ZIP compatível (PHP/TS/NTS/compilador/x64)
  → baixar em staging
  → calcular SHA-256
  → validar caminhos do ZIP
  → extrair
  → validar PE da DLL
  → backup do php.ini/DLL
  → copiar para ext/ e atualizar php.ini
  → iniciar php.exe -m
  → confirmar o módulo ou reverter
```

Teste real executado no runtime isolado `PHP 8.5.12 TS x64`:

- pacote: `php_redis-6.3.0-8.5-ts-vs17-x64.zip`;
- origem: `downloads.php.net/~windows/pecl/releases/redis/6.3.0/`;
- resultado: `redis` carregado e `php.ini` validado.

Teste real do módulo de banco:

- `MariaDB 13.1.1 Win64`;
- ZIP oficial de 99,9 MB;
- SHA-256 oficial conferido;
- dados inicializados em diretório próprio;
- senha aleatória de 32 caracteres gravada em arquivo local protegido.

## 5. Integração real dos serviços Windows

A integração foi validada no próprio Windows local:

- `Apache2.4` registrado com `C:\xampp\apache\bin\httpd.exe`, validado por `httpd -t` e iniciado pelo Service Control Manager;
- `mysql` registrado com `C:\xampp\mysql\bin\mysqld.exe --defaults-file=...\my.ini`;
- ambos os serviços Alcançaram o estado `RUNNING`;
- Apache respondeu HTTP 200 na porta 80;
- MariaDB `10.4.32` executou `SELECT VERSION()` pela porta 3306;
- parar/iniciar o MySQL foi repetido sem novo UAC depois da permissão local de consulta/início/parada.

Dois problemas reais encontrados durante a validação foram corrigidos:

1. `httpd -t` escreve `Syntax OK` em stderr; no Windows PowerShell, `$ErrorActionPreference='Stop'` transformava essa saída válida em exceção. O helper agora captura stdout/stderr sem interromper a operação.
2. o `sc.exe` em português usa um rótulo codificado em OEM para o caminho binário. O parser deixou de depender do texto traduzido e identifica a linha pelo token `BIN`.

Quando o agente não está elevado, `scripts/windows-service-helper.ps1` é iniciado por `Start-Process -Verb RunAs`. O resultado é persistido em um arquivo JSON para que o agente parental possa confirmar a operação, inclusive quando o UAC é cancelado. A identificação de portas agora resolve o PID e o executável proprietário: Docker/WSL não são mais confundidos com uma instância antiga do XAMPP.

### Paridade com o XAMPP Control Panel

O painel clássico do XAMPP expõe, por componente, os botões Start/Stop, Config, Logs, Netstat, Shell e Admin, além de Explorer e Refresh globais. O Studio reproduz esse conjunto:

- **Start/Stop/Restart** operam o serviço do Windows; `Parar` exige confirmação na interface e nunca apaga dados;
- **Config** abre `httpd.conf`, `my.ini` ou `php.ini` no editor padrão;
- **Logs** abre a pasta de logs do componente;
- **Shell** abre um prompt na pasta do componente (`start "XAMPP Studio Shell" /D <raiz> cmd.exe /k`);
- **Admin** abre `http://localhost/` ou `http://localhost/phpmyadmin/`;
- **Netstat** é uma leitura real: `netstat -ano` é cruzado com `Win32_Process` e `Win32_Service`, e as linhas do Apache/MySQL do Studio recebem selo próprio;
- **Explorer** abre a raiz configurada do XAMPP.

Por segurança, `POST /api/xampp/action` aceita apenas uma allowlist de ações (`shell`, `explorer`, `logs`, `config`, `admin`) e um componente (`apache`, `mysql`, `php`); o destino é resolvido no servidor e validado contra as raízes permitidas. O navegador nunca envia um caminho arbitrário.

## 5.1 Compatibilidade real entre PHP e Apache no Windows

A troca de PHP para 8.5.12 expôs uma incompatibilidade que nenhum `php.ini` resolve: `curl_init()` desapareceu do contexto web mesmo com `extension=curl` presente e correto.

**Causa.** O Windows resolve DLLs pelo nome do arquivo dentro do processo. O Apache carrega `libssl-3-x64.dll`/`libcrypto-3-x64.dll` por causa do `mod_ssl`; quando a extensão `curl` do PHP 8.5.12 é carregada, ela passa a usar a cópia do Apache (OpenSSL 3.1.3, do Apache 2.4.58). O PHP 8.5.12 exige OpenSSL ≥ 3.2 e falha ao resolver `SSL_get0_group_name`, com o erro “Não foi possível encontrar o procedimento especificado” (127). O `php.exe` da linha de comando funcionava porque está na raiz do runtime e não divide processo com o Apache.

**Evidência.** A leitura das tabelas PE de importação e exportação (`lib/pe-imports.cjs`) mostrou que `curl.dll` importa `SSL_get0_group_name`, ausente nas exportações de `libcrypto-3-x64.dll` do Apache 2.4.58, presente na do Apache 2.4.69 (OpenSSL 3.5.9).

**Regras aplicadas pelo agente.**

1. `phpRuntimeApacheConflicts()` cruza as importações de cada extensão habilitada com as exportações das DLLs que o Apache carrega no boot (`apacheStartupLibraries()`, resolvendo `Include`/`IncludeOptional` recursivamente). Um conflito bloqueia a troca, com o símbolo faltante nomeado, e aparece na interface antes da confirmação.
2. `phpRuntimeDependencyDlls()` declara com `LoadFile` apenas as DLLs que o Apache **não** carrega (brotli, libssh2, nghttp2). Carregar uma segunda cópia de uma DLL já presente quebra o Apache — o `LoadFile` usa `LOAD_WITH_ALTERED_SEARCH_PATH` e o Windows resolve pelo nome base.
3. O runtime isolado recebe certificado próprio de 2048 bits (`openssl.exe` do próprio build): o certificado do XAMPP tem RSA de 1024 bits e SHA1, recusado pelo OpenSSL 3.5 (`ee key too small`), o que fazia o serviço subir e cair em seguida.
4. Depois do reinício, `apacheExtensionLoadFailures()` compara o `error.log` com o tamanho anterior e reverte a troca quando alguma extensão não carregou.

**Serviço.** O `ImagePath` do serviço não aceita espaço inicial (`StartService FALHA 87`) e a escrita direta no registro não notifica o SCM, que continua usando o comando antigo. A reescrita usa `sc.exe config <serviço> binPath=<comando>` (sem espaço entre `=` e o valor), confere o valor gravado e, em caso de divergência, grava no registro e notifica o SCM. O endpoint `POST /api/services/repair` reaplica esse caminho sob demanda, e a troca de runtime passa a reescrever o comando **antes** de parar o Apache — se o UAC for recusado, o site continua no ar.

**Estado validado.** PHP 8.5.12 (TS x64) com Apache 2.4.69 (OpenSSL 3.5.9) no modo legado: `curl=1`, `openssl=1`, `mbstring=1` no contexto web, `http://localhost/local.php` respondendo 200 e o log do Apache registrando `Apache/2.4.69 (Win64) OpenSSL/3.5.9 PHP/8.5.12`.

## 5.2 Organização do código e diagnóstico

A lógica que decide compatibilidade, reescreve a configuração e monta o comando do serviço saiu do `server.cjs` para módulos exigidos e testáveis:

- `lib/php-compat.cjs` — tabelas de config do Apache (com `Include` resolvido pelo `ServerRoot`, como o Apache faz), DLLs carregadas no arranque, conflitos de símbolos, DLLs que exigem `LoadFile`, reescrita do `httpd-xampp.conf` e leitura das falhas do `error.log`;
- `lib/apache-config.cjs` — leitura da porta real (`Listen`), reescrita de `Listen`/`ServerName` e extração do `ServerName`;
- `lib/service-command.cjs` — normalização do `ImagePath` (aspas no executável, rejeição do espaço inicial, comparação estrita);
- `lib/diagnostics.cjs` — coleta e renderização em Markdown do diagnóstico do ambiente;
- `lib/pe-imports.cjs` — leitura das tabelas PE de importação e exportação.

`tests/run-tests.cjs` roda 19 verificações sem alterar o ambiente: leitura PE, conflito real entre PHP 8.5.12 e o OpenSSL 3.1.3 do Apache 2.4.58, ausência de conflito com o Apache 2.4.69, a trava que impede a reescrita de `C:/xampp/php` dentro de `C:/xampp/phpMyAdmin`, a lista de `LoadFile` sem repetir DLL do Apache, a leitura de falhas do log, as regras do comando do serviço e a leitura/reescrita da porta do Apache.

O diagnóstico exportável (`GET /api/diagnostics` e `GET /api/diagnostics/export`, botão **◫** na barra superior) junta versões, hashes, serviço com o `ImagePath`, donos das portas, matriz de compatibilidade, certificado TLS, diretivas do `php.ini`, últimas operações e o fim dos logs. Foi ele que revelou o `error_log` e o `openssl.cafile` ainda apontando para o XAMPP antigo — corrigido em `alignPhpIniPaths()` e aplicado ao runtime em uso.

## 5.3 Interface e organização do frontend

O design foi refeito como um sistema, não como uma sequência de ajustes: `styles.css` passou a ter tokens (cor, raio, sombra, movimento, tipografia), base, layout, componentes, estados e responsivo, com nomes de classe estáveis usados pelo markup e pelo JavaScript. A visão geral virou uma grade bento (PHP em 2×2, serviços e extensões empilhados, banco na linha inteira), os estados de carregamento usam skeletons com brilho, e as interações ganharam foco visível, `aria-current`, `aria-live`, toast com saída animada, modal que move o foco para a primeira ação e atalhos de teclado (`1`–`6`, `R`, `D`, `?`).

O `app.js` monolítico (131 KB) foi quebrado em módulos ES: `js/core.js` (estado, armazenamento local, toasts, modal, skeletons, botão pendente), `js/api.js` (acesso ao agente local em um único ponto) e `js/app.js` (telas e renderizações). O servidor passou a servir esses módulos explicitamente.

## 5.4 Porta do Apache como configuração, não constante

A porta 80 estava fixa em três lugares do servidor e em um rótulo da interface, o que produzia uma leitura errada: com o Docker ocupando a 80, o Studio mostrava “porta respondendo” mesmo com o serviço do Apache parado. Agora:

- `componentPort('apache')` lê a diretiva `Listen` do `httpd` em uso (o MySQL continua na 3306, lida do `my.ini`);
- `scanStatus` e `collectDiagnostics` usam essa porta e separam três estados que antes pareciam um só: serviço em execução, serviço parado e **porta ocupada por um processo que não é do Studio**;
- `POST /api/apache/port` migra o runtime: valida a porta (1024–65535), recusa porta em uso, copia o `httpd.conf`, reescreve `Listen` e `ServerName`, roda `httpd -t`, reinicia o serviço, exige resposta na porta nova e, em qualquer falha, restaura o arquivo anterior e reinicia o Apache na configuração anterior;
- `scripts/change-apache-port.cjs` executa a mesma migração pela linha de comando, sem elevação (o DACL do serviço já permite `sc start/stop`).

O botão **Mudar porta** na página de Serviços abre a confirmação com a porta atual, e o botão **Abrir site** usa a porta real. No ambiente local a migração foi aplicada: o Apache saiu de 80 para 8088 porque o Docker/WSL ocupa a 80 e o `::1:8080` (IPv6), e o site responde em `http://localhost:8088`.

O `start.ps1` também passou a liberar a porta 43197 antes de subir, e o Studio ganhou `POST /api/studio/restart` e o botão **⭯**: o servidor recarrega sozinho, sem depender de alguém aceitar um UAC manual.

## 6. Melhorias priorizadas

### P0 — próximo ciclo

1. **Dividir `server.cjs`** *(primeira etapa concluída)*: `runtime-state`, `services`, `php-compat`, `service-command`, `diagnostics`, `pe-imports`, `jobs` e `database-catalog` já saíram para `lib/`. Falta separar `catalogs`, `php`, `apache`, `mysql` e `safety`.
2. **Migração assistida do XAMPP**: botão explícito para copiar/importar `htdocs`, `my.ini`, bancos e permissões para `workspace/`, com pré-visualização e rollback.
3. **Assinaturas GPG**: validar as assinaturas `.asc`/GPG do MySQL e do MariaDB, não apenas MD5/SHA-256.
4. **Migração de dados entre MySQL/MariaDB**: `mysqldump`, restauração em staging, `mysql_upgrade` e validação de esquema antes de uma troca de série maior.
5. **Política de serviço**: instalar sempre os serviços `XAMPPStudio-*`, manter os legados apenas como fallback e oferecer migração sem interromper portas.
6. **Porta alternativa quando a 80 está ocupada** *(concluído)*: a porta do Apache é lida da configuração, a migração para outra porta acontece com backup, validação e reversão automática, e o painel distingue serviço parado de porta ocupada por terceiros.

### P1 — robustez

1. Downloads retomáveis com `Range` e verificação parcial.
2. Cancelamento de jobs e limite de operações simultâneas.
3. Testes automatizados *(parcial)*: a compatibilidade PHP×Apache, a reescrita de configuração, o comando do serviço e a porta do Apache já têm cobertura em `tests/run-tests.cjs`; falta extração segura de pacotes e decisão de compatibilidade PECL.
4. Diagnóstico exportável *(concluído)*: configuração efetiva, hashes, versões, portas, serviço, certificado, diretivas do `php.ini` e journal das operações em Markdown.
5. Verificação de antivírus/SmartScreen e confirmação visual dos pacotes por assinatura quando a fonte oferecer.

### P2 — produto

1. Perfis de ambiente (site local, APIs, replicação e email local).
2. Exportação/importação de configuração do Studio.
3. PHP-FPM, Perl, phpMyAdmin e Mailpit como módulos opcionais.
4. Painel de dependências entre PHP, Apache e extensões, com matriz TS/NTS/VC.
5. Relatório de diferenças entre duas versões antes da ativação.

## 7. Limitações conhecidas

- O Apache para Windows continua vindo do Apache Lounge, fonte terceira indicada pelo projeto Apache.
- O catálogo oficial do MySQL publica MD5; a assinatura GPG oficial está disponível, mas ainda não é validada automaticamente.
- A troca do banco usa diretórios separados; não há migração automática de dados entre versões maiores.
- A integração com serviços Windows exige privilégio administrativo quando o agente não foi iniciado como administrador.
- O REA fornece evidência estruturada, não magia: uma hipótese continua sendo hipótese até ser reproduzida por uma execução ou observação local.
