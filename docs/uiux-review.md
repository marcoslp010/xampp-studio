# Revisão de UI/UX — 26 de outubro de 2026

## Problemas encontrados

- A barra superior tinha muitas ações representadas por símbolos sem rótulos; várias desapareciam no celular.
- Ícones de famílias diferentes, superfícies com excesso de efeitos e informações dentro de cartões aninhados prejudicavam a hierarquia.
- A visão geral era fixa e não permitia escolher quais módulos acompanhar.
- O indicador de integridade dependia da disponibilidade do PHP, embora o painel apresentasse serviços. Um ponto verde também aparecia sem leitura confirmada.
- Navegação, controle de foco e telas compartilhavam um único arquivo grande; os estilos estavam concentrados em um arquivo com mais de duas mil linhas.

## Mudanças entregues

- Tema grafite com acento cobre, ícones SVG locais, tipografia e bordas consistentes. Cores de sucesso, aviso e erro permanecem independentes do acento.
- Ferramentas com rótulos em um menu disponível também no celular.
- Busca de páginas com Ctrl+K ou Cmd+K, pesquisa sem distinção de acentos, setas, Enter, Escape e estado sem resultados.
- Personalização dos quatro módulos da visão geral, persistência neste navegador e recuperação quando todos estão ocultos.
- Contagem de serviços em execução baseada nos dois estados reais. PHP sem leitura usa um indicador neutro ou de aviso.
- Escape fecha os diálogos mesmo quando um campo de busca está ativo. O foco retorna ao botão de ferramentas quando a ação original está em um menu fechado.
- Navegação móvel preserva foco, bloqueio do conteúdo atrás do menu e suporte a movimento reduzido.

## Organização das fontes

| Área | Fonte |
|---|---|
| Telas e fluxos existentes | `src/ui/app.js` |
| Navegação, busca e menu de ferramentas | `js/shell.js` |
| Preferências do painel | `js/dashboard.js` |
| Estado e primitivas de diálogo | `js/core.js` |
| Tokens do tema | `src/styles/tokens.css` |
| Base, componentes, telas e composição | Demais módulos em `src/styles/` |
| Ordem de composição do CSS | `src/styles.css` |

`npm run build` gera `js/app.js` e `styles.css`. O pequeno montador de JS reúne explicitamente os módulos de navegação e painel, sem transpilar sintaxe nem resolver dependências arbitrárias. As fontes continuam separadas, mas o navegador usa as rotas estáticas que já existiam; atualizar a interface não exige reiniciar o agente. Novos imports nesses módulos exigem atualizar o montador ou adotar um empacotador completo.

## Verificação

- `npm test`: 23 testes principais, 8 testes do catálogo, destinos Admin e quatro casos de segurança da inicialização passaram.
- Build de CSS e JS e verificação de sintaxe passaram.
- Chrome, contra `http://127.0.0.1:43197`: as nove telas principais passaram em 1440, 768 e 390 pixels, sem overflow horizontal e sem erros JavaScript.
- `ui-modular.js`: persistência, painel vazio, restauração, busca, uso repetido, setas, Escape e ferramentas no celular passaram.
- `ui-states.js`: dados salvos inválidos, abas da versão PHP, desconexão simulada, reconexão e foco do menu móvel passaram.
- Capturas: `ui-desktop.png`, `ui-mobile.png`, `ui-services.png`, `ui-command-search.png`, `ui-customize.png` e `ui-offline.png`.

Os testes de interface não ativaram runtimes, instalaram extensões, aplicaram SQL nem alteraram serviços. Na leitura local usada nesta revisão, o PHP ativo estava indisponível e os serviços não estavam em execução; a interface apresenta esses estados. A validação visual não confirma a saúde operacional dos runtimes.
