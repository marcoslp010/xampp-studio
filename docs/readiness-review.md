# Avaliação do XAMPP Studio — 25/10/2026

## Parecer

O Studio funciona como gerenciador local em beta. A interface foi modernizada e suas principais consultas funcionaram no ambiente real. O ambiente completo ainda não está pronto: o MariaDB gerenciado está parado e sua porta 3306 está ocupada pelo Docker. Não houve troca de porta nem interrupção do Docker ou dos serviços durante esta revisão.

## Evidências do ambiente

| Verificação | Resultado observado |
| --- | --- |
| Painel | `http://127.0.0.1:43197`, somente loopback |
| Modo | Independente (`standalone`) |
| PHP CLI | 8.5.12, 44 extensões carregadas |
| Apache | 2.4.69, serviço em execução na porta 8088, porta pertencente ao Studio |
| HTTP Apache | GET `/` na porta 8088 respondeu 200 |
| MariaDB | 13.1.1 selecionado, serviço parado |
| Porta 3306 | Ocupada por `com.docker.backend.exe`, não pelo runtime do Studio |
| API local | Status, versões, registro DLL, jobs, performance e runtimes preparados responderam 200 |

## Mudanças entregues

- Tema dark em tons de carvão com acento verde, tipografia e espaçamento mais compactos.
- Tailwind compilado no projeto, lockfile e comando de build; nenhuma dependência de CSS em CDN.
- Menu móvel, refluxo dos controles PHP/Serviços e estados claros de conexão e leitura.
- Remoção da versão PHP e das extensões fictícias usadas como placeholders.
- Foco contido nos diálogos, retorno ao controle anterior e atalhos suspensos durante edição.
- Os destinos Admin do Apache e phpMyAdmin passam a usar a porta real do Apache.
- `start.ps1` só encerra um processo identificado como Node executando o `server.cjs` deste projeto e respeita `XAMPP_STUDIO_PORT`. Se a identidade não puder ser comprovada, interrompe a inicialização.

## Validação e limites

A suíte original tem 19 testes de regras PHP/Apache, DLLs e serviços. Todos passaram em `npm test`, assim como as verificações adicionais dos destinos Admin e quatro cenários de identificação de processo; estas substituem as APIs de processo por stubs e não encerram programas reais. O build Tailwind e as verificações de sintaxe também passaram.

O teste de navegador passou nas 33 combinações de tela/largura (11 telas em 1440, 768 e 390 pixels), sem rolagem horizontal da página. Passaram estado de navegação, filtro de extensões, proteção dos atalhos ao digitar, foco, Escape e retorno do foco nos diálogos. O segundo teste passou com versões salvas inválidas, abas de detalhes PHP, desconexão simulada, remoção de indicação de runtime ativo desatualizada, reconexão e foco no menu móvel. Nenhuma exceção JavaScript foi registrada nesses testes; erros HTTP 503 são esperados apenas na simulação de desconexão. Capturas: `ui-desktop.png`, `ui-mobile.png`, `ui-services.png` e `ui-offline.png`.

Os testes de leitura e interface não comprovam instalação, migração, rollback ou restauração de banco ponta a ponta. Não foram executadas ações de Firewall, instalação de DLLs, troca de runtimes ou alterações de serviços nesta revisão. A revisão também não representa uma auditoria de segurança completa.

## Pendências para considerar o ambiente completo pronto

1. Resolver a disputa pela porta 3306 por decisão operacional explícita: reconfigurar o serviço responsável ou planejar suporte consistente a uma porta alternativa do banco. O código ainda assume 3306 em caminhos de controle.
2. Reiniciar o Studio com os privilégios adequados para carregar as correções de servidor. A UI estática atualizada já é servida pela instância existente; a identidade da instância elevada não pôde ser consultada pelo processo desta revisão, então ela não foi encerrada automaticamente.
3. Validar os fluxos de instalação/ativação/rollback em ambiente de teste com dados descartáveis antes de considerar uma distribuição estável.
4. SQL continua limitado à análise; backup de configuração não equivale a backup completo dos bancos, e o Studio ainda não executa DDL/SQL.

Os arquivos anteriores da interface, servidor e inicialização estão preservados em `backups/ui-before-20261025-131634/`.
