# Política de segurança

## Escopo

O XAMPP Studio é um agente **local**: escuta apenas em `127.0.0.1`, gerencia
serviços do Windows (Apache, PHP, MySQL/MariaDB) e escreve arquivos de
configuração na máquina onde é executado. Ele não expõe portas públicas por
si só.

Superfícies que tratamos com cuidado especial:

- A API local valida o header `Origin` para impedir que páginas arbitrárias
  no navegador invoquem ações do Studio (CSRF/DNS rebinding), além de
  confirmar o `Host` em todas as requisições.
- Ações de janela (Shell, Explorer, Config, Logs, Admin) usam allowlist de
  destinos — o cliente envia o nome da ação e o componente, nunca caminhos.
- Endpoints que repassam comandos ao helper elevado (UAC) aceitam apenas os
  nomes de serviço gerenciados (`Apache2.4`, `mysql`, `XAMPPStudio-Apache`,
  `XAMPPStudio-MySQL`), nunca um nome arbitrário.
- Escritas de arquivo são limitadas às pastas gerenciadas.
- Downloads de runtimes são validados por checksum publicado pela fonte
  oficial antes da extração, e a extração recusa caminhos absolutos e `..`
  (zip-slip).
- Credenciais geradas de banco ficam em `workspace/mysql/credentials/`,
  que está fora do controle de versão (`.gitignore`) e bloqueada pela
  configuração do Apache gerada pelo Studio; nunca são incluídas em logs
  ou diagnósticos. A senha não circula em linha de comando: clientes do
  MySQL/MariaDB a recebem por variável de ambiente (`MYSQL_PWD`).

## Âncoras de confiança da cadeia de suprimentos

- **PHP (windows.php.net)**: SHA-256 oficial, conferido antes da extração.
- **Apache Lounge**: SHA-256 publicado pelo fornecedor. O checksum vem do
  mesmo servidor do binário — a âncora real é TLS + o domínio oficial.
- **MariaDB**: SHA-256 do archive oficial. **MySQL Community**: a Oracle
  publica apenas MD5, tratado como detecção de corrupção acidental, não
  como proteção criptográfica; a assinatura GPG listada no catálogo ainda
  não é verificada automaticamente.
- **PECL**: o download usa TLS para downloads.php.net e valida o build por
  versão/TS/compilador/arquitetura; os builds publicados não têm checksum
  próprio na fonte.
- Dados vindos de catálogos externos (Packagist, PECL) são renderizados na
  interface com escape de HTML e esquema de URL restrito a http(s).

## Como reportar uma vulnerabilidade

**Não abra issue pública para vulnerabilidades.**

Use o recurso privado "Report a vulnerability" da aba *Security* do
repositório no GitHub. Se não estiver disponível, abra uma issue genérica
sem detalhes pedindo um canal privado.

Inclua:

- Descrição do problema e impacto esperado.
- Passos ou prova de conceito.
- Versões afetadas (Windows, Node.js, Studio).

Responderemos o mais rápido possível e creditaremos reportes responsáveis
quando desejar.

## O que NÃO é vulnerabilidade no contexto desta ferramenta

- Executar comandos/elevar privilégios **quando o usuário confirma** a ação
  na interface e o aviso UAC do Windows é exibido — esse é o propósito da
  ferramenta com consentimento explícito.
- O agente aceitar conexões apenas de loopback; ele nunca deve escutar em
  interfaces externas. Se você encontrar um caminho para escutar fora do
  loopback, isso é um problema real — reporte.
