/**
 * XAMPP Studio — telas e interações.
 *
 * O núcleo (estado, toasts, modal) vive em js/core.js e o acesso ao agente
 * local em js/api.js. Este arquivo cuida das telas e das interações.
 */

import {
  $,
  $$,
  closeModal,
  escapeHtml,
  recordActivity,
  safeUrl,
  saveVersions,
  showModal,
  showSkeleton,
  state,
  toast,
  withPending
} from '../../js/core.js';
import { requestApi } from '../../js/api.js';
import { createShell } from '../../js/shell.js';
import { initializeDashboard } from '../../js/dashboard.js';

const modal = $('#modal');
const { setMobileNavigation } = createShell(navigate);
initializeDashboard();

$('#modalClose').addEventListener('click',closeModal);
modal.addEventListener('click',e=>{if(e.target===modal)closeModal()});
$('#modalContent').addEventListener('click',event=>{if(event.target.id==='cancelAction')closeModal()});

/**
 * Mostra um estado de carregamento no lugar do conteúdo real e devolve a
 * função que restaura o painel quando a leitura termina.
 */

/** Coloca um botão em estado "ocupado" enquanto a operação assíncrona roda. */

/** Executa uma tarefa e comunica o resultado com um toast consistente. */

function navigate(page){
  if(page==='catalog')page='php';
  const labels={overview:'Visão geral',php:'Versões do PHP',apache:'Apache',mysql:'MySQL / MariaDB',version:'Configuração da versão',catalog:'Buscar extensões',database:'Banco de dados',services:'Serviços',performance:'Performance',firewall:'Firewall',activity:'Atividade'};
  const navPage=page==='version'?'php':page;
  $$('.page').forEach(p=>p.classList.toggle('active-page',p.id===`page-${page}`));
  $$('.nav-item').forEach(n=>{const active=n.dataset.page===navPage;n.classList.toggle('active',active);if(active)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current')});
  $('#breadcrumbCurrent').textContent=labels[page]||labels.overview;
  setMobileNavigation(false,window.matchMedia('(max-width: 960px)').matches);
  document.title=`${labels[page]||labels.overview} · XAMPP Studio`;
  if(page==='version'){
    renderVersionDetail();
    showVersionDetailTab(state.versionDetailTab);
    if(state.apiAvailable)loadDllRegistry();
  }
  if(page==='apache'&&state.apiAvailable){loadApacheReleases();loadPreparedApacheRuntimes()}
  if(page==='mysql'&&state.apiAvailable){loadMySqlReleases();loadPreparedMySqlRuntimes()}
  if(page==='php'){state.dllVersionRoot=null;if(state.apiAvailable)loadDllRegistry()}
  if(page==='performance'&&state.apiAvailable)loadPerformance();
  if(page==='firewall'&&state.apiAvailable)loadFirewall();
  window.scrollTo({top:0,behavior:'smooth'});
}
$$('.nav-item').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.page)));
$$('[data-goto]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.goto)));
$$('.detail-tab').forEach(button=>button.addEventListener('click',()=>showVersionDetailTab(button.dataset.detailTab)));
$('.version-detail-tabs').addEventListener('keydown',event=>{
  const tabs=$$('.detail-tab');
  const index=tabs.indexOf(event.target);
  if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  showVersionDetailTab(tabs[next].dataset.detailTab);
  tabs[next].focus({preventScroll:true});
});
$('.skip-link').addEventListener('click',event=>{event.preventDefault();$('#mainContent').focus();window.scrollTo({top:0,behavior:'instant'})});
$('#backToPhpVersions').addEventListener('click',()=>navigate('php'));

function dllStatusHtml(check,root,version){
  if(!check)return '';
  const missing=check.missing||[];
  const title=check.compatible?'Todas as DLLs registradas existem neste runtime.':`Faltam: ${(missing.map(item=>item.dll).join(', '))}`;
  return `<button type="button" class="dll-status ${check.compatible?'ok':'blocked'}" data-dll-root="${escapeHtml(root||'')}" title="${escapeHtml(title)}" aria-label="Ver DLLs registradas do PHP ${escapeHtml(version||'')}">${check.compatible?check.required?`DLLs · ${check.present}/${check.required}`:'Sem registro de DLLs':`${missing.length} DLL(s) ausente(s)`} <span aria-hidden="true">→</span></button>`;
}
function apacheCompatibilityHtml(runtime){
  const compatibility=runtime?.apacheCompatibility;
  if(!compatibility||compatibility.compatible)return '';
  const conflicts=compatibility.conflicts||[];
  const details=conflicts.map(item=>`${item.extension}: ${(item.missing||[]).join(', ')} (${item.dll})`).join(' · ');
  return `<span class="result-chip blocked" title="${escapeHtml(details||compatibility.summary||'Incompatível com o Apache atual')}">⚠ Incompatível com o Apache</span><span class="extension-warning">${escapeHtml(details||'Exige uma versão mais nova do Apache')}</span>`;
}
function renderVersions(){
  $('#activeVersion').textContent=state.liveStatus?.phpCli?.version||'—';
  const list=$('#versionList');
  if(!state.apiAvailable){
    list.innerHTML='<div class="empty-state"><strong>Agente local desconectado</strong><p>Conecte o agente para consultar os runtimes instalados. Os dados salvos neste navegador foram preservados.</p></div>';
    return;
  }
  const liveVersion=state.liveStatus?.phpCli?.version;
  list.innerHTML=state.versions.map(v=>{
    const current=Boolean(liveVersion&&v.version===liveVersion&&v.current);
    return `<article class="version-card ${current?'current-version':''}" ${v.root?`data-runtime-root="${escapeHtml(v.root)}"`:''}><div class="version-card-main"><span class="php-tile">php</span><div><strong>PHP ${escapeHtml(v.version)}</strong><small>${escapeHtml(v.source||v.note||'Runtime disponível')}</small><code class="runtime-card-path">${escapeHtml(v.root||'')}</code></div></div><div class="version-badges"><span class="${current?'active-badge':''}">${current?'● Em uso':escapeHtml(v.channel||'Preparado')}</span><span>${escapeHtml(v.threadSafety||v.ts||'—')}</span><span>${escapeHtml(v.architecture||v.arch||'—')}</span></div><span class="version-footnote">${current?'PHP em uso neste ambiente':'DLLs e configurações por versão'}</span>${dllStatusHtml(v.dllCheck,v.root,v.version)}${apacheCompatibilityHtml(v)}${current?'<span class="result-chip done">ATUAL</span>':''}${v.root?`<div class="version-card-actions"><button class="outline-button small-button runtime-config" data-root="${escapeHtml(v.root)}" type="button">Configurar</button><button class="outline-button small-button runtime-dlls" data-root="${escapeHtml(v.root)}" type="button">⧉ Extensões</button></div>`:''}${(v.missingExtensions||[]).length?`<span class="extension-warning">${v.missingExtensions.length} extensão(ões) pendente(s)</span>`:''}</article>`;
  }).join('');
  $$('.runtime-config').forEach(b=>b.addEventListener('click',()=>openVersionDetail(b.dataset.root)));
  $$('.runtime-dlls').forEach(b=>b.addEventListener('click',()=>openVersionDetail(b.dataset.root,'dlls')));
  $$('.dll-status[data-dll-root]').forEach(b=>b.addEventListener('click',()=>openVersionDetail(b.dataset.dllRoot,'dlls')));
  $$('.version-card[data-runtime-root]').forEach(card=>{
    card.addEventListener('click',event=>{if(event.target.closest('button,a,input,select'))return;openVersionDetail(card.dataset.runtimeRoot)});
    card.addEventListener('keydown',event=>{if(event.target!==card)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();openVersionDetail(card.dataset.runtimeRoot)}});
  });
}
function dllRuntimeList(){return Array.isArray(state.liveVersions)?state.liveVersions:[]}
function selectedDllRuntime(){
  const list=dllRuntimeList();
  if(state.dllVersionRoot)return list.find(v=>v.root===state.dllVersionRoot)||null;
  return list.find(v=>v.current)||list[0]||null;
}
function openVersionDetail(root,tab='overview'){
  if(!dllRuntimeList().some(runtime=>runtime.root===root))return;
  if(root!==state.catalogRoot)resetVersionCatalog();
  state.dllVersionRoot=root;
  state.versionDetailTab=tab;
  navigate('version');
}
function showVersionDetailTab(tab){
  if(!['overview','dlls','settings'].includes(tab))return;
  state.versionDetailTab=tab;
  $$('.detail-tab').forEach(button=>{const active=button.dataset.detailTab===tab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1});
  $$('.detail-panel').forEach(panel=>{panel.hidden=panel.dataset.detailPanel!==tab});
  const runtime=selectedDllRuntime();
  renderCatalogRuntimes();
  if(tab==='dlls'&&state.apiAvailable){if(state.dllRegistry)renderDllRegistry();else loadDllRegistry();loadExtensionDownloads()}
  if(tab==='settings'&&state.apiAvailable&&runtime&&(state.phpSettingsRoot!==runtime.root||!state.phpSettings))loadPhpSettings(runtime.root);
}
function renderVersionDetail(){
  const runtime=selectedDllRuntime();
  const activate=$('#activateSelectedVersion');
  if(!runtime){
    $('#versionDetailTitle').textContent='—';$('#versionDetailSubtitle').textContent='Selecione uma versão na lista para configurar.';$('#versionDetailState').textContent='SEM VERSÃO';$('#versionDetailSummary').innerHTML='<span>Nenhuma versão selecionada.</span>';$('#versionDetailOverview').innerHTML='<div class="empty-state"><strong>Nenhuma versão selecionada</strong><p>Volte para a lista de versões do PHP.</p></div>';activate.disabled=true;return;
  }
  state.dllVersionRoot=runtime.root;
  const check=runtime.dllCheck||{missing:[],present:0,required:0};
  const missing=check.missing||[];
  const current=Boolean(runtime.current&&state.liveStatus?.phpCli?.version===runtime.version);
  const label=current?'Em uso':missing.length?'Faltam DLLs':'Disponível';
  const architecture=runtime.architecture||'A consultar';
  const mode=runtime.threadSafety||'A consultar';
  $('#versionDetailTitle').textContent=runtime.version||'—';
  if($('#page-version').classList.contains('active-page'))$('#breadcrumbCurrent').textContent=`PHP ${runtime.version} · configuração`;
  $('#versionDetailSubtitle').textContent=runtime.root;
  $('#versionDetailState').textContent=label;
  $('#versionDetailState').classList.toggle('blocked',Boolean(missing.length));
  $('#versionDetailSummary').innerHTML=`<div><small>VERSÃO DO PHP</small><strong>${escapeHtml(runtime.version)}</strong></div><div><small>BUILD</small><strong>${escapeHtml(runtime.threadSafety||runtime.architecture?`${mode} · ${architecture}`:'Detectado na consulta')}</strong></div><div><small>DEPENDÊNCIAS</small><strong>${check.required?`${check.present||0} de ${check.required} presentes`:'Sem registro'}</strong></div><div><small>ESTADO</small><strong>${label}</strong></div>`;
  activate.disabled=current||!state.apiAvailable;
  activate.textContent=current?'PHP em uso':'Ativar esta versão';
  activate.onclick=()=>{if(!current)showPhpActivation(runtime)};
  const compatibility=runtime.apacheCompatibility;
  const compatibilityCopy=compatibility?.compatible===false?compatibility.summary||'Foram encontradas dependências incompatíveis com o Apache atual.':check.required?'Nenhum conflito foi apontado nas dependências analisadas. O conjunto PHP e Apache será validado ao ativar.':'O registro de dependências está vazio. A ativação ainda precisa validar o conjunto PHP e Apache.';
  $('#versionDetailOverview').innerHTML=`<article class="detail-card"><div class="eyebrow">INSTALAÇÃO LOCAL</div><h3>Sobre este PHP</h3><div class="detail-list"><div><span>Origem</span><strong>${escapeHtml(runtime.source||'Runtime local')}</strong></div><div><span>Modo de execução</span><strong>${escapeHtml(mode)}</strong></div><div><span>Arquitetura</span><strong>${escapeHtml(architecture)}</strong></div><div><span>Compilador</span><strong>${escapeHtml(runtime.compiler||'A consultar')}</strong></div></div><p class="panel-help">${current?'Este é o PHP selecionado para o ambiente.':'Você pode preparar extensões e configurações antes de ativar esta versão.'}</p><div class="compatibility-note ${compatibility?.compatible===false?'warning':''}"><strong>${compatibility?.compatible===false?'Compatibilidade requer atenção':'Validação ao ativar'}</strong>${escapeHtml(compatibilityCopy)}</div></article><article class="detail-card"><div class="eyebrow">GERENCIAR ESTA VERSÃO</div><h3>O que você quer fazer?</h3><div class="runtime-action-list"><button class="runtime-action open-detail-tab" data-detail-tab="dlls" type="button"><span><strong>Buscar e baixar DLLs</strong><small>Extensões compatíveis e downloads deste PHP</small></span><span aria-hidden="true">→</span></button><button class="runtime-action open-detail-tab" data-detail-tab="settings" type="button"><span><strong>Editar configurações</strong><small>Memória, uploads e variáveis do php.ini</small></span><span aria-hidden="true">→</span></button></div><div class="compatibility-note ${missing.length?'warning':''}"><strong>${missing.length?`${missing.length} dependência(s) ausente(s)`:check.required?`${check.present} dependência(s) localizada(s)`:'Nenhuma dependência registrada'}</strong>${missing.length?escapeHtml(missing.map(item=>item.dll).join(', ')):'Os downloads pertencem a esta instalação do PHP, mesmo que outra tenha o mesmo número de versão.'}</div></article>`;
  bindFindMissingDlls();
  $$('.open-detail-tab').forEach(button=>button.addEventListener('click',()=>{showVersionDetailTab(button.dataset.detailTab);$(`.detail-tab[data-detail-tab="${button.dataset.detailTab}"]`).focus({preventScroll:true})}));
}
function bindFindMissingDlls(){
  $$('.find-missing-dlls').forEach(button=>{button.onclick=()=>searchMissingDllsForRuntime(selectedDllRuntime())});
}

async function showPhpActivation(runtime){
  if(!state.apiAvailable){toast('Inicie o agente local com start.ps1 para ativar uma versão.',true);return}
  if(!state.preparedApache.length){try{state.preparedApache=(await requestApi('/api/apache/prepared')).runtimes}catch{}}
  const missing=runtime.missingExtensions||[];
  const dllCheck=runtime.dllCheck||{compatible:true,missing:[],present:0,required:0};
  const dllMissing=dllCheck.missing||[];
  const dllNotice=dllCheck.compatible?`<div class="modal-note"><strong>DLLs registradas:</strong> ${dllCheck.present}/${dllCheck.required} presentes neste runtime. A troca pode prosseguir.</div>`:`<div class="modal-note danger-note"><strong>Troca bloqueada: ${dllMissing.length} DLL(s) registrada(s) não existem neste runtime.</strong><ul>${dllMissing.map(item=>`<li>${escapeHtml(item.dll)} <small>(${escapeHtml((item.sources||['php.ini']).join(', '))})</small></li>`).join('')}</ul>O PHP atual continuará ativo. Instale essas DLLs no runtime ou ajuste o registro antes de tentar novamente.<button type="button" class="text-action inspect-missing-dlls" data-dll-root="${escapeHtml(runtime.root)}">Ver DLLs ausentes nesta versão <span>→</span></button></div>`;
  const apacheOptions=state.preparedApache.map(item=>`<option value="${escapeHtml(item.root)}">Apache ${escapeHtml(item.version)} · ${escapeHtml(item.build)} (${escapeHtml(item.compiler)})</option>`).join('');
  const apacheCompatibility=runtime.apacheCompatibility||null;
  const apacheNotice=apacheCompatibility&&!apacheCompatibility.compatible?`<div class="modal-note danger-note"><strong>Esta versão não roda no Apache atual.</strong><p>${escapeHtml(apacheCompatibility.summary||'As extensões exigem símbolos que a biblioteca do Apache não oferece.')}</p><p>Escolha abaixo um runtime Apache compatível — o Studio baixa as versões oficiais do Apache Lounge na aba <strong>Apache</strong> — ou volte para uma versão de PHP compatível. Manter o Apache atual faz a troca ser recusada antes de qualquer alteração.</p></div>`:'';
  showModal('TROCA VALIDADA DO AMBIENTE',`<h2>Usar PHP ${escapeHtml(runtime.version)}?</h2><p class="modal-copy">O Studio vai atualizar as referências do PHP e testar o Apache. Se o build atual for incompatível, a troca será revertida. Quando necessário, escolha junto um runtime Apache já baixado.</p><div class="file-summary"><span class="file-type-icon">PHP</span><span><strong>${escapeHtml(runtime.root)}</strong><small>${escapeHtml(runtime.threadSafety||'Thread Safe')} · ${escapeHtml(runtime.architecture||'arquitetura detectada')} · ${escapeHtml(runtime.compiler||'compilador não informado')}</small></span></div><label class="modal-field"><span>Apache neste ambiente</span><select id="switchApache"><option value="">Manter o Apache atual e validar</option><option value="${escapeHtml(`${state.liveStatus?.xamppRoot||'C:\\xampp'}\\apache`)}">Voltar ao Apache incluído no XAMPP</option>${apacheOptions}</select></label>${apacheNotice}${dllNotice}${missing.length?`<div class="modal-note"><strong>Extensões sem build compatível no pacote:</strong> ${missing.map(item=>escapeHtml(item.name)).join(', ')}. Elas ficarão desativadas nesta versão e poderão ser instaladas depois com DLL compatível.</div>`:'<div class="modal-note">As extensões ativas no PHP atual serão migradas quando houver DLL no pacote oficial selecionado.</div>'}<div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmEnvironmentSwitch" ${dllCheck.compatible?'':'disabled'}>${dllCheck.compatible?'Validar e usar PHP':'Troca bloqueada'}</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmEnvironmentSwitch').onclick=async()=>{
    if(!dllCheck.compatible){toast(`Troca bloqueada: faltam ${dllMissing.length} DLL(s) no runtime de destino.`,true);return}
    const button=$('#confirmEnvironmentSwitch');button.disabled=true;button.textContent='Validando configuração…';
    try{
      const apacheRoot=$('#switchApache').value||null;
      const result=await requestApi('/api/environment/switch',{method:'POST',body:JSON.stringify({phpRoot:runtime.root,apacheRoot})});
      state.dllVersionRoot=null;
      closeModal();
      const warnings=result.warnings?.length?` · atenção: ${result.warnings.length} extensão(ões) indisponível(is)`:'';
      recordActivity('Ambiente PHP/Apache alterado',`PHP ${result.phpVersion} · Apache ${result.apacheVersion||'validado'} · backup ${result.backup}`,result.apacheRestarted?'Concluído':'Configurado');
      await loadLiveStatus();
      await loadDllRegistry();
      toast(`PHP ${result.phpVersion} configurado${result.apacheRestarted?' e Apache reiniciado':''}${warnings}`,Boolean(result.warnings?.length));
    }catch(error){button.disabled=false;button.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}
  };
}
$('#quickSwitch').addEventListener('click',()=>navigate('php'));
$('#addVersion').addEventListener('click',async()=>{
  showModal('BUILDS OFICIAIS PARA WINDOWS',`<h2>Adicionar versão do PHP</h2><p class="modal-copy">Lista apenas versões acima da atual, com a mesma arquitetura e modo TS/NTS do seu PHP.</p><div class="modal-note">O ZIP oficial será validado por SHA-256. O Studio prepara o runtime, migra as extensões que existirem e mostra o que ficou pendente antes de oferecer a troca.</div><div id="phpReleaseResults" class="release-list"><div class="catalog-loading">Consultando windows.php.net…</div></div><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button></div>`);
  $('#cancelAction').onclick=closeModal;
  const list=$('#phpReleaseResults');
  if(!state.apiAvailable){list.innerHTML='<div class="modal-note">Inicie o agente com start.ps1 para consultar e baixar builds oficiais.</div>';return}
  try{
    const catalog=await requestApi('/api/php/releases');
    const catalogContext=`<div class="catalog-context">PHP de referência ${escapeHtml(catalog.currentVersion)}${catalog.warning?` · <strong>${escapeHtml(catalog.warning)}</strong>`:''}</div>`;
    list.innerHTML=catalogContext+(catalog.versions.map(item=>`<article class="release-card"><div><strong>PHP ${escapeHtml(item.version)}</strong><small>${escapeHtml(item.threadSafety)} · ${escapeHtml(item.architecture)} · ${escapeHtml(item.compiler||'build oficial')} · ${escapeHtml(item.size)}</small><small>Windows PHP oficial · SHA-256 será conferido</small></div><button class="outline-button small-button download-php" data-version="${escapeHtml(item.version)}">Baixar e adicionar</button></article>`).join('')||'<div class="modal-note">Não encontrei versões superiores compatíveis com o runtime atual.</div>');
    list.dataset.checked='true';
  }catch(error){list.innerHTML=`<div class="modal-note">${escapeHtml(error.message)}</div>`}
});
$('#modalContent').addEventListener('click',async event=>{
  const download=event.target.closest('.download-php');if(!download)return;
  const version=download.dataset.version;
  showModal('CONFIRMAR DOWNLOAD OFICIAL',`<h2>Adicionar PHP ${escapeHtml(version)}?</h2><p class="modal-copy">O pacote será baixado de windows.php.net, validado pelo SHA-256 publicado pelo PHP e extraído como runtime isolado em <code>runtimes/</code>.</p><div class="modal-note">O Studio migra configurações e ativa somente as extensões que vêm no pacote oficial. DLLs externas sem build compatível ficam listadas e bloqueiam a troca até serem instaladas nesse runtime. A versão atual continua disponível para voltar.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Voltar</button><button class="primary-button" id="confirmPhpDownload">Baixar e preparar</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmPhpDownload').onclick=async()=>{
    const button=$('#confirmPhpDownload');button.disabled=true;button.textContent='Baixando e validando…';
    try{const installed=await requestApi('/api/php/install',{method:'POST',body:JSON.stringify({version})});const missing=installed.extensions?.missing||[];const dllMissing=installed.dllCheck?.missing||[];recordActivity('Runtime PHP preparado',`PHP ${installed.version} · ${installed.threadSafety} · ${installed.architecture} · extensões migradas ${installed.extensions?.migrated?.length||0} · pendentes ${missing.length} · DLLs ausentes ${dllMissing.length} · SHA-256 conferido`,dllMissing.length?'Bloqueado':missing.length?'Aviso':'Concluído');closeModal();await loadLiveStatus();toast(dllMissing.length?`PHP ${installed.version} preparado, mas a troca está bloqueada: faltam ${dllMissing.map(item=>item.dll).join(', ')}.`:(missing.length?`PHP ${installed.version} preparado; ${missing.length} extensão(ões) não têm DLL compatível e ficaram desativadas. Veja os detalhes da versão.`:`PHP ${installed.version} preparado com as extensões disponíveis no pacote oficial. Abra a versão e use “Ativar esta versão” quando quiser trocar.`),Boolean(dllMissing.length||missing.length))}
    catch(error){button.disabled=false;button.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}
  };
});
async function runPeclDownload(dataset){
  try{
    const result=await startAsyncJob('/api/extensions/download',{phpRoot:dataset.root,dll:dataset.dll,package:dataset.package,buildFile:dataset.file},`Baixando ${dataset.dll}`);
    recordActivity('DLL baixada',`${result.dll} · PHP ${result.phpVersion} · ${result.build}`);
    showModal('DOWNLOAD CONCLUÍDO',`<h2>${escapeHtml(result.dll)}</h2><p class="modal-copy">Build para PHP ${escapeHtml(result.phpVersion)} · ${escapeHtml(result.threadSafety)} · ${escapeHtml(result.architecture)}. A DLL já está guardada na biblioteca desta versão, junto com o ZIP original.</p><div class="modal-note">Salva em <code>${escapeHtml(result.path)}</code>. O php.ini não foi alterado — para ativar a extensão, use <strong>Instalar e configurar</strong>.</div><p class="catalog-context">SHA-256 da DLL: ${escapeHtml(result.dllSha256)}</p><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button><a class="outline-button" href="${escapeHtml(result.archiveUrl)}" download>Salvar ZIP completo</a><a class="primary-button" href="${escapeHtml(result.downloadUrl)}" download>Salvar cópia da DLL</a></div>`);
    $('#cancelAction').onclick=closeModal;
    if(state.dllVersionRoot===result.phpRoot)loadExtensionDownloads();
  }catch(error){showModal('FALHA NO DOWNLOAD',`<h2>Não foi possível baixar</h2><p class="modal-copy">${escapeHtml(error.message)}</p><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button></div>`);$('#cancelAction').onclick=closeModal}
}
async function runPeclInstall(dataset){
  try{
    const result=await startAsyncJob('/api/dlls/auto-install',{phpRoot:dataset.root,dll:dataset.dll,package:dataset.package,buildFile:dataset.file},`Instalando ${dataset.dll}`);
    closeModal();recordActivity('Extensão DLL instalada',`${result.extension} · PHP ${result.phpVersion} · ${result.build} · SHA-256 ${result.sha256.slice(0,16)}…`);await loadLiveStatus();await loadDllRegistry();toast(`${result.extension} foi instalada e validada no PHP ${result.phpVersion}.`);
    return true;
  }catch(error){$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`);return false}
}
/** Ações de build (baixar/instalar) valem tanto no modal do PECL quanto na lista inline do catálogo. */
async function peclBuildAction(event){
  const download=event.target.closest('.download-pecl-build');
  if(download){
    if(download.disabled)return true;
    download.disabled=true;download.textContent='Baixando…';
    await runPeclDownload(download.dataset);
    if(download.isConnected){download.disabled=false;download.textContent='Baixar DLL'}
    return true;
  }
  const install=event.target.closest('.install-pecl-build');
  if(install){
    if(install.disabled)return true;
    install.disabled=true;install.innerHTML='<strong>Instalando…</strong><span>Processando em segundo plano</span>';
    const ok=await runPeclInstall(install.dataset);
    if(install.isConnected){if(ok){install.innerHTML='<strong>Instalada</strong><span>Validada neste PHP</span>'}else{install.disabled=false;install.textContent='Instalar e configurar'}}
    return true;
  }
  return false;
}
$('#modalContent').addEventListener('click',async event=>{
  if(await peclBuildAction(event))return;
  const pecl=event.target.closest('.pecl-versions');
  if(pecl){
    const root=pecl.dataset.root;const runtime=dllRuntimeList().find(item=>item.root===root)||selectedDllRuntime();
    closeModal();showPeclVersions(pecl.dataset.dll,runtime);return;
  }
  const inspect=event.target.closest('.inspect-missing-dlls');if(!inspect)return;
  const root=inspect.dataset.dllRoot;
  closeModal();openVersionDetail(root,'dlls');
  const filter=$('#dllStatusFilter');if(filter)filter.value='missing';
  renderDllRegistry();
});

function extensionsModalGrid(filter=''){
  const loaded=state.liveStatus?.phpCli?.extensions;
  const list=Array.isArray(loaded)?loaded:[];
  const filtered=list.filter(name=>name.toLowerCase().includes(filter.trim().toLowerCase()));
  if(!state.apiAvailable)return '<div class="empty-state"><strong>Agente local desconectado</strong><p>Inicie o agente com start.ps1 para ler as extensões do PHP.</p></div>';
  if(!list.length)return '<div class="empty-state"><strong>Nenhuma extensão lida</strong><p>O agente não informou a lista de extensões deste PHP CLI.</p></div>';
  return filtered.map(name=>`<div class="extension-item"><span class="extension-check">✓</span><span><strong>${escapeHtml(name)}</strong><small>Carregada pelo PHP CLI</small></span><span class="extension-tag">CLI</span></div>`).join('')||`<div class="empty-state"><strong>${escapeHtml(filter.trim())} não está carregada neste PHP</strong><p>Use “Ir para versões do PHP” para buscar a DLL compatível e instalar.</p></div>`;
}
function showExtensionsModal(){
  const php=state.liveStatus?.phpCli;
  const buildInfo=php?.version?`PHP ${escapeHtml(php.version)} · ${escapeHtml(php.threadSafety||'—')} · ${escapeHtml(php.architecture||'—')}`:'PHP ainda não lido';
  const total=Array.isArray(php?.extensions)?php.extensions.length:0;
  showModal('EXTENSÕES PHP',`<h2>Extensões carregadas ${total?`<span class="modal-count">· ${total}</span>`:''}</h2><p class="modal-copy">${buildInfo}. A lista reflete o PHP CLI; a compatibilidade com o módulo Apache é validada separadamente.</p><label class="search-box extension-modal-search"><span aria-hidden="true">⌕</span><input id="extensionModalSearch" type="search" maxlength="80" placeholder="Filtrar extensão" autocomplete="off" aria-label="Filtrar extensões carregadas"></label><div class="extension-grid extension-modal-grid" id="extensionModalGrid">${extensionsModalGrid('')}</div><div class="modal-note">Para instalar uma extensão nova, abra uma versão do PHP e use a aba <strong>DLLs e extensões</strong>.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button><button class="primary-button" id="extensionModalInstall">Ir para versões do PHP <span>→</span></button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#extensionModalSearch').addEventListener('input',event=>{$('#extensionModalGrid').innerHTML=extensionsModalGrid(event.target.value)});
  $('#extensionModalInstall').onclick=()=>{closeModal();navigate('php')};
}
$('#openExtensionsModal').addEventListener('click',showExtensionsModal);
function dllKindLabel(kind){
  return {php_extension:'Extensão PHP',zend_extension:'Extensão Zend',apache_module:'Módulo Apache',php_thread_safe:'Runtime TS do PHP',apache_load_file:'Dependência do Apache'}[kind]||'DLL';
}
function dllRegistryEntries(){
  const registry=state.dllRegistry;
  const runtime=selectedDllRuntime();
  const source=runtime?.dllCheck?.details||registry?.dlls||[];
  return source.map(item=>({...item,present:Boolean(item.found??item.present)}));
}
function dllInventoryText(){
  const registry=state.dllRegistry;
  const runtime=selectedDllRuntime();
  const lines=[`XAMPP Studio · DLLs registradas`,`Versão analisada: PHP ${runtime?.version||registry?.phpVersion||'—'}`,`Runtime: ${runtime?.root||registry?.phpRoot||'—'}`,`Registro base: PHP ${registry?.phpVersion||'—'} · ${registry?.apacheConfig||'php.ini + Apache'}`,`Atualizado: ${registry?.updatedAt||registry?.checkedAt||'—'}`,''];
  for(const item of dllRegistryEntries().sort((a,b)=>String(a.dll).localeCompare(String(b.dll)))) lines.push(`${item.present?'presente':'AUSENTE'}  ${item.dll}  (${dllKindLabel(item.kind)}${item.sources?.length?` · ${item.sources.join(', ')}`:''})  ${item.path||''}`.trim());
  return lines.join('\r\n');
}
function renderDllRegistry(){
  const registry=state.dllRegistry;
  const runtime=selectedDllRuntime();
  if(!registry){
    $('#dllRegistryTitle').textContent='Registro ainda não carregado.';
    $('#dllRegistryCopy').textContent='Conecte o agente local para registrar as DLLs do php.ini e do Apache.';
    $('#dllRegistryChip').textContent='AGUARDANDO AGENTE';
    $('#dllRegistryNotice').classList.remove('green-notice','danger-notice');$('#dllRegistrySymbol').textContent='i';
    $('#dllRegistrySummary').innerHTML='<span>Nenhum registro lido.</span>';
    $('#dllRegistryChecked').textContent='';
    $('#dllRegistryList').innerHTML='<div class="empty-state"><strong>Registro ainda não carregado</strong><p>Abra o agente local para ler as DLLs ativas no XAMPP.</p></div>';
    return;
  }
  const dlls=dllRegistryEntries();
  const missing=dlls.filter(item=>!item.present);
  const notice=$('#dllRegistryNotice');notice.classList.toggle('danger-notice',Boolean(missing.length));notice.classList.toggle('green-notice',Boolean(dlls.length)&&!missing.length);$('#dllRegistrySymbol').textContent=missing.length?'!':dlls.length?'✓':'i';
  const version=runtime?.version||registry.phpVersion||'—';
  const runtimeRoot=runtime?.root||registry.phpRoot||'—';
  const isCurrent=Boolean(runtime?.current);
  const query=($('#dllSearch')?.value||'').trim().toLowerCase();
  const statusFilter=$('#dllStatusFilter')?.value||'all';
  const filtered=dlls.filter(item=>{
    if(statusFilter==='present'&&!item.present)return false;
    if(statusFilter==='missing'&&item.present)return false;
    if(!query)return true;
    return [item.dll,item.name,item.kind,dllKindLabel(item.kind),item.directive,item.path,(item.sources||[]).join(' ')].join(' ').toLowerCase().includes(query);
  });
  $('#dllRegistryTitle').textContent=missing.length?`${missing.length} DLL(s) registrada(s) não existem no PHP ${version}.`:`${isCurrent?'DLLs registradas e verificadas no PHP ativo.':`Todas as ${dlls.length} DLLs registradas existem nesta versão.`}`;
  $('#dllRegistryCopy').textContent=`PHP ${version}${isCurrent?' (em uso)':''} · ${runtimeRoot} · registro base em PHP ${registry.phpVersion||'—'}. A troca de versão continua bloqueada se qualquer DLL registrada faltar no destino.`;
  $('#dllRegistryChip').textContent=missing.length?`${missing.length} AUSENTE(S)`:dlls.length?'ARQUIVOS PRESENTES':'SEM REGISTRO';
  if(!dlls.length)$('#dllRegistryTitle').textContent='Nenhuma dependência registrada para conferir.';
  $('#dllRegistryChip').classList.toggle('danger-chip',Boolean(missing.length));
  $('#dllRegistrySummary').innerHTML=`<div><small>VERSÃO ANALISADA</small><strong>PHP ${escapeHtml(version)}${isCurrent?' · em uso':''}</strong></div><div><small>DLLS REGISTRADAS</small><strong>${dlls.length}</strong></div><div><small>PRESENTES</small><strong>${dlls.length-missing.length}</strong></div><div><small>AUSENTES</small><strong>${missing.length}</strong></div>`;
  $('#dllRegistryChecked').textContent=`${filtered.length} de ${dlls.length} dependência(s) · registro de ${new Date(registry.updatedAt||registry.checkedAt||Date.now()).toLocaleString('pt-BR')}`;
  const sorted=[...filtered].sort((a,b)=>(a.present===b.present?0:a.present?1:-1)||String(a.dll).localeCompare(String(b.dll)));
  $('#dllRegistryList').innerHTML=sorted.map(item=>`<article class="dll-registry-row ${item.present?'present':'missing'}"><span class="dll-registry-icon">${item.present?'✓':'!'}</span><div class="dll-registry-main"><strong>${escapeHtml(item.dll)}</strong><small>${escapeHtml(dllKindLabel(item.kind))}${item.directive?` · ${escapeHtml(item.directive)}`:''} · ${escapeHtml((item.sources||[]).join(', ')||'ambiente')}${!item.present&&item.kind==='php_extension'?` · <button class="pecl-link" type="button" data-dll="${escapeHtml(item.dll)}">versões PECL</button>`:''}</small></div><span class="dll-registry-state">${item.present?'presente':'ausente'}</span><span class="dll-registry-path" title="${escapeHtml(item.path||'')}">${escapeHtml(item.path||(item.present?'localizada':'não localizada neste runtime'))}</span></article>`).join('')||`<div class="empty-state"><strong>${dlls.length?'Nenhuma DLL corresponde ao filtro':'Nenhuma DLL registrada'}</strong><p>${dlls.length?'Ajuste a busca ou o estado selecionado.':'Ative extensões no php.ini e atualize o registro.'}</p></div>`;
  bindFindMissingDlls();
}
async function loadDllRegistry(){
  try{const result=await requestApi('/api/dlls');state.dllRegistry=result.registry;renderVersionDetail();renderDllRegistry()}
  catch(error){state.dllRegistry=null;renderVersionDetail();renderDllRegistry();toast(`Não foi possível ler o registro de DLLs: ${error.message}`,true)}
}
async function searchMissingDllsForRuntime(runtime){
  if(!runtime||!runtime.root){toast('Abra a configuração de uma versão antes de buscar DLLs.',true);return}
  if(!state.apiAvailable){toast('Inicie o agente local para buscar DLLs ausentes.',true);return}
  showModal('LOCALIZAR DLLS AUSENTES',`<h2>Buscar DLLs de PHP ${escapeHtml(runtime.version||'—')}</h2><p class="modal-copy">O Studio procura cópias nos runtimes instalados e pacotes de extensão no catálogo PIE.</p><div class="catalog-loading">Procurando DLLs locais e pacotes publicados…</div>`);
  try{
    const result=await requestApi('/api/dlls/search',{method:'POST',body:JSON.stringify({phpRoot:runtime.root})});
    state.missingDllSearch=result;
    const missing=result.check?.missing||[];
    if(!missing.length){$('#modalContent').innerHTML=`<h2>Nenhuma DLL ausente.</h2><p class="modal-copy">PHP ${escapeHtml(runtime.version||'—')} tem todas as DLLs registradas pelo ambiente.</p><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button></div>`;$('#cancelAction').onclick=closeModal;return}
    const cards=missing.map(item=>{
      const key=String(item.dll).toLowerCase();
      const local=(result.local||[]).filter(entry=>String(entry.dll).toLowerCase()===key);
      const catalog=(result.catalog||[]).find(entry=>String(entry.dll).toLowerCase()===key);
      const exact=local.some(entry=>entry.sameVersion);
      const localHtml=local.length?local.map(entry=>`<div class="missing-dll-local"><small>Encontrada em PHP ${escapeHtml(entry.sourceVersion||'runtime')}${entry.sameVersion?' · mesma versão':''}${entry.threadSafety?` · ${escapeHtml(entry.threadSafety)}`:''}${entry.architecture?` · ${escapeHtml(entry.architecture)}`:''}</small><code>${escapeHtml(entry.path)}</code></div>`).join(''):'<div class="catalog-context">Nenhuma cópia local encontrada nos runtimes instalados.</div>';
      const packages=catalog?.packages?.length?`<div class="missing-dll-packages">${catalog.packages.map(pkg=>`<a class="missing-dll-package" href="${escapeHtml(safeUrl(pkg.url))}" target="_blank" rel="noreferrer">${escapeHtml(pkg.name)} ↗</a>`).join('')}</div>`:catalog?.error?`<div class="catalog-context">Catálogo indisponível: ${escapeHtml(catalog.error)}</div>`:'';
      const pecl=item.kind==='php_extension'?`<div class="missing-dll-actions"><button class="outline-button small-button pecl-versions" type="button" data-dll="${escapeHtml(item.dll)}" data-root="${escapeHtml(runtime.root)}">Buscar versões no PECL <span>→</span></button></div>`:'';
      return `<article class="missing-dll-card"><div class="missing-dll-card-head"><strong>${escapeHtml(item.dll)}</strong><span class="result-chip ${exact?'done':local.length?'warning-chip':''}">${exact?'MESMA VERSÃO':local.length?'OUTRO BUILD':'SEM CÓPIA LOCAL'}</span></div><small>${escapeHtml(dllKindLabel(item.kind))}${item.sources?.length?` · ${escapeHtml(item.sources.join(', '))}`:''}</small>${localHtml}${packages||(catalog?'<div class="catalog-context">Nenhum pacote php-ext encontrado no PIE para esta extensão.</div>':'')}${pecl}</article>`;
    }).join('');
    $('#modalContent').innerHTML=`<h2>DLLs ausentes em PHP ${escapeHtml(runtime.version||'—')}</h2><p class="modal-copy">O Studio procura cópias locais, pacotes no PIE e builds Windows no PECL. O botão de instalação automática usa o build compatível, valida a DLL e reverte a configuração se o PHP não iniciar.</p><div class="modal-note">${missing.length} dependência(s) ausente(s). Resultados locais são apenas pistas; confirme se a DLL é do mesmo build antes de reutilizá-la.</div>${cards}<div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button><button class="primary-button" id="searchMissingAgain">Buscar novamente</button></div>`;
    $('#cancelAction').onclick=closeModal;
    $('#searchMissingAgain').onclick=()=>searchMissingDllsForRuntime(runtime);
  }catch(error){
    $('#modalContent').innerHTML=`<h2>Não foi possível concluir a busca.</h2><div class="modal-note">${escapeHtml(error.message)}</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button></div>`;$('#cancelAction').onclick=closeModal;
  }
}
/** Markup das versões/builds do PECL — usado no modal e na expansão inline do catálogo. */
function peclVersionsHtml(result,dll,runtime){
  const target=result.target||{};
  const targetLabel=`PHP ${escapeHtml(target.version||runtime.version||'—')} · ${escapeHtml(String(target.threadSafety||'').toUpperCase()||'—')} · ${escapeHtml(target.compiler||'—')} · ${escapeHtml(target.architecture||'—')}`;
  const packageLink=`<a class="missing-dll-package" href="${escapeHtml(safeUrl(result.packageUrl))}" target="_blank" rel="noreferrer">${escapeHtml(result.package)} ↗</a>`;
  if(!result.releases?.length)return `${packageLink}<div class="modal-note">${escapeHtml(result.error||'O PECL não retornou versões para este pacote.')}</div>`;
  const releases=result.releases.map((release,index)=>{
    const compatible=release.compatibleBuilds||[];
    const other=(release.builds||[]).filter(build=>!build.compatible);
    const builds=compatible.length?`<div class="pecl-build-list">${compatible.map(build=>{const attributes=`data-file="${escapeHtml(build.file)}" data-dll="${escapeHtml(dll)}" data-package="${escapeHtml(result.package)}" data-root="${escapeHtml(runtime.root)}"`;return `<div class="pecl-build"><strong>${escapeHtml(build.file)}</strong><div class="detail-actions-row"><button type="button" class="primary-button small-button download-pecl-build" ${attributes}>Baixar DLL</button><button type="button" class="outline-button small-button install-pecl-build" ${attributes}>Instalar e configurar</button></div></div>`}).join('')}</div>`:'';
    const otherText=other.length?`<details class="extension-help"><summary>${other.length} builds de outra configuração</summary><p>${other.map(build=>`${escapeHtml(build.threadSafety.toUpperCase())} ${escapeHtml(build.compiler)} ${escapeHtml(build.architecture)}`).join(' · ')}</p></details>`:'';
    const status=compatible.length?`${compatible.length} COMPATÍVEL(IS)`:release.available?'SEM BUILD COMPATÍVEL':'SEM BUILD WINDOWS';
    return `<article class="pecl-release ${compatible.length?'compatible':''}"><div class="pecl-release-head"><div><strong>${escapeHtml(release.version)}</strong><small>${compatible.length?(index===0?'Mais recente · compatível':'Compatível com este PHP'):'Versão publicada no PECL'}</small></div><span class="result-chip ${compatible.length?'done':'warning-chip'}">${status}</span></div>${builds}${otherText}${release.error?`<div class="catalog-context">${escapeHtml(release.error)}</div>`:''}</article>`;
  }).join('');
  const warning=result.releases.some(release=>release.compatibleBuilds?.length)?'':'<div class="modal-note">Nenhum build compatível foi encontrado para este PHP nas versões consultadas. Abra outra versão do PHP para consultar os builds dela.</div>';
  return `${packageLink}<p class="catalog-context">Alvo: ${targetLabel}. <strong>Instalar e configurar</strong> altera o php.ini com backup e valida no PHP CLI; <strong>Baixar DLL</strong> apenas guarda na biblioteca.</p>${warning}<div class="pecl-release-list">${releases}</div>`;
}
async function showPeclVersions(dll,runtime=selectedDllRuntime(),packageName,refresh=false){
  if(!runtime?.root){toast('Abra a configuração de uma versão antes de consultar o PECL.',true);return}
  if(!state.apiAvailable){toast('Inicie o agente local para consultar o PECL.',true);return}
  showModal('PECL · VERSÕES DO DLL',`<h2>Consultar versões de ${escapeHtml(dll)}</h2><p class="modal-copy">Buscando builds Windows no PECL para PHP ${escapeHtml(runtime.version||'—')}…</p><div class="catalog-loading">Consultando o pacote e os builds oficiais…</div>`);
  try{
    const result=await requestApi('/api/pecl/versions',{method:'POST',body:JSON.stringify({phpRoot:runtime.root,dll,package:packageName||undefined,refresh})});
    if(state.dllVersionRoot!==runtime.root)return;
    $('#modalContent').innerHTML=`<h2>Versões de ${escapeHtml(dll)}</h2>${peclVersionsHtml(result,dll,runtime)}<div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button><button class="primary-button" id="peclRefresh">Atualizar versões</button></div>`;
    $('#cancelAction').onclick=closeModal;
    $('#peclRefresh').onclick=()=>showPeclVersions(dll,runtime,packageName,true);
  }catch(error){
    $('#modalContent').innerHTML=`<h2>Não foi possível consultar o PECL.</h2><div class="modal-note">${escapeHtml(error.message)}</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button></div>`;$('#cancelAction').onclick=closeModal;
  }
}
renderVersions();renderActivity();
function setServiceStatus(element,active,detail=null){
  const el=$(element);el.classList.toggle('stopped',active===false);el.classList.toggle('unavailable',active===null);
  el.innerHTML=`<i></i> ${active===null?'Sem conexão':active?(escapeHtml(detail||'Em execução')):(escapeHtml(detail||'Parado'))}`;
}
function setServiceCardStatus(element,active,detail=null){
  if(!element)return;
  element.classList.toggle('stopped',active===false);element.classList.toggle('unavailable',active===null);
  element.innerHTML=`<i></i> ${active===null?'Aguardando leitura':active?(escapeHtml(detail||'Em execução')):(escapeHtml(detail||'Parado'))}`;
}
async function loadLiveStatus(){
  try{
    const [status,installed]=await Promise.all([requestApi('/api/status'),requestApi('/api/versions')]);
    const installedVersions=Array.isArray(installed.versions)?installed.versions:[];
    const phpAvailable=Boolean(status.phpCli?.version&&!status.phpCli?.error);
    $('.php-panel').dataset.runtimeState=phpAvailable?'ready':'unavailable';
    state.apiAvailable=true;state.liveStatus=status;state.liveVersions=installedVersions;renderCatalogRuntimes();if(!state.dllRegistry)loadDllRegistry().catch(()=>{});renderApacheSummary();renderMySqlSummary();
    if(phpAvailable){$('#activeVersion').textContent=status.phpCli.version;$('#phpBuildInfo').textContent=`${status.phpCli.threadSafety||'Modo não informado'} · ${status.phpCli.architecture||'arquitetura não informada'}`;$('#activeVersionState').classList.remove('unavailable');$('#activeVersionState').innerHTML='<span></span> Leitura confirmada'}
    else{$('#activeVersion').textContent='—';$('#phpBuildInfo').textContent='PHP indisponível';$('#activeVersionState').classList.add('unavailable');$('#activeVersionState').innerHTML='<span></span> PHP indisponível'}
    $('#apacheVersionInfo').textContent=`Apache ${status.apache.version||'—'} · ${status.apache.source||'XAMPP'}`;
    $('#phpConfigInfo').textContent=phpAvailable?(status.phpIni||'Configuração não informada'):'PHP indisponível';
    const apacheDetail=status.apache.running?'Em execução':status.apache.portActive&&!status.apache.portOwnedByStudio?'Porta ocupada por outro processo':'Parado';
    const mysqlDetail=status.mysql.running?'Em execução':status.mysql.portActive&&!status.mysql.portOwnedByStudio?'Porta ocupada por outro processo':'Parado';
    setServiceStatus('#apacheState',status.apache.running,apacheDetail);setServiceStatus('#mysqlState',status.mysql.running,mysqlDetail);
    const apachePortLabel=$('#apachePortLabel');
    if(apachePortLabel)apachePortLabel.textContent=String(status.apache.port||80);
    const overviewPort=$$('.service-list .port')[0];
    if(overviewPort)overviewPort.textContent=`:${status.apache.port||80}`;
    const serviceStates=$$('.service-cards .service-state');setServiceCardStatus(serviceStates[0],status.apache.running,apacheDetail);setServiceCardStatus(serviceStates[1],status.mysql.running,mysqlDetail);configureServiceActions(status.serviceControl);
    $('#mysqlConnection').innerHTML=`<i></i> ${status.mysql.running?'Porta respondendo':'Porta sem resposta'}`;$('#mysqlConnection').classList.toggle('disconnected',!status.mysql.running);
    $('#liveStatusLabel').innerHTML='<span></span> LEITURA LOCAL ATIVA';
    const runningServices=[status.apache.running,status.mysql.running].filter(Boolean).length;
    $('#integrityScore').textContent=`${runningServices}/2`;
    $('#integrityTitle').textContent=runningServices===2?'Serviços em execução':runningServices===1?'Um serviço em execução':'Serviços parados';
    $('#integrityDescription').textContent=`Apache ${status.apache.running?'rodando':'parado'} · MySQL ${status.mysql.running?'rodando':'parado'}`;
    $('.ring-value').style.strokeDashoffset=String(264*(1-runningServices/2));
    $('.ring-value').style.stroke=runningServices===2?'var(--ok)':'var(--warn)';
    const banner=$('#connectionBanner');if(banner){const bannerState=phpAvailable?'connected':'attention';if(banner.dataset.state!==bannerState)banner.hidden=false;banner.dataset.state=bannerState;banner.classList.add('connected-banner');banner.classList.toggle('attention-banner',!phpAvailable);banner.innerHTML=phpAvailable?'<span class="demo-icon">✓</span><span><strong>Agente conectado</strong> · Leitura local atualizada.</span><button id="bannerClose" aria-label="Fechar aviso">×</button>':'<span class="demo-icon">!</span><span><strong>PHP ativo indisponível</strong> · O agente está conectado. Abra uma versão instalada para revisar o ambiente.</span><button id="bannerClose" aria-label="Fechar aviso">×</button>';$('#bannerClose').onclick=()=>{banner.hidden=true}}
    const live=state.liveVersions.map(v=>({...v,channel:v.current&&phpAvailable?'Em uso':'Instalada',arch:v.architecture||status.phpCli?.architecture||'desconhecida',ts:v.threadSafety||status.phpCli?.threadSafety||'desconhecido',note:v.current&&phpAvailable?'PHP carregado pelo XAMPP':`Runtime em ${v.root}`,size:'local'}));
    state.versions=live;renderVersions();renderVersionDetail();if(state.dllRegistry)renderDllRegistry();
    const currentVersion=phpAvailable?status.phpCli.version:null;
    const alternatives=installedVersions.filter(v=>v.version!==currentVersion);
    $('#phpVersionCount').textContent=String(installedVersions.length);
    $('#phpVersionCenter').innerHTML=currentVersion?`${escapeHtml(currentVersion)} <small>ATUAL</small>`:'—';
    $('#phpVersionLeft').textContent=alternatives[0]?.version||'sem outras';
    $('#phpVersionRight').textContent=alternatives[1]?.version||`${alternatives.length} alternativa(s)`;
    const cliExtensions=Array.isArray(status.phpCli?.extensions)?status.phpCli.extensions:null;
    $('.extensions-count strong').textContent=cliExtensions?String(cliExtensions.length):'—';
    $('.extensions-count>span:nth-child(2)').textContent='carregadas no CLI';
    $('.extensions-count>span:last-child').textContent=cliExtensions?'detectadas no runtime':'inventário indisponível';
    $('#extensionDataFooter').innerHTML=cliExtensions?'<span class="tiny-check">✓</span> Extensões lidas do PHP CLI local':'<span class="tiny-check">·</span> Leitura de extensões indisponível';
    const tags=cliExtensions||[];
    $('.extension-tags').innerHTML=cliExtensions?([...tags.slice(0,5).map(name=>`<span>${escapeHtml(name)}</span>`),...(tags.length>5?[`<span class="tag-more">+${tags.length-5}</span>`]:[])].join('')||'<span>nenhuma carregada</span>'):'<span>sem leitura disponível</span>';
  }catch(error){
    state.apiAvailable=false;
    $('.php-panel').dataset.runtimeState='offline';
    $('#activeVersionState').classList.add('unavailable');
    $('.ring-value').style.strokeDashoffset='264';
    state.liveStatus=null;
    state.liveVersions=[];
    state.versions=[];
    $('#liveStatusLabel').innerHTML='<span></span> AGUARDANDO AGENTE';
    $('#integrityScore').textContent='—';$('#integrityTitle').textContent='Sem conexão com o agente';$('#integrityDescription').textContent='Inicie start.ps1 para ler o ambiente real.';
    $('#activeVersion').textContent='—';$('#activeVersionState').innerHTML='<span></span> Sem leitura local';$('#phpBuildInfo').textContent='Aguardando leitura local';$('#apacheVersionInfo').textContent='Aguardando leitura local';$('#phpConfigInfo').textContent='Aguardando leitura local';$('#phpVersionLeft').textContent='aguardando';$('#phpVersionCenter').textContent='—';$('#phpVersionRight').textContent='leitura';$('.extensions-count strong').textContent='—';$('.extensions-count>span:nth-child(2)').textContent='PHP CLI';$('.extensions-count>span:last-child').textContent='aguardando leitura local';$('.extension-tags').innerHTML='<span>aguardando agente local</span>';$('#extensionDataFooter').innerHTML='<span class="tiny-check">·</span> Sem dados até conectar ao agente';
    setServiceStatus('#apacheState',null);setServiceStatus('#mysqlState',null);
    $$('.service-cards .service-state').forEach(el=>setServiceCardStatus(el,null));
    $('#phpVersionCount').textContent='—';$('#apacheVersionCount').textContent='—';$('#mysqlVersionCount').textContent='—';
    renderVersions();renderVersionDetail();
    $('#mysqlConnection').innerHTML='<i></i> Sem conexão';$('#mysqlConnection').classList.add('disconnected');
    const banner=$('#connectionBanner');if(banner){if(banner.dataset.state!=='offline')banner.hidden=false;banner.dataset.state='offline';banner.classList.remove('connected-banner','attention-banner');const fileMode=location.protocol==='file:';banner.innerHTML=`<span class="demo-icon">i</span><span><strong>${fileMode?'Página aberta como arquivo':'Agente local desconectado'}</strong> · ${fileMode?'Execute <code>start.ps1</code> e abra <code>http://127.0.0.1:43197</code>. O navegador bloqueia ações locais nesta visualização.':'Inicie com <code>start.ps1</code> para ler o XAMPP e habilitar as ações locais.'}</span><button id="bannerClose" aria-label="Fechar aviso">×</button>`;$('#bannerClose').onclick=()=>{banner.hidden=true}}
  }
}
loadLiveStatus();
$('#refreshStatus').addEventListener('click',async()=>{
  const button=$('#refreshStatus');
  await withPending(button,'Lendo',async()=>{
    await loadLiveStatus();
    toast(state.apiAvailable?'Leitura local atualizada.':'Agente local indisponível; inicie start.ps1.',!state.apiAvailable);
  });
});
$('#diagnosticsButton').addEventListener('click',async()=>{
  const button=$('#diagnosticsButton');
  try{
    if(!state.apiAvailable){toast('Agente local indisponível; inicie start.ps1.',true);return}
    await withPending(button,'Gerando',async()=>{
      const response=await fetch('/api/diagnostics/export',{headers:{Accept:'text/markdown'}});
      if(!response.ok)throw new Error(`O agente respondeu ${response.status}`);
      const text=await response.text();
      const blob=new Blob([text],{type:'text/markdown;charset=utf-8'});
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');
      link.href=url;
      link.download=`diagnostico-xampp-studio-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),4000);
      recordActivity('Diagnóstico exportado','Versões, hashes, serviços, portas, compatibilidade e logs em um arquivo Markdown','Concluído');
      toast('Diagnóstico exportado.');
    });
  }catch(error){toast(`Não consegui exportar o diagnóstico: ${error.message}`,true)}
});
$('#refreshDllRegistry').addEventListener('click',async()=>{
  if(!state.apiAvailable){toast('Inicie o agente local para registrar as DLLs do XAMPP.',true);return}
  const button=$('#refreshDllRegistry');button.disabled=true;button.textContent='Lendo…';
  try{const result=await requestApi('/api/dlls/refresh',{method:'POST',body:'{}'});state.dllRegistry=result.registry;await loadLiveStatus();renderVersionDetail();renderDllRegistry();toast(`Registro atualizado: ${result.registry.dlls.length} DLL(s) em uso.`)}
  catch(error){toast(`Não foi possível atualizar o registro: ${error.message}`,true)}
  finally{button.disabled=false;button.textContent='⟳ Atualizar'}
});
$('#dllStatusFilter').addEventListener('change',()=>renderDllRegistry());
$('#dllSearch').addEventListener('input',()=>renderDllRegistry());
$('#dllRegistryList').addEventListener('click',event=>{const button=event.target.closest('.pecl-link');if(!button)return;showPeclVersions(button.dataset.dll,selectedDllRuntime())});
$('#copyDllRegistry').addEventListener('click',async()=>{
  if(!state.dllRegistry){toast('O registro de DLLs ainda não foi carregado.',true);return}
  try{await navigator.clipboard.writeText(dllInventoryText());toast('Inventário de DLLs copiado para a área de transferência.')}
  catch{toast('O navegador bloqueou a cópia automática do inventário.',true)}
});
let catalogSearchSequence=0;
function resetVersionCatalog(){
  catalogSearchSequence++;
  state.catalogPackages=[];
  state.catalogRoot=null;
  $('#catalogQuery').value='';
  $('#catalogResults').innerHTML='';
  $('#catalogResults').setAttribute('aria-busy','false');
  $('#catalogForm button').textContent='Buscar';
  $('#extensionDownloadCount').textContent='0';
  $('#catalogContext').textContent='A busca e os downloads usam exclusivamente esta versão do PHP.';
  $('#extensionDownloads').innerHTML='';
}
function catalogRuntime(){return dllRuntimeList().find(runtime=>runtime.root===state.dllVersionRoot)||null}
function renderCatalogRuntimes(){
  const runtime=catalogRuntime();
  $('#catalogRuntime').innerHTML=runtime?`<strong>PHP ${escapeHtml(runtime.version)}</strong><code>${escapeHtml(runtime.root)}</code>`:'Abra uma versão do PHP para buscar DLLs.';
  $('#catalogForm button').disabled=!runtime||$('#catalogResults').getAttribute('aria-busy')==='true';
}
async function loadExtensionDownloads(){
  const runtime=catalogRuntime();
  if(!runtime)return;
  const root=runtime.root;
  $('#extensionDownloads').setAttribute('aria-busy','true');
  try{
    const result=await requestApi(`/api/extensions/downloads?phpRoot=${encodeURIComponent(root)}`);
    if(state.dllVersionRoot!==root)return;
    const grouped=new Map();
    for(const item of result.downloads){const key=`${item.dll}|${item.build}`.toLowerCase();const existing=grouped.get(key);if(existing)existing.copies++;else grouped.set(key,{...item,copies:1})}
    const downloads=[...grouped.values()];
    $('#extensionDownloadCount').textContent=downloads.length;
    $('#extensionDownloads').innerHTML=downloads.map(item=>`<article class="download-row"><span class="download-icon" aria-hidden="true">DLL</span><div class="download-row-main"><strong>${escapeHtml(item.dll)}</strong><small>v${escapeHtml(item.version)} · PHP ${escapeHtml(item.phpVersion)} · ${escapeHtml(item.threadSafety)} · ${escapeHtml(item.architecture)}${item.copies>1?` · ${item.copies} downloads`:''}</small></div><div class="download-row-actions"><a class="outline-button small-button" href="${escapeHtml(item.downloadUrl)}" download aria-label="Salvar ${escapeHtml(item.dll)} versão ${escapeHtml(item.version)}">Salvar DLL</a><a class="text-action" href="${escapeHtml(item.archiveUrl)}" download aria-label="Salvar ZIP de ${escapeHtml(item.dll)} versão ${escapeHtml(item.version)}">ZIP completo ↗</a></div></article>`).join('')||'<div class="download-empty"><span class="download-icon" aria-hidden="true">↓</span><div><strong>Sua biblioteca começa aqui</strong><small>As DLLs baixadas para este PHP aparecerão nesta lista.</small></div></div>';
    $('#extensionDownloads').setAttribute('aria-busy','false');
  }catch(error){if(state.dllVersionRoot===root){$('#extensionDownloads').setAttribute('aria-busy','false');$('#extensionDownloads').innerHTML=`<div class="modal-note">${escapeHtml(error.message)}</div>`}}
}
$('#refreshExtensionDownloads').addEventListener('click',()=>withPending($('#refreshExtensionDownloads'),'Atualizando…',loadExtensionDownloads));
$$('[data-extension-query]').forEach(button=>button.addEventListener('click',()=>{$('#catalogQuery').value=button.dataset.extensionQuery;$('#catalogForm').requestSubmit()}));
$('#catalogForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const runtime=catalogRuntime();
  if(!runtime){toast('Abra uma versão do PHP antes de pesquisar.',true);return}
  const searchSequence=++catalogSearchSequence;
  const query=$('#catalogQuery').value.trim();
  const results=$('#catalogResults');
  if(query.length<2){toast('Digite pelo menos 2 caracteres para buscar.',true);return}
  const searchButton=$('#catalogForm button');
  searchButton.disabled=true;searchButton.innerHTML='<span class="spinner" aria-hidden="true"></span> Buscando…';
  results.setAttribute('aria-busy','true');
  results.innerHTML='<div class="catalog-loading">Consultando PECL e Packagist…</div>';
  try{
    const result=await requestApi(`/api/extensions/search?q=${encodeURIComponent(query)}`);
    if(state.dllVersionRoot!==runtime.root||searchSequence!==catalogSearchSequence)return;
    state.catalogPackages=result.packages;state.catalogRoot=runtime.root;
    $('#catalogContext').textContent=`${result.packages.length} pacote(s) · ${result.source}${result.normalizedQuery!==query?` · busca: ${result.normalizedQuery}`:''}${result.warnings?.length?` · ${result.warnings.join(' ')}`:''} · consultado em ${new Date(result.checkedAt).toLocaleTimeString('pt-BR')} · PHP de destino ${runtime.version}`;
    results.innerHTML=result.packages.map((pkg,index)=>`<article class="catalog-package"><div class="catalog-package-main"><div class="catalog-package-title"><strong>${escapeHtml(pkg.name)}</strong><span>${escapeHtml(pkg.source||'Packagist')}</span></div><p>${escapeHtml(pkg.description)}</p><small>${pkg.source?.startsWith('PECL')?'Build Windows consultado por runtime':`${pkg.downloads.toLocaleString('pt-BR')} downloads`}</small></div><div class="catalog-package-actions">${pkg.extension?`<button class="primary-button small-button catalog-builds" type="button" data-index="${index}" aria-expanded="false">Ver versões compatíveis <span aria-hidden="true">⌄</span></button>`:''}${pkg.name.includes('/')?`<button class="outline-button small-button catalog-prepare" type="button" data-index="${index}">Comando PIE</button>`:''}<a class="text-action" href="${escapeHtml(safeUrl(pkg.url))}" target="_blank" rel="noopener noreferrer">Ver pacote ↗</a></div></article>`).join('')||'<div class="empty-state"><strong>Nenhum pacote encontrado</strong><p>Tente redis, xdebug ou opentelemetry. Nem toda extensão tem um pacote Windows.</p></div>';
  }catch(error){
    if(state.dllVersionRoot!==runtime.root||searchSequence!==catalogSearchSequence)return;
    $('#catalogContext').textContent='O catálogo precisa de conexão com a internet e do agente local.';
    results.innerHTML=`<div class="empty-state"><strong>Não foi possível buscar</strong><p>${escapeHtml(error.message)}. Inicie start.ps1 e tente novamente.</p></div>`;
  }finally{if(searchSequence===catalogSearchSequence){results.setAttribute('aria-busy','false');searchButton.disabled=!catalogRuntime();searchButton.textContent='Buscar'}}
});
/** Expande as versões/builds do pacote dentro da própria lista de resultados. */
async function toggleCatalogBuilds(button){
  const runtime=catalogRuntime();
  const pkg=state.catalogPackages[Number(button.dataset.index)];
  if(!runtime||state.catalogRoot!==runtime.root||!pkg?.extension)return;
  const article=button.closest('.catalog-package');
  const existing=article.querySelector('.catalog-builds-holder');
  if(existing){existing.remove();button.setAttribute('aria-expanded','false');button.innerHTML='Ver versões compatíveis <span aria-hidden="true">⌄</span>';return}
  const dll=`php_${pkg.extension}.dll`;
  button.disabled=true;button.setAttribute('aria-expanded','true');button.innerHTML='<span class="spinner" aria-hidden="true"></span> Buscando…';
  const holder=document.createElement('div');
  holder.className='catalog-builds-holder';
  holder.innerHTML='<div class="catalog-loading">Consultando builds compatíveis…</div>';
  article.appendChild(holder);
  try{
    const result=await requestApi('/api/pecl/versions',{method:'POST',body:JSON.stringify({phpRoot:runtime.root,dll,package:pkg.extension})});
    if(!holder.isConnected)return;
    holder.innerHTML=peclVersionsHtml(result,dll,runtime);
    button.innerHTML='Ocultar versões <span aria-hidden="true">⌄</span>';
  }catch(error){
    if(!holder.isConnected)return;
    holder.innerHTML=`<div class="modal-note">${escapeHtml(error.message)}</div>`;
    button.innerHTML='Ver versões compatíveis <span aria-hidden="true">⌄</span>';
  }finally{button.disabled=false}
}
$('#catalogResults').addEventListener('click',async event=>{
  const runtime=catalogRuntime();
  if(!runtime||state.catalogRoot!==runtime.root)return;
  const builds=event.target.closest('.catalog-builds');
  if(builds){await toggleCatalogBuilds(builds);return}
  if(await peclBuildAction(event))return;
  const button=event.target.closest('.catalog-prepare');if(!button)return;
  const pkg=state.catalogPackages[Number(button.dataset.index)];if(!pkg)return;
  const phpExe=`${runtime.root}\\php.exe`;
  const command=`pie install --with-php-path="${phpExe}" ${pkg.name}`;
  showModal('COMANDO PIE · PRÉVIA',`<h2>Preparar ${escapeHtml(pkg.name)}</h2><p class="modal-copy">Este comando aponta para o PHP aberto nesta tela. Confirme no Packagist a versão mínima e a disponibilidade de DLL compatível com ${escapeHtml(runtime.version)} antes de executá-lo.</p><pre class="sql-preview">${escapeHtml(command)}</pre><div class="modal-note">O XAMPP Studio não executa este comando nem altera arquivos. No Windows, o PIE pode exigir uma DLL pré-compilada para a versão, arquitetura e modo Thread Safe exatos.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button><button class="primary-button" id="copyPieCommand">Copiar comando</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#copyPieCommand').onclick=async()=>{try{await navigator.clipboard.writeText(command);closeModal();toast('Comando copiado. Revise a compatibilidade antes de executar.')}catch{toast('Não foi possível copiar automaticamente; selecione o comando para copiá-lo.',true)}};
});

['#importSqlButton','#importSqlButton2','#importSqlButton3'].forEach(s=>$(s).addEventListener('click',()=>$('#sqlInput').click()));
$('#sqlInput').addEventListener('change',e=>{const file=e.target.files[0];if(file)readSql(file);e.target.value=''});
function reviewSqlText(text){
  const checks=[
    ['DROP DATABASE',/\bDROP\s+DATABASE\b/i],['DROP TABLE',/\bDROP\s+TABLE\b/i],['TRUNCATE',/\bTRUNCATE\s+(?:TABLE\s+)?[`\w]/i],['DELETE sem WHERE',/\bDELETE\s+FROM\s+[^;]+;/ig]
  ];
  const risks=[];
  for(const [label,re] of checks){const matches=text.match(re)||[];if(label==='DELETE sem WHERE'){const statements=text.match(/DELETE\s+FROM\s+[^;]+;/ig)||[];if(statements.some(s=>!/\bWHERE\b/i.test(s)))risks.push(label)}else if(matches.length)risks.push(`${label} (${matches.length})`)}
  return risks;
}
function readSql(file){
  if(!file.name.toLowerCase().endsWith('.sql')){toast('Escolha um arquivo .sql para continuar.',true);return}
  if(file.size>2*1024*1024){toast('O arquivo excede o limite local de 2 MB.',true);return}
  const reader=new FileReader();reader.onload=()=>{state.sqlFile=file;state.sqlText=String(reader.result||'');showSqlReview()};reader.onerror=()=>toast('Não foi possível ler o arquivo SQL.',true);reader.readAsText(file);
}
async function showSqlReview(){
  const file=state.sqlFile,text=state.sqlText;let analysis=reviewSqlText(text);
  if(state.apiAvailable){try{analysis=(await requestApi('/api/sql/analyze',{method:'POST',body:JSON.stringify({sql:text})})).risks.map(r=>r.operation)}catch{}}
  const risks=analysis,statements=(text.match(/;/g)||[]).length;
  const warning=risks.length?`<div class="risk-list">${risks.map(r=>`<div class="risk-item"><span>⚠</span> Operação delicada encontrada: ${escapeHtml(r)}. Revise antes de executar.</div>`).join('')}</div>`:'<div class="checklist"><div><i>✓</i> Nenhuma operação destrutiva comum detectada na análise inicial</div></div>';
  showModal('PRÉVIA DA MIGRAÇÃO',`<h2>Revisar antes de importar</h2><p class="modal-copy">Confira o conteúdo antes de executar qualquer alteração. O backup disponível neste app cobre configurações do XAMPP, não o banco.</p><div class="file-summary"><span class="file-type-icon">SQL</span><span><strong>${escapeHtml(file.name)}</strong><small>${(file.size/1024).toFixed(1)} KB · aproximadamente ${statements} instruções</small></span></div>${warning}<pre class="sql-preview">${escapeHtml(text.slice(0,2400))}${text.length>2400?'\n… (prévia limitada)':''}</pre><div class="modal-note">Esta etapa só analisa o texto. Nenhum comando SQL será enviado ao MySQL. Para executar, use uma ferramenta de banco após criar um backup do próprio banco.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar prévia</button><button class="primary-button" id="previewSql">${risks.length?'Manter para revisão':'Concluir análise'} <span>→</span></button></div>`);
  $('#cancelAction').onclick=closeModal;$('#previewSql').onclick=()=>{recordActivity('Arquivo SQL analisado',`${file.name} · ${statements} instruções · nenhuma alteração executada`,'Análise');closeModal();toast(risks.length?'Arquivo mantido para revisão. Operações SQL não foram executadas.':'Prévia analisada. Nada foi executado no banco.')};
}

$('#backupButton').addEventListener('click',async()=>{if(!state.apiAvailable){toast('Inicie o XAMPP Studio com start.ps1 para criar uma cópia real dos arquivos de configuração.',true);return}try{const result=await requestApi('/api/backup',{method:'POST',body:'{}'});$('#lastBackupLabel').textContent=`${new Date(result.createdAt).toLocaleString('pt-BR')} · ${result.files.length} arquivos`;recordActivity('Backup de configuração criado',`${result.files.length} arquivo(s) · ${result.files.map(f=>f.name).join(', ')}`);toast(`Backup criado: ${result.files.map(f=>f.name).join(', ')}. Cópia salva na pasta backups.`)}catch(error){toast(`Não foi possível criar o backup: ${error.message}`,true)}});
function renderActivity(){
  const table=$('#activityTable');if(!table)return;
  const header='<div class="activity-row activity-head"><span>EVENTO</span><span>DETALHES</span><span>QUANDO</span><span>ESTADO</span></div>';
  const rows=state.activity.map(item=>`<div class="activity-row"><span class="event-cell"><i class="event-icon check-event">·</i> ${escapeHtml(item.event)}</span><span class="detail-cell">${escapeHtml(item.details)}</span><span class="time-cell">${new Date(item.at).toLocaleString('pt-BR')}</span><span class="result-chip done">${escapeHtml(item.status)}</span></div>`).join('');
  table.innerHTML=header+(rows||'<div class="activity-row"><span class="event-cell"><i class="event-icon check-event">·</i> Nenhuma ação registrada</span><span class="detail-cell">Backups, downloads preparados e reinícios aparecerão aqui.</span><span class="time-cell">—</span><span class="result-chip done">—</span></div>');
}
function configureServiceActions(serviceControl){
  for(const component of ['apache','mysql']){
    const control=serviceControl?.[component],buttons=$$(`[data-service="${component}"]`);
    const stable=control?.managed&&[1,4].includes(control.state);
    const canIntegrate=control?.supported&&control.registered===false;
    const migration=stable&&!control.running&&control.portManaged;
    const blocked=stable&&!control.running&&control.portActive&&!control.portManaged;
    const port=component==='apache'?80:3306;
    for(const button of buttons){
      button.dataset.action=migration?'migration':blocked?'blocked':stable?'restart':canIntegrate?'integrate':control?.managed?'pending':'unavailable';
      button.disabled=migration||blocked||Boolean(control?.managed&&!stable)||(!stable&&!canIntegrate);
      button.textContent=migration?'Instância ativa':blocked?`Porta ${port} ocupada`:stable?(control.running?'Reiniciar':'Iniciar'):canIntegrate?'Integrar ao Studio':control?.managed?'Aguardando serviço':'Indisponível';
      button.title=migration?'O serviço está integrado, mas a porta ainda pertence a uma instância do runtime integrado.':blocked?`A porta ${port} está ocupada por ${control.portSummary||'outro processo'} e não pelo XAMPP Studio. Libere a porta para iniciar o serviço.`:stable?`Controlado pelo serviço ${control.serviceName}`:(canIntegrate?(state.liveStatus?.windowsAdmin?'Registra o serviço Windows para que o XAMPP Studio controle este componente.':'O Windows solicitará permissão de administrador ao registrar o serviço.'):control?.reason||'O serviço está mudando de estado; aguarde a próxima leitura.');
    }
    const moduleState=$(`#${component}ModuleServiceState`);
    if(moduleState)moduleState.textContent=stable?`Serviço ${control.serviceName} · ${control.running?'em execução':blocked?`parado · porta ${port} ocupada por ${control.portSummary||'outro processo'}`:'parado'}`:canIntegrate?`Serviço ${control.serviceName} ainda não registrado`:control?.reason||'Aguardando leitura do serviço';
    for(const button of $$(`[data-service-stop="${component}"]`)){
      button.disabled=!stable||!control?.running;
      button.textContent='Parar';
      button.title=control?.running?`Parar o serviço ${control.serviceName}. As conexões locais podem cair; nenhum arquivo de banco será removido.`:'O serviço já está parado ou ainda não está integrado.';
    }
    for(const button of $$(`[data-grant-control="${component}"]`)){
      const granted=Boolean(control?.controlGranted);
      button.disabled=!control?.managed||Boolean(state.liveStatus?.windowsAdmin)||granted;
      button.textContent=granted||state.liveStatus?.windowsAdmin?'Controle liberado':'Liberar controles';
      button.title=granted?'Esta conta já pode iniciar e parar este serviço sem novo aviso UAC.':state.liveStatus?.windowsAdmin?'O agente já está com permissão administrativa.':control?.managed?'Libera iniciar e parar neste serviço para o usuário atual, sem novos avisos UAC.':'Integre o serviço antes de liberar os controles.';
    }
  }
  const notice=$('#serviceControlNotice');
  const managedCount=['apache','mysql'].filter(name=>serviceControl?.[name]?.managed).length;
  if(notice){
    const canIntegrate=['apache','mysql'].some(name=>serviceControl?.[name]?.supported&&serviceControl[name].registered===false);
    const migrationCount=['apache','mysql'].filter(name=>serviceControl?.[name]?.managed&&!serviceControl[name].running&&serviceControl[name].portManaged).length;
    const blockedCount=['apache','mysql'].filter(name=>serviceControl?.[name]?.managed&&!serviceControl[name].running&&serviceControl[name].portActive&&!serviceControl[name].portManaged).length;
    notice.querySelector('strong').textContent=migrationCount?'Integração pronta; finalize a migração da instância atual.':blockedCount?`Serviços integrados; ${blockedCount} porta(s) ocupada(s) por outro processo.`:managedCount===2?'Apache e MySQL estão sob controle do Studio.':managedCount===1?'Um componente já está sob controle do Studio.':canIntegrate?'Integre os serviços uma vez para controlar tudo pelo Studio.':'Controle indisponível para esta instalação.';
    notice.querySelector('p').textContent=migrationCount?'Uma porta ainda responde pelo runtime integrado enquanto o serviço está parado. Pare essa instância uma vez pelo mecanismo que a iniciou e atualize esta tela. O Studio não encerra processos à força.':blockedCount?`O serviço está registrado, mas a porta ${blockedCount===1?'está ocupada':'estão ocupadas'} por Docker, WSL ou outro processo. Libere ${blockedCount===1?'a porta correspondente':'as portas correspondentes'} para que o serviço possa iniciar; o Studio não encerra esses processos.`:managedCount===2?'O Studio valida o Apache antes de reiniciar e usa o Windows para parar/iniciar os dois componentes.':canIntegrate?(state.liveStatus?.windowsAdmin?'A integração registra o serviço Windows após confirmação. Se a porta já estiver ocupada por outro processo, o Studio informa e preserva o processo.':'A integração abre uma solicitação UAC do Windows. Aceite a permissão para registrar o serviço; se a porta já estiver ocupada, o Studio preserva o processo atual.'):'O Windows encontrou um serviço que não corresponde a esta instalação ou não permitiu consultá-lo. Nenhum processo será encerrado por nome.';
  }
}
$$('[data-service]').forEach(button=>button.addEventListener('click',async()=>{
  const component=button.dataset.service;
  if(button.dataset.action==='migration'){
    showModal('MIGRAÇÃO ÚNICA',`<h2>A instância atual ainda está ativa</h2><p class="modal-copy">O serviço do Windows já está pronto, mas a porta ${component==='apache'?'80':'3306'} responde por um processo iniciado fora dele.</p><div class="modal-note">Para evitar perda de dados, o Studio não encerra processos externos à força. Pare essa instância uma última vez pelo mecanismo que a iniciou e atualize esta tela. Depois disso, iniciar e reiniciar ficará disponível somente no XAMPP Studio.</div><div class="modal-actions"><button class="primary-button" id="cancelAction">Entendi</button></div>`);
    return;
  }
  if(button.dataset.action==='integrate'){
    const label=component==='apache'?'Apache':'MySQL/MariaDB';
    showModal('INTEGRAR AO XAMPP STUDIO',`<h2>Controlar ${label} pelo Studio?</h2><p class="modal-copy">O Studio vai registrar o executável desta instalação como serviço do Windows. Depois disso, iniciar e reiniciar ficará disponível nesta tela.</p><div class="modal-note">${state.liveStatus?.windowsAdmin?'O agente já está com permissão administrativa.':'O Windows exibirá um aviso UAC: aceite a permissão para concluir o registro.'} Se uma instância já estiver rodando, ela continuará intacta; o Studio não a encerra à força. A integração só registra o serviço.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmServiceIntegration">Integrar ${label}</button></div>`);
    $('#cancelAction').onclick=closeModal;
    $('#confirmServiceIntegration').onclick=async()=>{
      const confirm=$('#confirmServiceIntegration');confirm.disabled=true;confirm.textContent=state.liveStatus?.windowsAdmin?'Registrando serviço…':'Aguardando UAC do Windows…';
      try{
        const result=await requestApi('/api/services/integrate',{method:'POST',body:JSON.stringify({service:component})});
        closeModal();recordActivity(`${label} integrado ao Studio`,`Serviço Windows ${result.serviceName}${result.elevated?' · autorização UAC concedida':''}${result.migrationRequired?' · a instância do runtime ainda está fora do serviço':result.portConflict?` · porta ocupada por ${result.portSummary||'outro processo'}`:''}`,result.migrationRequired?'Migrar instância':result.portConflict?'Porta ocupada':'Concluído');
        await loadLiveStatus();
        toast(result.migrationRequired?`${label} foi registrado. A instância atual ainda responde; o Studio a preservou. Faça a migração antes de iniciar o serviço.`:result.portConflict?`${label} foi integrado, mas a porta está ocupada por ${result.portSummary||'outro processo'}. Libere a porta para iniciar o serviço.`:`${label} integrado. As próximas ações podem ser feitas pelo XAMPP Studio.`,Boolean(result.migrationRequired||result.portConflict));
      }catch(error){confirm.disabled=false;confirm.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}
    };
    return;
  }
  if(button.dataset.action!=='restart'){
    toast(button.title||'Este serviço ainda não está disponível para controle pelo Studio.',true);
    return;
  }
  const label=component==='apache'?'Apache':'MySQL/MariaDB';
  const isRunning=state.liveStatus?.serviceControl?.[component]?.running===true,actionLabel=isRunning?'reiniciar':'iniciar';
  showModal(isRunning?'CONFIRMAR REINÍCIO':'CONFIRMAR INÍCIO',`<h2>${isRunning?'Reiniciar':'Iniciar'} ${label}?</h2><p class="modal-copy">${isRunning?'As conexões locais deste componente podem cair por alguns segundos.':'O serviço será iniciado e a porta local será verificada.'} ${component==='mysql'&&isRunning?'O MySQL será parado e iniciado pelo serviço do Windows; nenhum arquivo de banco será removido.':''}</p><div class="modal-note">O Apache só será iniciado/reiniciado se a configuração passar na validação. Para autorizar o serviço, o agente pode precisar estar aberto como administrador.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmServiceRestart">Confirmar ${actionLabel}</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmServiceRestart').onclick=async()=>{
    const confirm=$('#confirmServiceRestart');confirm.disabled=true;confirm.textContent='Aguardando o Windows…';
    try{
      const result=await requestApi('/api/services/restart',{method:'POST',body:JSON.stringify({service:component})});
      closeModal();recordActivity(`${label} ${result.action}`,`Serviço ${result.serviceName} · ${result.responding?'porta respondendo':`serviço ativo, mas a porta ${result.port} não respondeu`}`,result.responding?'Concluído':'Verificar');
      await loadLiveStatus();toast(result.responding?`${label} ${result.action} e confirmado na porta ${result.port}.`:`${label} está ativo, mas a porta ${result.port} não respondeu.`,!result.responding);
    }catch(error){recordActivity(`Falha ao controlar ${label}`,error.message,'Falhou');confirm.disabled=false;confirm.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}
  };
}));
$$('[data-grant-control]').forEach(button=>button.addEventListener('click',async()=>{
  const component=button.dataset.grantControl,label=component==='apache'?'Apache':'MySQL/MariaDB';
  showModal('LIBERAR CONTROLE LOCAL',`<h2>Permitir que o Studio inicie e pare ${label}?</h2><p class="modal-copy">O Windows concede uma permissão restrita para sua conta: iniciar e parar este serviço. Isso evita novos avisos UAC durante o uso normal.</p><div class="modal-note">A permissão não permite excluir o serviço nem alterar seu executável. Alterações estruturais continuam exigindo UAC e confirmação explícita.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmGrantControl">Liberar controles</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmGrantControl').onclick=async()=>{const confirm=$('#confirmGrantControl');confirm.disabled=true;confirm.textContent='Aguardando UAC…';try{const result=await requestApi('/api/services/grant-control',{method:'POST',body:JSON.stringify({service:component})});closeModal();recordActivity(`Controle local liberado para ${label}`,`Serviço ${result.serviceName} · iniciar/parar sem novos avisos UAC`,'Concluído');await loadLiveStatus();toast(`${label} agora pode ser iniciado e parado sem novo aviso UAC.`)}catch(error){confirm.disabled=false;confirm.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};
}));
const XAMPP_ACTION_LABELS={netstat:'Netstat',shell:'Shell',explorer:'Explorer',logs:'Logs',config:'Configuração',admin:'Admin'};
function netstatRow(entry){
  const badge=entry.managed?`<span class="netstat-badge">${entry.managed==='apache'?'Apache':'MySQL'}</span>`:'—';
  const name=entry.processName||entry.serviceName||'—';
  const detail=entry.executable||entry.commandLine||'';
  return `<tr class="${entry.managed?'managed':''}"><td>${escapeHtml(entry.protocol)}</td><td>${escapeHtml(entry.localAddress)}:${entry.localPort}</td><td>${escapeHtml(entry.state||'—')}</td><td>${entry.pid}</td><td class="netstat-name" title="${escapeHtml(detail)}">${escapeHtml(name)}</td><td>${escapeHtml(entry.serviceName||'—')}</td><td>${badge}</td></tr>`;
}
async function openNetstatPanel(){
  showModal('NETSTAT · PORTAS E PROCESSOS','<div class="catalog-context">Lendo as conexões ativas do Windows…</div>');
  try{
    const result=await requestApi('/api/netstat');
    const rows=result.entries.map(netstatRow).join('');
    $('#modalContent').innerHTML=`<div class="netstat-summary"><span class="netstat-chip">Portas em escuta <b>${result.counts.listening}</b></span><span class="netstat-chip">Conexões listadas <b>${result.counts.total}</b></span><span class="netstat-chip">Leitura <b>${new Date(result.generatedAt).toLocaleTimeString('pt-BR')}</b></span></div><div class="netstat-scroll"><table class="netstat-table"><thead><tr><th>PROTO</th><th>ENDEREÇO LOCAL</th><th>ESTADO</th><th>PID</th><th>PROCESSO</th><th>SERVIÇO</th><th>STUDIO</th></tr></thead><tbody>${rows||'<tr><td colspan="7">Nenhuma conexão listada.</td></tr>'}</tbody></table></div><div class="modal-note">O Studio apenas lê as conexões. Processos externos — como Docker ou WSL — nunca são encerrados automaticamente.</div><div class="modal-actions"><button class="outline-button" id="netstatRefresh">Atualizar</button><button class="primary-button" id="cancelAction">Fechar</button></div>`;
    $('#netstatRefresh').onclick=()=>openNetstatPanel();
  }catch(error){
    $('#modalContent').innerHTML=`<div class="modal-note">${escapeHtml(error.message)}</div><div class="modal-actions"><button class="primary-button" id="cancelAction">Fechar</button></div>`;
  }
}
async function handleXamppAction(action,component,button){
  if(!state.apiAvailable){toast('Inicie o agente local para usar as ações do XAMPP.',true);return}
  if(action==='netstat'){await openNetstatPanel();return}
  if(button)button.disabled=true;
  try{
    const result=await requestApi('/api/xampp/action',{method:'POST',body:JSON.stringify({action,component:component||null})});
    recordActivity(`Ação do XAMPP: ${result.label}`,`${result.openedWith||'aberto'}${result.target?` · ${result.target}`:''}`,'Concluído');
    toast(`${result.label} aberto${result.target?` · ${result.target}`:''}.`);
  }catch(error){toast(`Não foi possível executar a ação: ${error.message}`,true)}
  finally{if(button)button.disabled=false}
}
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-xampp-action]');
  if(!button)return;
  event.preventDefault();
  handleXamppAction(button.dataset.xamppAction,button.dataset.component||null,button);
});
$$('[data-service-stop]').forEach(button=>button.addEventListener('click',async()=>{
  const component=button.dataset.serviceStop,label=component==='apache'?'Apache':'MySQL/MariaDB';
  const control=state.liveStatus?.serviceControl?.[component];
  if(!control?.running){toast(`${label} já está parado.`,true);return}
  showModal('CONFIRMAR PARADA',`<h2>Parar ${label}?</h2><p class="modal-copy">O serviço <code>${escapeHtml(control.serviceName)}</code> será parado pelo Windows. As conexões locais podem cair e o site deixa de responder até o próximo início.</p><div class="modal-note">${component==='mysql'?'Parar o MySQL/MariaDB não apaga dados nem arquivos de banco.':'O Apache valida a configuração antes de cada novo início; parar apenas encerra o processo atual.'} Se o Windows pedir permissão administrativa, aceite o aviso UAC.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmServiceStop">Parar ${label}</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmServiceStop').onclick=async()=>{
    const confirm=$('#confirmServiceStop');confirm.disabled=true;confirm.textContent=state.liveStatus?.windowsAdmin?'Parando…':'Aguardando o Windows…';
    try{
      const result=await requestApi('/api/services/stop',{method:'POST',body:JSON.stringify({service:component})});
      closeModal();recordActivity(`${label} parado`,`Serviço ${result.serviceName}${result.alreadyStopped?' · já estava parado':''}${result.portActive?` · porta ${result.port} ainda responde por outro processo`:' · porta liberada'}`,result.portActive?'Aviso':'Concluído');
      await loadLiveStatus();toast(result.alreadyStopped?`${label} já estava parado.`:result.portActive?`${label} foi parado, mas a porta ${result.port} ainda responde por outro processo.`:`${label} foi parado e a porta ${result.port} foi liberada.`,Boolean(result.portActive));
    }catch(error){recordActivity(`Falha ao parar ${label}`,error.message,'Falhou');confirm.disabled=false;confirm.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}
  };
}));
$$('[data-service-repair]').forEach(button=>button.addEventListener('click',async()=>{
  const component=button.dataset.serviceRepair,label=component==='apache'?'Apache':'MySQL/MariaDB';
  const control=state.liveStatus?.serviceControl?.[component];
  if(!control?.managed){toast(`${label} ainda não está integrado ao Studio. Use “Liberar controles” primeiro.`,true);return}
  showModal('REPARAR COMANDO DO SERVIÇO',`<h2>Reaplicar o comando de ${label}?</h2><p class="modal-copy">O Windows guarda o comando de inicialização do serviço <code>${escapeHtml(control.serviceName)}</code>. Depois de trocar o runtime, o Windows pode continuar usando o comando antigo e recusar a partida com “Parâmetro incorreto”.</p><div class="modal-note">O Studio reescreve o comando com o runtime atualmente ativo, valida a configuração do Apache e confere o valor gravado. Se o Windows pedir permissão administrativa, aceite o aviso UAC — o serviço não é alterado antes disso.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmServiceRepair">Reparar e reiniciar</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmServiceRepair').onclick=async()=>{
    const confirm=$('#confirmServiceRepair');confirm.disabled=true;confirm.textContent=state.liveStatus?.windowsAdmin?'Reparando…':'Aguardando o Windows…';
    try{
      const result=await requestApi('/api/services/repair',{method:'POST',body:JSON.stringify({service:component})});
      closeModal();recordActivity(`Comando do serviço ${label} reaplicado`,`${result.serviceName} · ${result.after||'comando gravado'}`,`Concluído`);
      await loadLiveStatus();toast(`Comando do serviço ${label} reaplicado com sucesso.`,false);
      try{await requestApi('/api/services/restart',{method:'POST',body:JSON.stringify({service:component})});await loadLiveStatus();toast(`${label} reiniciado.`,false)}catch(error){toast(`Comando reparado, mas o serviço não subiu: ${error.message}`,true)}
    }catch(error){recordActivity(`Falha ao reparar ${label}`,error.message,'Falhou');confirm.disabled=false;confirm.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}
  };
}));
$('#changeApachePort').addEventListener('click',()=>{
  const currentPort=state.liveStatus?.apache?.port||80;
  showModal('MUDAR A PORTA DO APACHE',`<h2>Escolher outra porta para o Apache</h2><p class="modal-copy">O Apache está escutando na porta <strong>${escapeHtml(currentPort)}</strong>. Use outra porta quando algum outro programa (Docker, WSL, IIS) já ocupa a ${escapeHtml(currentPort)}.</p><label class="modal-field"><span>Nova porta (1024–65535)</span><input id="apachePortInput" type="number" min="1024" max="65535" value="${escapeHtml(currentPort===80?8080:currentPort)}" autocomplete="off"></label><div class="modal-note">O Studio copia o <code>httpd.conf</code> atual, valida a nova configuração com <code>httpd -t</code>, reinicia o serviço e confere que a porta responde. Se qualquer etapa falhar, a configuração anterior é restaurada. O site passa a responder em <code>http://localhost:<porta></code>.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmApachePort">Mudar porta</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmApachePort').onclick=async()=>{
    const confirm=$('#confirmApachePort');confirm.disabled=true;confirm.textContent='Aplicando…';
    const port=Number($('#apachePortInput').value);
    try{
      const result=await requestApi('/api/apache/port',{method:'POST',body:JSON.stringify({port})});
      closeModal();
      recordActivity('Porta do Apache alterada',`${result.previousPort} → ${result.port} · ${result.url}`,`Concluído`);
      await loadLiveStatus();
      toast(`Apache agora responde em ${result.url}.`);
    }catch(error){
      recordActivity('Falha ao mudar a porta do Apache',error.message,'Falhou');
      confirm.disabled=false;confirm.textContent='Tentar novamente';
      $('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`);
    }
  };
});
$('#openSiteButton').addEventListener('click',()=>{
  const port=state.liveStatus?.apache?.port||80;
  window.open(`http://localhost:${port}/`,'_blank','noopener');
});
$('#restartStudio').addEventListener('click',()=>{
  showModal('REINICIAR O STUDIO',`<h2>Recarregar o servidor local?</h2><p class="modal-copy">O XAMPP Studio vai reiniciar para carregar a versão mais recente do código. Os serviços do Windows (Apache e MySQL) continuam rodando normalmente.</p><div class="modal-note">A página fica alguns segundos sem resposta enquanto o servidor volta. Depois é só atualizar a aba.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmStudioRestart">Reiniciar</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmStudioRestart').onclick=async()=>{
    const confirm=$('#confirmStudioRestart');confirm.disabled=true;confirm.textContent='Reiniciando…';
    try{
      await requestApi('/api/studio/restart',{method:'POST',body:JSON.stringify({})});
      closeModal();
      toast('O Studio vai reiniciar em instantes.',false);
      setTimeout(()=>window.location.reload(),2500);
    }catch(error){
      confirm.disabled=false;confirm.textContent='Tentar novamente';
      $('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`);
    }
  };
});
$('#exportLog').addEventListener('click',()=>{
  const entries=state.activity.map(item=>`${new Date(item.at).toLocaleString('pt-BR')} | ${item.status} | ${item.event} | ${item.details}`);
  const log=['XAMPP Studio — histórico local',`Ambiente: ${state.liveStatus?.xamppRoot||'não conectado'}`,`PHP observado: ${state.liveStatus?.phpCli?.version||'não lido'}`,'Histórico salvo somente neste navegador.',...entries].join('\r\n');
  const url=URL.createObjectURL(new Blob([log],{type:'text/plain'})),a=document.createElement('a');a.href=url;a.download='xampp-studio-registro.txt';a.click();URL.revokeObjectURL(url);
});
$('#learnButton').addEventListener('click',()=>showModal('COMO FUNCIONA',`<h2>Seu ambiente sempre tem volta.</h2><p class="modal-copy">A proposta do XAMPP Studio é manter cada versão do PHP em uma pasta isolada e preparar uma troca com validações e cópia da configuração antes de alterar o Apache.</p><div class="checklist"><div><i>1</i> Inventariar runtimes, DLLs e configurações atuais</div><div><i>2</i> Preparar a nova versão sem tocar na que está ativa</div><div><i>3</i> Conferir módulos e criar backup restaurável</div><div><i>4</i> Aplicar a troca somente após revisão explícita</div></div><div class="modal-actions"><button class="primary-button" id="cancelAction">Entendi</button></div>`));
$('#cancelAction')?.addEventListener('click',closeModal);
$('#settingsButton').addEventListener('click',()=>showModal('AMBIENTE LOCAL',`<h2>Configuração observada</h2><p class="modal-copy">O XAMPP Studio consulta a instalação configurada em <code>${escapeHtml(state.liveStatus?.xamppRoot||'C:\\xampp')}</code>.</p><div class="checklist"><div><i>${state.apiAvailable?'✓':'!'}</i> ${state.apiAvailable?'Agente local conectado':'Agente local desconectado'}</div><div><i>${state.liveStatus?.writable?.phpIni?'✓':'!'}</i> php.ini ${state.liveStatus?.writable?.phpIni?'pode ser gravado':'não está gravável ou não foi encontrado'}</div><div><i>${state.liveStatus?.writable?.apacheConfig?'✓':'!'}</i> Configuração Apache ${state.liveStatus?.writable?.apacheConfig?'pode ser gravada':'não está gravável ou não foi encontrada'}</div></div><div class="modal-actions"><button class="primary-button" id="cancelAction">Fechar</button></div>`));
$('#workspaceButton').addEventListener('click',()=>showModal('PASTA DO XAMPP',`<h2>Meu XAMPP</h2><p class="modal-copy">${escapeHtml(state.liveStatus?.xamppRoot||'C:\\xampp')}</p><div class="modal-note">O caminho é definido pela variável XAMPP_ROOT do start.ps1. Nenhuma pasta é alterada por esta janela.</div><div class="modal-actions"><button class="primary-button" id="cancelAction">Fechar</button></div>`));
$('#helpButton').addEventListener('click',()=>showModal('AJUDA RÁPIDA',`<h2>Controle tudo pelo XAMPP Studio</h2><div class="checklist"><div><i>1</i> Execute <code>start.ps1</code> nesta pasta.</div><div><i>2</i> Abra <code>http://127.0.0.1:43197</code>; a página em <code>file:///</code> não habilita ações locais.</div><div><i>3</i> Em Serviços, integre Apache e MySQL uma vez e aceite o aviso UAC. Depois use <strong>Liberar controles</strong> nos módulos para iniciar e parar sem novos avisos.</div><div><i>4</i> Use <strong>Iniciar</strong>, <strong>Parar</strong> e <strong>Reiniciar</strong> como no XAMPP Control Panel. As ações <strong>Config</strong>, <strong>Logs</strong>, <strong>Shell</strong>, <strong>Admin</strong>, <strong>Netstat</strong> e <strong>Explorer</strong> ficam nos módulos e na página de Serviços.</div><div><i>5</i> Em <strong>Versões do PHP</strong>, use <strong>Configurar</strong> em uma versão — ou <strong>Extensões</strong> para ir direto à busca de DLLs. O Studio valida o PHP e o Apache, salva backup e reverte se algo falhar.</div><div><i>6</i> As extensões carregadas aparecem na <strong>Visão geral</strong> (botão <strong>Ver todas</strong>). Para instalar extensões novas, use <strong>Extensões</strong> dentro de cada versão do PHP.</div><div><i>7</i> Precisa de um relatório do ambiente? Use <strong>Ferramentas → Exportar diagnóstico</strong> na barra superior: ele exporta versões, hashes, serviço, portas, compatibilidade e logs em um arquivo Markdown.</div><div><i>8</i> Atalhos: <strong>Ctrl+K</strong> (ou <strong>Cmd+K</strong>) busca páginas; <strong>1–6</strong> navegam entre as telas, <strong>R</strong> relê o ambiente, <strong>D</strong> exporta o diagnóstico e <strong>?</strong> abre esta ajuda.</div></div><div class="modal-note">As DLLs usadas pelo ambiente ficam registradas e a troca é bloqueada se alguma não existir no novo PHP. A instalação de extensões PECL compatíveis é assíncrona, validada e reversível; a execução de SQL segue desativada.</div><div class="modal-actions"><button class="primary-button" id="cancelAction">Fechar</button></div>`));
$('#bannerClose').addEventListener('click',()=>{$('.demo-banner').hidden=true});

// Apache e MySQL têm módulos próprios; os runtimes são carregados nas páginas dedicadas.
function jobProgressHtml(job){
  const steps=(job.steps||[]).map(step=>`<div class="job-step ${escapeHtml(step.status)}"><i>${step.status==='succeeded'?'✓':step.status==='failed'?'!':'•'}</i><span><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.detail||'')}</small></span></div>`).join('')||'<div class="catalog-context">A operação entrou na fila do agente local.</div>';
  return `<div class="job-progress"><div class="job-progress-head"><strong>${job.status==='succeeded'?'Operação concluída':job.status==='failed'?'Operação interrompida':'Processando em segundo plano'}</strong><span>${Math.max(0,Math.min(100,Number(job.progress)||0))}%</span></div><div class="job-progress-track"><i style="width:${Math.max(0,Math.min(100,Number(job.progress)||0))}%"></i></div><div class="job-step-list">${steps}</div></div>`;
}

async function monitorJob(jobId,title='Operação em andamento'){
  showModal('OPERAÇÃO ASSÍNCRONA',`<h2>${escapeHtml(title)}</h2><p class="modal-copy">O agente continua trabalhando depois que esta tela é aberta. O progresso é atualizado sem bloquear a interface.</p><div id="jobMonitor">${jobProgressHtml({status:'queued',progress:0,steps:[]})}</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button></div>`);
  $('#cancelAction').onclick=closeModal;
  for(;;){
    const result=await requestApi(`/api/jobs/${encodeURIComponent(jobId)}`);
    const job=result.job;
    state.activeJobs.set(job.id,job);
    const monitor=$('#jobMonitor');
    if(monitor)monitor.innerHTML=jobProgressHtml(job);
    if(job.status==='succeeded'||job.status==='failed')return job;
    await new Promise(resolve=>setTimeout(resolve,700));
  }
}

async function startAsyncJob(path,body,title){
  const response=await requestApi(path,{method:'POST',body:JSON.stringify(body)});
  const job=await monitorJob(response.job.id,title);
  if(job.status==='failed')throw new Error(job.error||'A operação assíncrona falhou.');
  return job.result;
}

function renderApacheSummary(){
  const apache=state.liveStatus?.apache;
  const summary=$('#apacheModuleSummary');if(!summary)return;
  $('#apacheVersionCount').textContent=apache?.version||'—';
  if(!apache){summary.innerHTML='<div class="empty-state"><strong>Runtime Apache ainda não lido.</strong><p>Inicie o agente local para identificar versão, arquitetura e origem.</p></div>';return}
  const notice=$('#apacheModuleNotice');
  if(notice){notice.querySelector('strong').textContent=`Runtime ${apache.version||'atual'} identificado e validado.`;notice.querySelector('p').textContent=`Origem: ${apache.source||'ambiente local'}. O próximo build é verificado antes de entrar em qualquer serviço.`}
  summary.innerHTML=`<div class="runtime-summary-card"><span class="runtime-summary-icon apache">A</span><div><small>VERSÃO ATIVA</small><strong>Apache ${escapeHtml(apache.version||'—')}</strong><span>${escapeHtml(apache.source||'—')}</span></div></div><div class="runtime-summary-card"><span class="runtime-summary-icon">↗</span><div><small>ARQUITETURA</small><strong>${escapeHtml(apache.source||'Windows')}</strong><span>Porta 80 · ${escapeHtml(apache.config||'')}</span></div></div><div class="runtime-summary-card"><span class="runtime-summary-icon">◎</span><div><small>MODO DO ESTÚDIO</small><strong>${state.liveStatus?.mode==='standalone'?'Independente':'Compatível com XAMPP'}</strong><span>${escapeHtml(state.liveStatus?.workspaceRoot||'workspace local')}</span></div></div>`;
}

function renderMySqlSummary(){
  const mysql=state.liveStatus?.mysql;const summary=$('#mysqlModuleSummary');if(!summary)return;
  $('#mysqlVersionCount').textContent=mysql?.version||'—';
  if(!mysql){summary.innerHTML='<div class="empty-state"><strong>Runtime de banco ainda não lido.</strong><p>Inicie o agente local para identificar produto, versão e origem.</p></div>';return}
  const notice=$('#mysqlModuleNotice');
  if(notice){notice.querySelector('strong').textContent=`${mysql.product==='mariadb'?'MariaDB':'MySQL'} ${mysql.version||'atual'} identificado.`;notice.querySelector('p').textContent='Os pacotes oficiais são verificados pelo checksum publicado. Cada versão preparada usa um diretório de dados próprio e não altera o banco atual.'}
  summary.innerHTML=`<div class="runtime-summary-card"><span class="runtime-summary-icon mysql">M</span><div><small>VERSÃO ATIVA</small><strong>${escapeHtml(mysql.product==='mariadb'?'MariaDB':'MySQL')} ${escapeHtml(mysql.version||'—')}</strong><span>${escapeHtml(mysql.source||'—')}</span></div></div><div class="runtime-summary-card"><span class="runtime-summary-icon">↗</span><div><small>CONFIGURAÇÃO</small><strong>${escapeHtml(mysql.config||'—')}</strong><span>Porta 3306 · dados isolados por runtime</span></div></div><div class="runtime-summary-card"><span class="runtime-summary-icon">◎</span><div><small>WORKSPACE</small><strong>${escapeHtml(state.liveStatus?.workspaceRoot||'workspace local')}</strong><span>Sem alteração automática do banco atual</span></div></div>`;
}

async function loadPreparedApacheRuntimes(){
  try{
    const result=await requestApi('/api/apache/prepared');state.preparedApache=result.runtimes;
    $('#apachePreparedContext').textContent=`${result.runtimes.length} runtime(s) preparado(s)`;
    $('#apachePreparedList').innerHTML=result.runtimes.map(item=>`<article class="release-card"><div><strong>Apache ${escapeHtml(item.version)} · preparado</strong><small>Build ${escapeHtml(item.build)} · ${escapeHtml(item.architecture)} · ${escapeHtml(item.compiler)}</small><small>Pasta isolada: ${escapeHtml(item.root)}${state.liveStatus?.apache?.root===item.root?' · em uso':' · ainda não configurado'}</small></div><button class="outline-button small-button activate-apache" data-apache-root="${escapeHtml(item.root)}">Ativar conjunto independente</button></article>`).join('')||'<div class="catalog-context">Nenhum runtime Apache preparado ainda.</div>';
    renderApacheSummary();
  }catch(error){$('#apachePreparedList').innerHTML=`<div class="modal-note">${escapeHtml(error.message)}</div>`}
}
async function loadApacheReleases(){
  const list=$('#apacheReleaseList');list.innerHTML='<div class="skeleton skeleton-block"></div><div class="skeleton skeleton-line medium"></div>';
  try{
    const catalog=await requestApi('/api/apache/releases');
    list.innerHTML=`<div class="catalog-context">Apache atual ${escapeHtml(catalog.currentVersion)} · ${escapeHtml(catalog.source)}</div>`+catalog.versions.map(item=>`<article class="release-card"><div><strong>Apache ${escapeHtml(item.version)}</strong><small>Build ${escapeHtml(item.build)} · ${escapeHtml(item.architecture)} · ${escapeHtml(item.compiler)}</small><small>Pacote e SHA-256 publicados pelo Apache Lounge</small></div><button class="primary-button small-button download-apache" data-version="${escapeHtml(item.version)}" data-build="${escapeHtml(item.build)}">Baixar e preparar</button></article>`).join('')||'<div class="modal-note">Nenhuma versão superior encontrada para esta arquitetura.</div>';
  }catch(error){list.innerHTML=`<div class="modal-note">${escapeHtml(error.message)}</div>`}
}
$('#refreshApacheReleases').addEventListener('click',()=>{loadApacheReleases();loadPreparedApacheRuntimes()});
$('#apachePreparedList').addEventListener('click',event=>{
  const button=event.target.closest('.activate-apache');if(!button)return;
  const item=state.preparedApache.find(runtime=>runtime.root===button.dataset.apacheRoot);if(!item||!state.liveStatus?.phpRoot){toast('Leia o ambiente local antes de ativar o Apache.',true);return}
  showModal('TROCA VALIDADA DO AMBIENTE',`<h2>Usar Apache ${escapeHtml(item.version)} com o PHP atual?</h2><p class="modal-copy">O Studio cria uma configuração própria, valida os módulos e troca o executável do serviço sem depender do properties.ini do XAMPP.</p><div class="file-summary"><span class="file-type-icon">HTTP</span><span><strong>${escapeHtml(item.root)}</strong><small>${escapeHtml(item.compiler)} · ${escapeHtml(item.architecture)}</small></span></div><div class="modal-note">O Apache será reiniciado se estiver rodando. Qualquer falha restaura o serviço e as configurações anteriores. Um backup fica salvo dentro do projeto.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmApacheSwitch">Validar e usar Apache</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmApacheSwitch').onclick=async()=>{const confirm=$('#confirmApacheSwitch');confirm.disabled=true;confirm.textContent='Validando módulos…';try{const result=await requestApi('/api/environment/activate',{method:'POST',body:JSON.stringify({mode:'standalone',phpRoot:state.liveStatus.phpRoot,apacheRoot:item.root})});closeModal();recordActivity('Apache atualizado junto ao PHP atual',`Apache ${result.apacheVersion} · PHP ${result.phpVersion} · backup ${result.backup}`,result.apacheRestarted?'Concluído':'Configurado');await loadLiveStatus();await loadPreparedApacheRuntimes();toast(result.apacheRestarted?`Apache ${result.apacheVersion} validado e reiniciado.`:`Apache ${result.apacheVersion} configurado; estava parado.`)}catch(error){confirm.disabled=false;confirm.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};
});
$('#apacheReleaseList').addEventListener('click',event=>{
  const download=event.target.closest('.download-apache');if(!download)return;
  const {version,build}=download.dataset;
  showModal('CONFIRMAR DOWNLOAD DE TERCEIRO',`<h2>Preparar Apache ${escapeHtml(version)}?</h2><p class="modal-copy">Será baixado um build Windows do Apache Lounge, verificado pelo SHA-256 publicado nessa mesma origem e preparado em uma pasta isolada.</p><div class="modal-note">O pacote não será configurado para substituir o Apache do XAMPP nesta etapa. Origem: <a href="https://www.apachelounge.com/download/" target="_blank" rel="noopener noreferrer">Apache Lounge ↗</a>.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmApacheDownload">Baixar runtime</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmApacheDownload').onclick=async()=>{const button=$('#confirmApacheDownload');button.disabled=true;button.textContent='Baixando e verificando…';try{const result=await startAsyncJob('/api/apache/install-async',{version,build},`Preparando Apache ${version}`);recordActivity('Runtime Apache preparado',`Apache ${result.version} · build ${result.build} · SHA-256 conferido`);closeModal();toast(`Apache ${result.version} foi preparado em runtimes. O XAMPP atual continua inalterado.`);await loadApacheReleases();await loadPreparedApacheRuntimes()}catch(error){button.disabled=false;button.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};
});

async function loadPreparedMySqlRuntimes(){
  try{
    const result=await requestApi('/api/mysql/prepared');state.preparedMySql=result.runtimes;
    $('#mysqlPreparedContext').textContent=`${result.runtimes.length} runtime(s) preparado(s)`;
    $('#mysqlPreparedList').innerHTML=result.runtimes.map(item=>`<article class="release-card"><div><strong>${escapeHtml(item.product==='mariadb'?'MariaDB':'MySQL')} ${escapeHtml(item.version)} · preparado</strong><small>${escapeHtml(item.architecture)} · ${escapeHtml(item.channel||'Stable')}</small><small>Dados: ${escapeHtml(item.dataDirectory||'—')}</small>${item.credentialsPath?`<small>Credenciais: ${escapeHtml(item.credentialsPath)}</small>`:''}</div><button class="outline-button small-button activate-mysql" data-mysql-root="${escapeHtml(item.root)}">Ativar runtime</button></article>`).join('')||'<div class="catalog-context">Nenhum runtime de banco preparado ainda.</div>';
    renderMySqlSummary();
  }catch(error){$('#mysqlPreparedList').innerHTML=`<div class="modal-note">${escapeHtml(error.message)}</div>`}
}
async function loadMySqlReleases(){
  const list=$('#mysqlReleaseList');list.innerHTML='<div class="skeleton skeleton-block"></div><div class="skeleton skeleton-line medium"></div>';
  try{
    const catalog=await requestApi('/api/mysql/releases');
    const context=catalog.providers.map(provider=>`<span class="catalog-context">${provider.available?'✓':'!'} ${escapeHtml(provider.label)}</span>`).join('');
    list.innerHTML=`<div class="catalog-provider-row">${context}</div>`+catalog.releases.map(item=>`<article class="release-card"><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.architecture)} · ${escapeHtml(item.channel||'—')}</small><small>Checksum ${escapeHtml(item.checksum?.algorithm?.toUpperCase()||'não informado')} · ${escapeHtml(item.source)}</small></div><button class="primary-button small-button download-mysql" data-release-id="${escapeHtml(item.id)}">Baixar e preparar</button></article>`).join('')||'<div class="modal-note">Nenhum pacote oficial foi encontrado.</div>';
  }catch(error){list.innerHTML=`<div class="modal-note">${escapeHtml(error.message)}</div>`}
}
$('#refreshMySqlReleases').addEventListener('click',()=>{loadMySqlReleases();loadPreparedMySqlRuntimes()});
$('#mysqlReleaseList').addEventListener('click',event=>{
  const download=event.target.closest('.download-mysql');if(!download)return;
  const releaseId=download.dataset.releaseId;
  showModal('DOWNLOAD ASSÍNCRONO DO BANCO',`<h2>Preparar este runtime?</h2><p class="modal-copy">O pacote oficial será baixado, o checksum conferido, o programa extraído e um diretório de dados local inicializado.</p><div class="modal-note">A versão atual continua em uso. A troca só ocorre em uma ativação separada e reversível.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmMySqlDownload">Baixar e configurar</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmMySqlDownload').onclick=async()=>{const button=$('#confirmMySqlDownload');button.disabled=true;button.textContent='Iniciando…';try{const result=await startAsyncJob('/api/mysql/install-async',{releaseId},'Preparando runtime do banco');recordActivity('Runtime de banco preparado',`${result.product} ${result.version} · checksum conferido · dados isolados`);closeModal();toast(`${result.product==='mariadb'?'MariaDB':'MySQL'} ${result.version} foi preparado sem alterar o banco atual.`);await loadMySqlReleases();await loadPreparedMySqlRuntimes()}catch(error){button.disabled=false;button.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};
});
$('#mysqlPreparedList').addEventListener('click',event=>{
  const button=event.target.closest('.activate-mysql');if(!button)return;
  const item=state.preparedMySql.find(runtime=>runtime.root===button.dataset.mysqlRoot);if(!item)return;
  showModal('TROCA REVERSÍVEL DO BANCO',`<h2>Ativar ${escapeHtml(item.product==='mariadb'?'MariaDB':'MySQL')} ${escapeHtml(item.version)}?</h2><p class="modal-copy">O serviço MySQL/MariaDB passa a usar este executável e o diretório de dados próprio da versão. Se ainda não existir um serviço integrado, o Studio o registra automaticamente.</p><div class="file-summary"><span class="file-type-icon">DB</span><span><strong>${escapeHtml(item.root)}</strong><small>${escapeHtml(item.dataDirectory||'')}</small></span></div><div class="modal-note">O Windows pode exibir uma solicitação UAC para registrar o serviço. O comando anterior do serviço fica salvo para reversão. O banco atual não é apagado.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmMySqlSwitch">Validar e ativar</button></div>`);
  $('#cancelAction').onclick=closeModal;
  $('#confirmMySqlSwitch').onclick=async()=>{const confirm=$('#confirmMySqlSwitch');confirm.disabled=true;confirm.textContent=state.liveStatus?.windowsAdmin?'Validando serviço…':'Aguardando UAC do Windows…';try{const result=await requestApi('/api/mysql/switch',{method:'POST',body:JSON.stringify({mysqlRoot:item.root})});closeModal();recordActivity('Runtime de banco ativado',`${result.product} ${result.version} · serviço ${result.serviceName}`,result.migrationRequired?'Migrar instância':result.restarted?'Concluído':'Configurado');await loadLiveStatus();await loadPreparedMySqlRuntimes();toast(result.migrationRequired?`${result.product==='mariadb'?'MariaDB':'MySQL'} ${result.version} foi registrado, mas uma instância antiga ainda ocupa a porta 3306. O Studio a preservou.`: `${result.product==='mariadb'?'MariaDB':'MySQL'} ${result.version} ativado${result.restarted?' e reiniciado':''}.`,Boolean(result.migrationRequired))}catch(error){confirm.disabled=false;confirm.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};
});

function updatePerformanceControls(apacheShare){
  const apache=Math.max(20,Math.min(80,Number(apacheShare)||50));
  state.performanceApacheShare=apache;
  $('#performanceApache').value=String(apache);$('#performanceMysql').value=String(100-apache);
  $('#performanceApacheValue').textContent=`${apache}%`;$('#performanceMysqlValue').textContent=`${100-apache}%`;
  const info=state.performance?.settings;
  if(info){const total=info.totalMemoryMiB;const service=Math.floor(total*.8);const apacheMiB=Math.floor(service*apache/100);const mysqlMiB=service-apacheMiB;const threads=Math.max(8,Math.min(192,Math.round(info.logicalProcessors*8*(apache/50))));const phpMem=Math.max(16,Math.min(512,Math.floor(Math.floor(apacheMiB/threads*.65)/8)*8));const buffer=Math.max(64,Math.min(Math.floor(total*.5),Math.floor(mysqlMiB*.5)));const conn=Math.max(10,Math.min(500,Math.floor(mysqlMiB*.25/8)));$('#performanceSummary').innerHTML=`<strong>${info.logicalProcessors} processador(es) · ${(total/1024).toFixed(1)} GB de memória</strong><span>Reserva do Windows: ${Math.floor(total*.2)} MB</span><span>Apache: até ${threads} pedidos simultâneos · PHP ${phpMem} MB por execução</span><span>MySQL: cache estimado ${buffer} MB · até ${conn} conexões</span>`}
}
async function loadPerformance(){
  try{state.performance=await requestApi('/api/performance');updatePerformanceControls(state.performance.settings.apacheShare);$('#performanceHardware').textContent=`${state.performance.settings.logicalProcessors} NÚCLEO(S) · ${(state.performance.settings.totalMemoryMiB/1024).toFixed(1)} GB RAM`;if(!state.performance.available)$('#performanceSummary').innerHTML='<span>Os arquivos do Apache e do MySQL não foram localizados no XAMPP configurado.</span>'}
  catch(error){$('#performanceSummary').innerHTML=`<span>${escapeHtml(error.message)}</span>`;$('#performanceHardware').textContent='AGENTE INDISPONÍVEL'}
}
$('#performanceApache').addEventListener('input',event=>updatePerformanceControls(event.target.value));
$('#performanceMysql').addEventListener('input',event=>updatePerformanceControls(100-Number(event.target.value)));
$('#applyPerformance').addEventListener('click',()=>{
  if(!state.apiAvailable){toast('Inicie o agente local para ajustar os serviços.',true);return}
  showModal('APLICAR AJUSTES DE PERFORMANCE',`<h2>Recalibrar os serviços?</h2><p class="modal-copy">A nova distribuição será PHP/Apache ${state.performanceApacheShare}% e MySQL ${100-state.performanceApacheShare}%, preservando 20% para o Windows.</p><div class="checklist"><div><i>↗</i> Apache e MySQL serão validados antes de qualquer reinício.</div><div><i>✓</i> O backup das configurações fica na pasta do projeto.</div><div><i>i</i> Serviços que já estiverem parados continuarão parados.</div></div><div class="modal-note">O Windows não aplica um teto exato de CPU por serviço aqui. O Studio ajusta concorrência e limites de memória.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Voltar</button><button class="primary-button" id="confirmPerformance">Salvar e validar</button></div>`);
  $('#confirmPerformance').onclick=async()=>{const button=$('#confirmPerformance');button.disabled=true;button.textContent='Fazendo backup e validando…';try{const result=await requestApi('/api/performance/apply',{method:'POST',body:JSON.stringify({apacheShare:state.performanceApacheShare})});closeModal();recordActivity('Limites de performance atualizados',`PHP/Apache ${result.settings.apacheShare}% · MySQL ${result.settings.mysqlShare}% · backup ${result.backup}`);await loadPerformance();await loadLiveStatus();toast('Ajustes validados e aplicados.'+(result.apacheRestarted||result.mysqlRestarted?' Os serviços ativos foram reiniciados.':' Os serviços estavam parados.'))}catch(error){button.disabled=false;button.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};
});

function phpInputValue(item){
  const raw=item.value==null?'':String(item.value).replace(/^['"]|['"]$/g,'');
  if(item.type==='boolean')return /^on|true|1$/i.test(raw);
  if(item.type==='size'){const match=raw.match(/^(\d+)\s*(M|G)?$/i);return match?String(Number(match[1])*(match[2]?.toUpperCase()==='G'?1024:1)):''}
  return raw;
}
function renderPhpSettings(filter=''){
  if(!state.phpSettings){$('#phpSettingsGrid').innerHTML='<div class="empty-state"><strong>Conecte o agente local</strong><p>Abra o XAMPP Studio em http://127.0.0.1:43197 para ler o php.ini ativo.</p></div>';return}
  const query=filter.trim().toLowerCase();
  const groups=state.phpSettings.groups.map(group=>{const items=group.items.filter(item=>`${item.key} ${item.label} ${item.description} ${group.description||''}`.toLowerCase().includes(query));if(!items.length)return'';return `<section class="php-settings-group"><div class="panel-title">${escapeHtml(group.title)}</div>${group.description?`<p class="panel-help group-help">${escapeHtml(group.description)}</p>`:''}<div class="php-settings-cards">${items.map(item=>{
    const value=phpInputValue(item);const unset=item.value==null||item.value==='';let control='';
    if(item.type==='boolean')control=`<input type="checkbox" data-php-key="${escapeHtml(item.key)}" data-php-type="boolean" ${value?'checked':''}><span class="toggle-mark" aria-hidden="true"></span>`;
    else if(item.type==='choice')control=`<select data-php-key="${escapeHtml(item.key)}" data-php-type="choice">${unset?'<option value="" disabled selected>Padrão do PHP</option>':''}${item.options.map(option=>`<option value="${escapeHtml(option)}" ${value===option?'selected':''}>${escapeHtml(item.currentOptionAdded&&option===item.value?`Atual · ${option}`:option)}</option>`).join('')}</select>`;
    else if(item.type==='size')control=`<span class="config-value"><input type="number" data-php-key="${escapeHtml(item.key)}" data-php-type="size" min="${escapeHtml(item.min)}" max="${escapeHtml(item.max)}" value="${escapeHtml(value)}" placeholder="Padrão PHP"><i>MB</i></span>`;
    else if(item.type==='number')control=`<span class="config-value"><input type="number" data-php-key="${escapeHtml(item.key)}" data-php-type="number" min="${escapeHtml(item.min)}" max="${escapeHtml(item.max)}" value="${escapeHtml(value)}" placeholder="Padrão PHP">${item.suffix?`<i>${escapeHtml(item.suffix)}</i>`:''}</span>`;
    else control=`<input class="config-text" type="text" data-php-key="${escapeHtml(item.key)}" data-php-type="${escapeHtml(item.type)}" value="${escapeHtml(value)}" placeholder="${item.type==='timezone'?'America/Sao_Paulo':'Caminho .log dentro do XAMPP'}">`;
    return `<article class="php-setting-card"><div class="php-setting-copy"><span class="php-setting-key">${escapeHtml(item.key)}</span><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.description)}</p>${unset?'<small class="default-label">Sem valor explícito · padrão do PHP</small>':''}</div><label class="php-setting-control" aria-label="${escapeHtml(item.label)}">${control}</label></article>`
  }).join('')}</div></section>`}).join('');
  $('#phpSettingsGrid').innerHTML=groups||'<div class="empty-state"><strong>Nenhuma variável encontrada</strong><p>Tente buscar por OPcache, erros, memória ou fuso horário.</p></div>';
  for(const input of $$('input[type="checkbox"][data-php-key]',$('#phpSettingsGrid'))){const item=state.phpSettings.groups.flatMap(group=>group.items).find(setting=>setting.key===input.dataset.phpKey);if(item?.value==null)input.indeterminate=true}
  updatePhpSettingsDirtyLabel();
}
function updatePhpSettingsDirtyLabel(){
  const label=$('#phpSettingsDirtyLabel');if(!label)return;
  const count=state.phpSettingsDirty.size;
  label.textContent=count?`${count} alteração(ões) pendente(s).`:'Nenhuma alteração pendente.';
  label.classList.toggle('dirty-label',Boolean(count));
}
async function loadPhpSettings(phpRoot=state.dllVersionRoot){
  if(!phpRoot){state.phpSettings=null;renderPhpSettings();return}
  state.phpSettingsRoot=phpRoot;
  try{
    const settings=await requestApi(`/api/php/settings?phpRoot=${encodeURIComponent(phpRoot)}`);
    if(state.phpSettingsRoot!==phpRoot)return;
    state.phpSettings=settings;state.phpSettingsDirty.clear();
    $('#phpSettingsFile').textContent=`${settings.file}${settings.active?' · EM USO':' · VERSÃO ISOLADA'}`;
    const chip=$('#phpSettingsActiveChip');
    if(chip){chip.textContent=settings.active?'VERSÃO EM USO':'VERSÃO ISOLADA';chip.classList.toggle('danger-chip',false)}
    $('#phpSettingsNoticeTitle').textContent=settings.active?'Configurações do PHP ativo.':'Configurações da versão isolada.';
    $('#phpSettingsNoticeCopy').textContent=settings.active?'O Studio altera apenas opções conhecidas, mantém o restante do php.ini e cria um backup antes de salvar. O Apache pode ser reiniciado para aplicar.':'O Studio altera apenas opções conhecidas deste runtime, valida com o php.exe da própria versão e não reinicia o Apache.';
    $('#phpSettingsRestartNote').textContent=settings.active?'Algumas alterações precisam reiniciar o Apache para surtirem efeito.':'Esta versão não está ativa; as alterações serão aplicadas quando ela for ativada.';
    renderPhpSettings($('#phpSettingsSearch').value);
  }
  catch(error){
    state.phpSettings=null;$('#phpSettingsFile').textContent='Não foi possível ler o php.ini desta versão';$('#phpSettingsNoticeTitle').textContent='Falha ao carregar a configuração.';$('#phpSettingsNoticeCopy').textContent=error.message;renderPhpSettings();toast(error.message,true)
  }
}
$('#phpSettingsSearch').addEventListener('input',event=>renderPhpSettings(event.target.value));
$('#phpSettingsGrid').addEventListener('input',event=>{const key=event.target.dataset.phpKey;if(key){state.phpSettingsDirty.add(key);updatePhpSettingsDirtyLabel()}});
$('#phpSettingsGrid').addEventListener('change',event=>{const key=event.target.dataset.phpKey;if(key){state.phpSettingsDirty.add(key);updatePhpSettingsDirtyLabel()}});
function collectPhpSettingValues(){
  const values={};
  for(const input of $$('[data-php-key]',$('#phpSettingsGrid'))){const key=input.dataset.phpKey;if(!state.phpSettingsDirty.has(key))continue;const type=input.dataset.phpType;let value=type==='boolean'?input.checked:input.value.trim();if(type==='size'&&value)value=`${value}M`;values[key]=value}
  return values;
}
$('#savePhpSettings').addEventListener('click',()=>{
  const values=collectPhpSettingValues();if(!Object.keys(values).length){toast('Altere ao menos uma opção antes de salvar.',true);return}
  const settings=state.phpSettings;const phpRoot=settings?.phpRoot||state.dllVersionRoot;if(!phpRoot){toast('Selecione uma versão do PHP antes de salvar.',true);return}
  const active=Boolean(settings?.active);
  const versionLabel=settings?.phpVersion||selectedDllRuntime()?.version||'selecionada';
  showModal('SALVAR CONFIGURAÇÕES DO PHP',`<h2>Aplicar ${Object.keys(values).length} alteração(ões) em PHP ${escapeHtml(versionLabel)}?</h2><p class="modal-copy">O Studio cria um backup do php.ini antes de gravar os valores selecionados.</p><div class="modal-note">${active?'Esta é a versão ativa: se o Apache estiver rodando sob controle do Studio, ele será reiniciado.':'Esta versão está isolada: o arquivo será salvo e validado pelo php.exe dela, sem reiniciar o Apache.'} Se a validação falhar, o arquivo anterior será restaurado.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Voltar</button><button class="primary-button" id="confirmPhpSettings">Salvar configurações</button></div>`);
  $('#confirmPhpSettings').onclick=async()=>{const button=$('#confirmPhpSettings');button.disabled=true;button.textContent='Salvando…';try{const result=await requestApi('/api/php/settings',{method:'POST',body:JSON.stringify({values,phpRoot})});closeModal();recordActivity('Variáveis PHP atualizadas',`PHP ${versionLabel} · ${result.changed.length} opção(ões) · backup ${result.backup}`,result.warnings?.length?'Aviso':'Concluído');await loadPhpSettings(phpRoot);if(result.active)await loadLiveStatus();const note=result.warnings?.length?` ${result.warnings.join(' ')}`:'';toast((result.active?(result.apacheRestarted?'Configurações salvas e Apache reiniciado.':'Configurações salvas; o Apache estava parado e aplicará os ajustes ao iniciar.'):`Configurações salvas e validadas em PHP ${versionLabel}; a versão não está ativa.`)+note,Boolean(result.warnings?.length))}catch(error){button.disabled=false;button.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};
});

function renderFirewallLogs(filter=''){
  const query=filter.trim().toLowerCase();
  const entries=state.firewallLogs.filter(item=>`${item.ip} ${item.method} ${item.path} ${item.status} ${item.source} ${item.body} ${item.raw}`.toLowerCase().includes(query));
  $('#firewallLogList').innerHTML=entries.map((item,index)=>`<article class="firewall-log-row"><div class="firewall-log-primary"><strong>${escapeHtml(item.ip)}</strong><span class="firewall-method">${escapeHtml(item.method)}</span><span class="firewall-path">${escapeHtml(item.path)}</span><span class="firewall-source">${escapeHtml(item.source)} · ${escapeHtml(item.status)}</span></div><div class="firewall-log-meta"><span>${escapeHtml(item.timestamp||'Horário não informado')}</span><span>${escapeHtml(item.body)}</span><div><button class="text-action view-raw-log" data-index="${index}">Ver raw <span>↗</span></button>${item.blocked?'<span class="result-chip warning-chip">BLOQUEADO</span>':`<button class="text-action block-log-ip" data-ip="${escapeHtml(item.ip)}">Bloquear IP <span>＋</span></button>`}</div></div></article>`).join('')||'<div class="empty-state"><strong>Nenhum registro encontrado</strong><p>Não há linhas nos logs disponíveis que correspondam a esta busca.</p></div>';
}
function renderBlockedIps(){
  $('#blockedIpList').innerHTML=state.blockedIps.map(item=>`<div class="blocked-ip-row"><span><strong>${escapeHtml(item.ip)}</strong><small>Bloqueado em ${escapeHtml(new Date(item.blockedAt).toLocaleString('pt-BR'))}</small></span><button class="outline-button small-button unblock-ip" data-ip="${escapeHtml(item.ip)}">Desbloquear</button></div>`).join('')||'<div class="catalog-context">Nenhum IP bloqueado pelo XAMPP Studio.</div>';
}
function updateCloudflareDisplay(){
  const button=$('#cloudflareAction');const view=$('#cloudflareState');
  if(state.cloudflareActive){button.textContent='Atualizar faixas oficiais';view.textContent='Restrição ativa · portas 80 e 443 autorizadas pelas faixas oficiais da Cloudflare.';view.classList.add('cloudflare-active')}
  else{button.textContent='Verificar configuração';view.textContent=state.cloudflarePreview?`${state.cloudflarePreview.rangeCount} faixas oficiais verificadas · ${state.cloudflarePreview.safeToApply?'pronto para revisar':'há itens que exigem revisão'}`:'Ainda não verificado';view.classList.remove('cloudflare-active')}
}
function updateBodyCaptureDisplay(){
  const button=$('#bodyCaptureAction');const view=$('#bodyCaptureState');
  if(state.bodyCaptureError){button.textContent='Verificar captura';view.textContent=`Não foi possível ler o estado: ${state.bodyCaptureError}`;view.classList.remove('cloudflare-active');return}
  button.textContent=state.bodyCaptureActive?'Desativar captura':'Ativar captura filtrada';
  const bytes=state.bodyCaptureBytes;const size=bytes?` · ${bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(1)} MB`} em registros`:'';
  view.textContent=state.bodyCaptureActive?`${state.bodyCapturePending?'Configurada para a próxima inicialização do Apache':'Captura ativa'}${size} · vale para todos os sites PHP deste XAMPP.`:'Desativada · nenhum corpo de requisição é salvo.';
  view.classList.toggle('cloudflare-active',state.bodyCaptureActive);
}
async function loadFirewall(){
  $('#firewallLogList').innerHTML='<div class="skeleton skeleton-block"></div><div class="skeleton skeleton-line medium"></div>';
  try{const [logs,blocks,capture]=await Promise.all([requestApi('/api/firewall/logs'),requestApi('/api/firewall/blocks'),requestApi('/api/firewall/body-capture').then(value=>({value}),error=>({error}))]);state.firewallLogs=logs.entries;state.blockedIps=blocks.blockedIps;state.cloudflareActive=blocks.cloudflareActive;state.bodyCaptureError=capture.error?.message||'';if(capture.value){state.bodyCaptureActive=capture.value.active;state.bodyCapturePending=capture.value.pending;state.bodyCaptureBytes=capture.value.bytes||0}renderFirewallLogs($('#firewallSearch').value);renderBlockedIps();updateCloudflareDisplay();updateBodyCaptureDisplay();$('#firewallNotice p').textContent=`Apache: ${logs.sources.apache} registro(s) lido(s) · Firewall do Windows: ${logs.sources.windowsFirewall} registro(s) · PHP: ${logs.sources.phpBodies||0} corpo(s) filtrado(s). ${logs.note}`}
  catch(error){$('#firewallLogList').innerHTML=`<div class="empty-state"><strong>Não foi possível carregar todos os dados</strong><p>${escapeHtml(error.message)}. Inicie start.ps1; os logs do Windows podem exigir permissões adicionais.</p></div>`;try{const blocks=await requestApi('/api/firewall/blocks');state.blockedIps=blocks.blockedIps;state.cloudflareActive=blocks.cloudflareActive;renderBlockedIps();updateCloudflareDisplay()}catch{};try{const capture=await requestApi('/api/firewall/body-capture');state.bodyCaptureActive=capture.active;state.bodyCapturePending=capture.pending;state.bodyCaptureBytes=capture.bytes||0;state.bodyCaptureError=''}catch(captureError){state.bodyCaptureError=captureError.message}updateBodyCaptureDisplay()}
}
$('#refreshFirewall').addEventListener('click',loadFirewall);
$('#firewallSearch').addEventListener('input',event=>renderFirewallLogs(event.target.value));
$('#firewallLogList').addEventListener('click',event=>{
  const rawButton=event.target.closest('.view-raw-log');if(rawButton){const item=state.firewallLogs[Number(rawButton.dataset.index)];if(item)showModal('LINHA ORIGINAL DO REGISTRO',`<h2>${escapeHtml(item.source)} · ${escapeHtml(item.ip)}</h2><p class="modal-copy">${item.source==='PHP · corpo filtrado'?'Este registro contém somente campos filtrados; segredos reconhecidos foram ocultados.':'O corpo HTTP não está disponível nesta fonte de registro.'}</p><pre class="sql-preview raw-log-preview">${escapeHtml(item.raw)}</pre><div class="modal-actions"><button class="primary-button" id="cancelAction">Fechar</button></div>`);return}
  const block=event.target.closest('.block-log-ip');if(block)confirmBlockIp(block.dataset.ip);
});
function showBodyCaptureSetup(){
  if(state.bodyCaptureActive){showModal('DESATIVAR CAPTURA FILTRADA',`<h2>Parar de registrar corpos?</h2><p class="modal-copy">A captura será removida do php.ini e o Apache será reiniciado pelo Studio se estiver sob seu controle.</p><div class="modal-note">Os registros já gravados em <code>logs/request-bodies.jsonl</code> permanecerão no projeto. A mudança vale para todos os sites PHP deste XAMPP.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Manter ativa</button><button class="primary-button" id="confirmBodyCapture">Desativar captura</button></div>`);}
  else{showModal('ATIVAR CAPTURA FILTRADA',`<h2>Registrar formulários e JSON?</h2><p class="modal-copy">O Studio adiciona um filtro PHP que registra IP, método, caminho, status e corpo de requisições POST, PUT, PATCH e DELETE.</p><div class="checklist"><div><i>✓</i> Apenas JSON e formulário urlencoded até 16 KB.</div><div><i>✓</i> Campos com nomes de senha, token, segredo, chave ou sessão são ocultados.</div><div><i>✓</i> Campos longos são limitados; upload, query string e conteúdo binário são ignorados.</div></div><div class="modal-note">A captura vale para todos os sites PHP deste XAMPP. Os registros ficam em logs/request-bodies.jsonl dentro do projeto e continuam no disco após desativar. O Apache pode reiniciar para aplicar.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmBodyCapture">Ativar captura</button></div>`);}
  $('#confirmBodyCapture').onclick=async()=>{const button=$('#confirmBodyCapture');button.disabled=true;button.textContent=state.bodyCaptureActive?'Desativando…':'Validando e ativando…';try{const active=!state.bodyCaptureActive;const result=await requestApi('/api/firewall/body-capture',{method:'POST',body:JSON.stringify({active})});closeModal();recordActivity(active?'Captura filtrada ativada':'Captura filtrada desativada',result.apacheRestarted?'Apache reiniciado':'Requerida para novas requisições');await loadFirewall();toast(active?'Captura filtrada ativada.':'Captura filtrada desativada.')}catch(error){button.disabled=false;button.textContent=state.bodyCaptureActive?'Tentar novamente':'Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};
}
$('#bodyCaptureAction').addEventListener('click',()=>{if(state.bodyCaptureError){loadFirewall();return}showBodyCaptureSetup()});
function confirmBlockIp(ip=''){
  showModal('CRIAR BLOQUEIO DE ENTRADA',`<h2>Bloquear um endereço IP</h2><p class="modal-copy">O Windows recusará novas conexões de entrada deste endereço em qualquer porta.</p><label class="modal-field"><span>Endereço IPv4 ou IPv6</span><input id="firewallIpInput" type="text" value="${escapeHtml(ip)}" placeholder="Ex.: 203.0.113.10" autocomplete="off"></label><div class="modal-note">A regra será criada pelo XAMPP Studio e poderá ser removida nesta tela. Esta ação exige iniciar o agente como administrador.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button danger-button" id="confirmBlockIp">Bloquear IP</button></div>`);
  $('#confirmBlockIp').onclick=async()=>{const button=$('#confirmBlockIp');button.disabled=true;button.textContent='Criando regra…';try{const result=await requestApi('/api/firewall/block',{method:'POST',body:JSON.stringify({ip:$('#firewallIpInput').value.trim()})});closeModal();recordActivity('IP bloqueado no Firewall',result.ip);await loadFirewall();toast(`IP ${result.ip} bloqueado.`)}catch(error){button.disabled=false;button.textContent='Bloquear IP';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};
}
$('#blockIpButton').addEventListener('click',()=>confirmBlockIp());
$('#blockedIpList').addEventListener('click',async event=>{const button=event.target.closest('.unblock-ip');if(!button)return;const ip=button.dataset.ip;showModal('REMOVER BLOQUEIO',`<h2>Desbloquear ${escapeHtml(ip)}?</h2><p class="modal-copy">O Studio removerá somente a regra que ele criou para este endereço.</p><div class="modal-actions"><button class="outline-button" id="cancelAction">Cancelar</button><button class="primary-button" id="confirmUnblockIp">Desbloquear</button></div>`);$('#confirmUnblockIp').onclick=async()=>{const confirm=$('#confirmUnblockIp');confirm.disabled=true;try{await requestApi('/api/firewall/unblock',{method:'POST',body:JSON.stringify({ip})});closeModal();recordActivity('Bloqueio de IP removido',ip);await loadFirewall();toast(`IP ${ip} desbloqueado.`)}catch(error){confirm.disabled=false;$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}}});

async function showCloudflareSetup(){
  if(state.cloudflareActive){showModal('REGRAS CLOUDFLARE ATIVAS',`<h2>Atualizar as faixas oficiais?</h2><p class="modal-copy">O Studio consulta a lista atual da Cloudflare, prepara novas regras e só remove as regras antigas depois da validação.</p><div class="modal-note">Você também pode remover a restrição. Nesse caso, as regras de porta que o Studio desativou serão restauradas. O bloqueio padrão do Firewall não será alterado.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Voltar</button><button class="outline-button" id="confirmCloudflareOff">Remover restrição</button><button class="primary-button" id="confirmCloudflareRefresh">Atualizar faixas</button></div>`);$('#confirmCloudflareRefresh').onclick=async()=>{const button=$('#confirmCloudflareRefresh');button.disabled=true;button.textContent='Consultando e validando…';try{const result=await requestApi('/api/firewall/cloudflare',{method:'POST',body:JSON.stringify({active:true})});closeModal();recordActivity('Faixas oficiais Cloudflare atualizadas',`${result.rangeCount} faixas · portas 80 e 443`);await loadFirewall();toast('Faixas Cloudflare atualizadas com segurança.')}catch(error){button.disabled=false;$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};$('#confirmCloudflareOff').onclick=async()=>{const button=$('#confirmCloudflareOff');button.disabled=true;button.textContent='Restaurando…';try{await requestApi('/api/firewall/cloudflare',{method:'POST',body:JSON.stringify({active:false})});closeModal();recordActivity('Restrição Cloudflare removida','Regras anteriores restauradas');await loadFirewall();toast('Restrição removida e regras anteriores restauradas.')}catch(error){button.disabled=false;$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}};return}
  try{state.cloudflarePreview=await requestApi('/api/firewall/cloudflare/preview');updateCloudflareDisplay();const preview=state.cloudflarePreview;const blockers=preview.blockers||[];const disable=(preview.rulesToDisable||[]).map(rule=>`<div><i>−</i> ${escapeHtml(rule.DisplayName||rule.displayName||rule.Name||rule.name)}</div>`).join('')||'<div><i>✓</i> Nenhuma regra HTTP/HTTPS existente precisa ser desativada.</div>';showModal('PRÉVIA DO FIREWALL CLOUDFLARE',`<h2>${preview.rangeCount} faixas oficiais verificadas</h2><p class="modal-copy">As conexões TCP nas portas 80 e 443 serão aceitas somente pelas faixas oficiais Cloudflare.</p><div class="checklist"><div><i>${preview.profiles?.every(profile=>profile.Enabled&&profile.DefaultInboundAction==='Block')?'✓':'!'}</i> Perfis ativos bloqueiam entrada por padrão.</div>${disable}</div>${blockers.length?`<div class="modal-note danger-note"><strong>Precisa de revisão:</strong><ul>${blockers.map(reason=>`<li>${escapeHtml(reason)}</li>`).join('')}</ul></div>`:'<div class="modal-note">O Studio desativa apenas regras TCP de 80/443 encontradas e guarda os nomes para restaurá-las. Se qualquer etapa falhar, desfaz as alterações.</div>'}<div class="modal-note">As faixas são consultadas novamente no momento de aplicar. Atualize-as periodicamente para acompanhar a Cloudflare.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button><button class="primary-button" id="confirmCloudflareOn" ${preview.safeToApply?'':'disabled'}>Ativar restrição</button></div>`);$('#confirmCloudflareOn').onclick=async()=>{const button=$('#confirmCloudflareOn');button.disabled=true;button.textContent='Aplicando regras…';try{const result=await requestApi('/api/firewall/cloudflare',{method:'POST',body:JSON.stringify({active:true})});closeModal();recordActivity('Acesso web restrito à Cloudflare',`${result.rangeCount} faixas oficiais · portas 80 e 443`);await loadFirewall();toast('Restrição Cloudflare ativada nas portas 80 e 443.')}catch(error){button.disabled=false;button.textContent='Tentar novamente';$('#modalContent').insertAdjacentHTML('beforeend',`<div class="modal-note">${escapeHtml(error.message)}</div>`)}}}
  catch(error){showModal('PRÉVIA DO FIREWALL CLOUDFLARE',`<h2>Não foi possível verificar</h2><p class="modal-copy">${escapeHtml(error.message)}</p><div class="modal-note">Nenhuma regra foi alterada. Verifique a conexão e atualize a prévia.</div><div class="modal-actions"><button class="outline-button" id="cancelAction">Fechar</button><button class="primary-button" id="retryCloudflare">Tentar novamente</button></div>`);$('#retryCloudflare').onclick=showCloudflareSetup}
}
$('#cloudflareAction').addEventListener('click',showCloudflareSetup);

/* --------------------------------------------------------------------------
   Atalhos de teclado
   -------------------------------------------------------------------------- */
const shortcuts={
  '1':()=>navigate('overview'),
  '2':()=>navigate('php'),
  '3':()=>navigate('apache'),
  '4':()=>navigate('mysql'),
  '5':()=>navigate('services'),
  '6':()=>navigate('activity'),
  'r':()=>$('#refreshStatus').click(),
  'd':()=>$('#diagnosticsButton').click(),
  '?':()=>$('#helpButton').click()
};
document.addEventListener('keydown',event=>{
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  const tag=document.activeElement?.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||document.activeElement?.isContentEditable)return;
  if(modal.open)return;
  const action=shortcuts[event.key.toLowerCase()];
  if(!action)return;
  event.preventDefault();
  action();
});
