/**
 * Camada de acesso ao agente local.
 *
 * Todas as chamadas passam pelo mesmo ponto: o navegador fala apenas com o
 * processo local em 127.0.0.1 e os erros chegam como mensagem legível.
 */

const DEFAULT_TIMEOUT = 30000;

export async function requestApi(path, options={}){
  if(location.protocol==='file:')throw new Error('Esta página foi aberta como arquivo. Execute start.ps1 e abra http://127.0.0.1:43197 para habilitar as ações locais.');
  const { timeout = DEFAULT_TIMEOUT, signal, headers, ...request } = options;
  const controller = new AbortController();
  const limit = Number(timeout);
  let timedOut = false;
  const timer = Number.isFinite(limit) && limit > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, limit) : null;
  const forwardAbort = () => controller.abort();
  if(signal){
    if(signal.aborted)controller.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  try{
    const response = await fetch(path, {
      cache: 'no-store',
      ...request,
      headers: { 'content-type': 'application/json', ...(headers || {}) },
      signal: controller.signal
    });
    const text = await response.text();
    let result = null;
    if(text.trim()){try{result = JSON.parse(text)}catch{result = null}}
    if(!response.ok){
      const message = typeof result?.error === 'string' && result.error
        ? result.error
        : text.trim().slice(0, 240) || `Falha HTTP ${response.status}`;
      const failure = new Error(message);
      failure.status = response.status;
      throw failure;
    }
    if(result === null && text.trim())throw new Error('O agente local respondeu em um formato inesperado.');
    return result ?? {};
  }catch(error){
    if(error?.name === 'AbortError'){
      const failure = new Error(timedOut
        ? `O agente local não respondeu em ${Math.round(limit / 1000)} s.`
        : 'A requisição ao agente local foi cancelada.');
      failure.status = 0;
      throw failure;
    }
    if(error instanceof TypeError){
      const failure = new Error('Não foi possível falar com o agente local. Confirme que o start.ps1 está em execução.');
      failure.status = 0;
      throw failure;
    }
    throw error;
  }finally{
    if(timer)clearTimeout(timer);
    if(signal)signal.removeEventListener('abort', forwardAbort);
  }
}
