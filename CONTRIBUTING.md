# Contribuindo com o XAMPP Studio

Obrigado pelo interesse! Este documento explica como montar o ambiente,
executar os testes e enviar mudanças com segurança.

## Requisitos

- Windows 10/11 (o projeto gerencia serviços do Windows)
- Node.js 20 ou mais recente
- PowerShell 5.1 ou mais recente (já incluído no Windows)
- Uma instalação do XAMPP (opcional — o Studio funciona em modo independente)

## Fluxo básico

1. Faça um fork e clone o repositório.
2. Instale as dependências de desenvolvimento (usadas apenas para compilar o CSS):

   ```powershell
   npm ci
   ```

3. Rode a suíte de testes antes de qualquer mudança e depois dela:

   ```powershell
   npm test
   ```

   Os testes usam binários locais quando existem e **nunca** instalam,
   iniciam ou param serviços reais do Windows.

## O que validar antes de abrir um PR

- `npm test` passa por completo (suíte principal, destinos Admin e segurança do `start.ps1`).
- Se você tocou em `src/styles.css` ou `src/tailwind.css`:
  rode `npm run build:css` e confirme que o `styles.css` gerado foi incluído no PR —
  o painel não depende de CDN, então o CSS compilado acompanha o repositório.
- Se você tocou em `js/app.js`, `js/core.js` ou `index.html`:
  descreva o que verificou manualmente (telas, atalhos, diálogos, responsividade).
- Mudanças que afetam troca de runtime, comando de serviço ou firewall precisam de
  um novo caso de teste em `tests/run-tests.cjs` sempre que possível.

## Regras de segurança (importantes)

O Studio executa comandos do Windows e escreve arquivos de configuração reais.

- Prefira `execFile`/`spawn` com array de argumentos; nunca interpole strings
  em `exec`/`execSync` com entrada de usuário.
- Toda escrita de arquivo precisa validar que o destino está dentro das pastas
  gerenciadas (`XAMPP_ROOT`, `APP_ROOT` ou `APP_ROOT/runtimes`) — veja `isInside()`.
- Endpoints novos que executam ações precisam de allowlist (como
  `XAMPP_ACTION_COMPONENTS`) e de verificação de `Origin` (a API é local, mas
  qualquer site no navegador poderia tentar chamá-la).
- Nunca registre segredos (senhas de banco, tokens) em logs ou diagnósticos.

## Estilo de código

- Node/CommonJS no backend (`server.cjs`, `lib/*.cjs`), `'use strict'` no topo.
- Frontend em JavaScript puro, sem framework; renderização com escape de HTML.
- Mensagens de interface e comentários em português do Brasil.
- Preferimos código legível com pequenas funções nomeadas a heranças profundas.

## Reportando problemas

Ao abrir uma issue, inclua:

- Versão do Windows e do Node.js.
- O diagnóstico exportado (botão **◫** na barra superior) quando aplicável —
  **remova qualquer senha ou dado sensível antes de colar**.
- Passos exatos para reproduzir e o que esperava acontecer.
