/**
 * Camada de acesso ao agente local.
 *
 * Todas as chamadas passam pelo mesmo ponto: o navegador fala apenas com o
 * processo local em 127.0.0.1 e os erros chegam como mensagem legível.
 */

export async function requestApi(path, options={}){
  if(location.protocol==='file:')throw new Error('Esta página foi aberta como arquivo. Execute start.ps1 e abra http://127.0.0.1:43197 para habilitar as ações locais.');
  const response=await fetch(path,{cache:'no-store',...options,headers:{'content-type':'application/json',...(options.headers||{})}});
  const result=await response.json();if(!response.ok)throw new Error(result.error||`Falha HTTP ${response.status}`);return result;
}
