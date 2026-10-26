/**
 * Núcleo da interface: estado compartilhado, armazenamento local e as
 * primitivas de interação (toast, modal, estados de carregamento).
 *
 * Fica separado das telas para que qualquer página da interface possa
 * importar apenas o que precisa, sem carregar o arquivo inteiro.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const initialVersions = [];

const loadVersions = () => {
  try {
    const saved = localStorage.getItem('xamppStudioVersions');
    const value = saved ? JSON.parse(saved) : initialVersions;
    return Array.isArray(value)
      ? value.filter(item => item && typeof item.version === 'string' && item.version.trim().length > 0)
      : initialVersions.map(item => ({ ...item }));
  } catch { return initialVersions.map(item => ({ ...item })); }
};

const loadActivity = () => {
  try {
    const value = JSON.parse(localStorage.getItem('xamppStudioActivity'));
    return Array.isArray(value) ? value.slice(0, 100) : [];
  } catch { return []; }
};

export const state = {
  versions: loadVersions(),
  liveVersions: [],
  liveStatus: null,
  apiAvailable: false,
  pendingDlls: [],
  sqlFile: null,
  sqlText: '',
  selectedVersion: null,
  catalogPackages: [],
  preparedApache: [],
  preparedMySql: [],
  activity: loadActivity(),
  phpSettings: null,
  phpSettingsDirty: new Set(),
  performance: null,
  performanceApacheShare: 50,
  firewallLogs: [],
  blockedIps: [],
  cloudflarePreview: null,
  cloudflareActive: false,
  bodyCaptureActive: false,
  bodyCapturePending: false,
  bodyCaptureBytes: 0,
  bodyCaptureError: '',
  dllRegistry: null,
  dllVersionRoot: null,
  versionDetailTab: 'overview',
  phpSettingsRoot: null,
  missingDllSearch: null,
  activeJobs: new Map()
};

export function saveVersions() {
  localStorage.setItem('xamppStudioVersions', JSON.stringify(state.versions));
}

export function recordActivity(event, details, status = 'Concluído') {
  state.activity.unshift({ event, details, status, at: new Date().toISOString() });
  state.activity = state.activity.slice(0, 100);
  try { localStorage.setItem('xamppStudioActivity', JSON.stringify(state.activity)); } catch { /* armazenamento indisponível */ }
}

export function escapeHtml(value) {
  const amp = String.fromCharCode(38);
  const entities = {
    '&': amp + 'amp;',
    '<': amp + 'lt;',
    '>': amp + 'gt;',
    '"': amp + 'quot;',
    "'": amp + '#39;'
  };
  return String(value).replace(/[&<>"']/g, c => entities[c]);
}

/**
 * URLs que podem vir de respostas de catálogos externos (Packagist, PECL):
 * só http(s) e caminhos relativos do próprio Studio são aceitos em href.
 * Escape de HTML não neutraliza esquemas como javascript: — o guard é aqui.
 */
export function safeUrl(value) {
  const url = String(value || '');
  return /^(?:https?:)?\/\//i.test(url) || url.startsWith('/') ? url : '#';
}

/* --- Interações ---------------------------------------------------------- */

export function toast(message, warning = false) {
  const item = document.createElement('div');
  item.className = `toast ${warning ? 'error' : 'ok'}`;
  item.setAttribute('role', warning ? 'alert' : 'status');
  item.textContent = message;
  $('#toastRegion').append(item);
  setTimeout(() => {
    item.classList.add('leaving');
    setTimeout(() => item.remove(), 180);
  }, 3800);
}

let modalReturnFocus = null;

export function showModal(kicker, html) {
  $('#modalKicker').textContent = kicker;
  $('#modalContent').innerHTML = html;
  const dialog = $('#modal');
  if (!dialog.open) {
    modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
  }
  requestAnimationFrame(() => {
    const focusable = $('#modalContent').querySelector('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[href]') || $('#modalClose');
    if (focusable) focusable.focus({ preventScroll: true });
  });
}

export function closeModal() {
  const dialog = $('#modal');
  if (dialog.open) dialog.close();
}

const modalDialog = $('#modal');
modalDialog.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const candidates = [...modalDialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length);
  if (!candidates.length) {
    event.preventDefault();
    modalDialog.focus();
    return;
  }
  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  if (event.shiftKey && (document.activeElement === first || !modalDialog.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !modalDialog.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
});
modalDialog.addEventListener('close', () => {
  const returnTarget = modalReturnFocus;
  modalReturnFocus = null;
  if (returnTarget?.isConnected && typeof returnTarget.focus === 'function') {
    requestAnimationFrame(() => returnTarget.focus({ preventScroll: true }));
  }
});

/**
 * Mostra um estado de carregamento no lugar do conteúdo real e devolve a
 * função que restaura o painel quando a leitura termina.
 */
export function showSkeleton(container, lines = 3) {
  if (!container) return () => {};
  const previous = container.innerHTML;
  container.innerHTML = Array.from({ length: lines }, (_, index) =>
    `<div class="skeleton skeleton-line ${index === 0 ? 'medium' : 'short'}"></div>`).join('');
  return () => { container.innerHTML = previous; };
}

/** Coloca um botão em estado "ocupado" enquanto a operação assíncrona roda. */
export async function withPending(button, label, action) {
  if (!button) return action();
  const original = button.innerHTML;
  button.disabled = true;
  button.dataset.pending = '1';
  button.innerHTML = `<span class="spinner"></span> ${label}`;
  try { return await action(); }
  finally {
    button.disabled = false;
    delete button.dataset.pending;
    button.innerHTML = original;
  }
}
