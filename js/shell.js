import { $, $$, showModal, closeModal } from './core.js';

/** Shared navigation, mobile focus management and tool discovery. */
export function createShell(navigate) {
const modal = $('#modal');
const sidebar = $('#appSidebar');
const mobileMenuButton = $('#mobileMenuButton');
const sidebarBackdrop = $('#sidebarBackdrop');
const mainContent = $('.main-content');

function syncNavigationInert(){
  const isMobile=window.matchMedia('(max-width: 960px)').matches;
  const isOpen=sidebar.classList.contains('mobile-open');
  sidebar.inert=isMobile&&!isOpen;
  mainContent.inert=isMobile&&isOpen;
}

function setMobileNavigation(open, restoreFocus = false){
  const isMobile=window.matchMedia('(max-width: 960px)').matches;
  if(!isMobile)open=false;
  sidebar.classList.toggle('mobile-open', open);
  document.body.classList.toggle('navigation-open', open);
  mobileMenuButton.setAttribute('aria-expanded', String(open));
  mobileMenuButton.setAttribute('aria-label', open ? 'Fechar navegação' : 'Abrir navegação');
  syncNavigationInert();
  if(open) sidebar.querySelector('.nav-item.active')?.focus({preventScroll:true});
  else if(restoreFocus&&isMobile) mobileMenuButton.focus({preventScroll:true});
}

mobileMenuButton.addEventListener('click',()=>setMobileNavigation(!sidebar.classList.contains('mobile-open')));
sidebarBackdrop.addEventListener('click',()=>setMobileNavigation(false,true));
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!modal.open&&sidebar.classList.contains('mobile-open'))setMobileNavigation(false,true);
});
sidebar.addEventListener('keydown',event=>{
  if(event.key!=='Tab'||!sidebar.classList.contains('mobile-open'))return;
  const focusable=[...sidebar.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')]
    .filter(element=>element.getClientRects().length&&!element.hidden);
  if(!focusable.length){event.preventDefault();return}
  const first=focusable[0],last=focusable[focusable.length-1];
  if(event.shiftKey&&(document.activeElement===first||!sidebar.contains(document.activeElement))){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&(document.activeElement===last||!sidebar.contains(document.activeElement))){event.preventDefault();first.focus()}
});
window.addEventListener('resize',()=>{
  if(!window.matchMedia('(max-width: 960px)').matches)setMobileNavigation(false);
  else syncNavigationInert();
});
syncNavigationInert();


initializeSearch(navigate);
initializeTools();
$('.brand').addEventListener('click', event => { event.preventDefault(); navigate('overview'); });
return { setMobileNavigation };
}

function initializeTools() {
  const menu = $('#toolsMenu');
  document.addEventListener('click', event => {
    if (!menu.contains(event.target) || event.target.closest('.tools-popover button')) menu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
      event.preventDefault();
    }
  });
  menu.addEventListener('focusout', () => {
    requestAnimationFrame(() => { if (!menu.contains(document.activeElement)) menu.open = false; });
  });
}

function initializeSearch(navigate) {
  const descriptions = {
    overview: 'Resumo do ambiente e seus módulos',
    php: 'Runtimes, DLLs, extensões e php.ini',
    apache: 'Servidor web, versões e configuração',
    mysql: 'Runtimes MySQL e MariaDB',
    database: 'Revisão e importação de arquivos SQL',
    services: 'Iniciar, parar e configurar os serviços',
    performance: 'Memória, cache e concorrência',
    firewall: 'Requisições, IPs e acesso ao ambiente',
    activity: 'Histórico de ações, downloads e backups'
  };
  const pages = $$('.nav-item').map(button => ({
    id: button.dataset.page,
    // Read only the label, excluding the icon and live version counters.
    label: [...button.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim(),
    icon: button.querySelector('.nav-icon').innerHTML
  }));
  const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  function openSearch() {
    if ($('#modal').open) return;
    $('#toolsMenu').open = false;
    showModal('NAVEGAÇÃO RÁPIDA', '<div id="commandWorkspace"><h2 class="sr-only">Buscar página</h2><label class="command-input"><svg class="ui-icon" aria-hidden="true"><use href="#icon-search"/></svg><input id="commandQuery" type="search" placeholder="Buscar página ou recurso…" aria-label="Buscar página ou recurso" autocomplete="off"></label><p class="command-count" id="commandCount" role="status"></p><div class="command-results" id="commandResults"></div><div class="command-footer"><span><kbd>↑</kbd> <kbd>↓</kbd> navegar <kbd>Enter</kbd> abrir</span><span><kbd>Esc</kbd> fechar</span></div></div>');
    const input = $('#commandQuery');
    const results = $('#commandResults');
    let selected = 0;
    let matches = [];
    function select(index, focus = false) {
      selected = index;
      const buttons = $$('[data-command-page]', results);
      buttons.forEach((button, i) => {
        button.classList.toggle('selected', i === selected);
        if (i === selected) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      });
      if (focus) buttons[selected]?.focus();
    }
    function render() {
      const query = normalize(input.value.trim());
      matches = pages.filter(page => normalize(`${page.label} ${descriptions[page.id]}`).includes(query));
      // Labels and icons come from the static navigation, never API responses.
      results.innerHTML = matches.map(page => `<button class="command-result" type="button" data-command-page="${page.id}"><span class="command-icon">${page.icon}</span><span><strong>${page.label}</strong><small>${descriptions[page.id]}</small></span><span class="command-arrow" aria-hidden="true">↗</span></button>`).join('') || '<div class="command-empty">Nenhuma página encontrada. Tente “PHP”, “SQL” ou “serviços”.</div>';
      $('#commandCount').textContent = `${matches.length} ${matches.length === 1 ? 'página encontrada' : 'páginas encontradas'}`;
      select(0);
    }
    function go(id) { closeModal(); navigate(id); }
    input.addEventListener('input', render);
    results.addEventListener('click', event => {
      const button = event.target.closest('[data-command-page]');
      if (button) go(button.dataset.commandPage);
    });
    results.addEventListener('focusin', event => {
      const index = matches.findIndex(page => page.id === event.target.dataset.commandPage);
      if (index >= 0) select(index);
    });
    $('#commandWorkspace').addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && matches.length) {
        event.preventDefault();
        select((selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length, true);
      } else if (event.key === 'Enter' && event.target === input && matches[selected]) {
        event.preventDefault(); go(matches[selected].id);
      }
    });
    render();
  }
  $('#openCommandSearch').addEventListener('click', openSearch);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
  });
}

