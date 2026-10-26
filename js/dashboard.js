import { $, $$, showModal, closeModal, toast } from './core.js';

const storageKey = 'xamppStudioDashboard';
const modules = [
  { id: 'php', title: 'PHP ativo', description: 'Versão, configuração e runtimes disponíveis.' },
  { id: 'services', title: 'Estado dos serviços', description: 'Apache, MySQL e disponibilidade das portas.' },
  { id: 'extensions', title: 'Extensões PHP', description: 'Extensões carregadas no interpretador.' },
  { id: 'database', title: 'Revisão SQL', description: 'Atalho para analisar arquivos antes de importar.' }
];

export function initializeDashboard() {
  let hidden = [];
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved)) hidden = [...new Set(saved.filter(id => modules.some(module => module.id === id)))];
  } catch { /* A visualização padrão funciona sem armazenamento. */ }

  function render() {
    $$('[data-dashboard-module]').forEach(panel => { panel.hidden = hidden.includes(panel.dataset.dashboardModule); });
    const count = modules.length - hidden.length;
    $('#moduleCount').textContent = `${count} de ${modules.length} módulos`;
    $('#dashboardEmpty').hidden = count !== 0;
    $('.overview-grid').hidden = count === 0;
  }

  function customize() {
    showModal('PERSONALIZAR VISÃO GERAL', `<h2>Um espaço do seu jeito.</h2><p class="modal-copy">Escolha o que aparece no painel. Todos os recursos continuam disponíveis no menu lateral.</p><div class="module-options">${modules.map(module => `<label class="module-option"><span><strong>${module.title}</strong><small>${module.description}</small></span><input type="checkbox" name="dashboard-module" value="${module.id}" ${hidden.includes(module.id) ? '' : 'checked'}></label>`).join('')}</div><p class="panel-help">Preferência salva apenas neste navegador.</p><div class="modal-actions"><button class="outline-button" id="resetDashboard">Mostrar todos</button><button class="primary-button" id="saveDashboard">Salvar visualização</button></div>`);
    $('#resetDashboard').onclick = () => { $$('[name="dashboard-module"]').forEach(input => { input.checked = true; }); };
    $('#saveDashboard').onclick = () => {
      hidden = $$('[name="dashboard-module"]:not(:checked)').map(input => input.value);
      let saved = true;
      try { localStorage.setItem(storageKey, JSON.stringify(hidden)); } catch { saved = false; }
      render();
      closeModal();
      toast(saved ? 'Visualização salva.' : 'Visualização aplicada. O navegador não permitiu salvar a preferência.', !saved);
    };
  }
  $('#customizeDashboard').addEventListener('click', customize);
  $('#restoreDashboard').addEventListener('click', customize);
  render();
}
