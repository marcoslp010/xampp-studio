# Política de segurança

## Escopo

O XAMPP Studio é um agente **local**: escuta apenas em `127.0.0.1`, gerencia
serviços do Windows (Apache, PHP, MySQL/MariaDB) e escreve arquivos de
configuração na máquina onde é executado. Ele não expõe portas públicas por
si só.

Superfícies que tratamos com cuidado especial:

- A API local valida o header `Origin` para impedir que páginas arbitrárias
  no navegador invoquem ações do Studio (CSRF/DNS rebinding).
- Ações de janela (Shell, Explorer, Config, Logs, Admin) usam allowlist de
  destinos — o cliente envia o nome da ação e o componente, nunca caminhos.
- Escritas de arquivo são limitadas às pastas gerenciadas.
- Downloads de runtimes são validados por checksum (SHA-256/MD5) publicado
  pela fonte oficial antes da extração.
- Credenciais geradas de banco ficam em `workspace/mysql/credentials/`,
  que está fora do controle de versão (`.gitignore`), e nunca são incluídas
  em logs ou diagnósticos.

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
