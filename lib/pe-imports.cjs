'use strict';

const fs = require('node:fs');

/**
 * Leitura mínima de PE (Portable Executable) para o Windows:
 * - tabela de importação (regular e delay import) com os nomes das funções;
 * - tabela de exportação, para conferir se uma DLL oferece os símbolos exigidos.
 *
 * O Studio usa isso para descobrir por que uma extensão PHP não carrega no
 * contexto do Apache: no Windows o carregador resolve dependências pelo NOME
 * do arquivo, então o Apache já carregado (por exemplo o OpenSSL do mod_ssl)
 * vence o runtime do PHP e pode não exportar os símbolos que a extensão exige.
 */

function parsePe(file) {
  let buffer;
  try { buffer = fs.readFileSync(file); }
  catch { return null; }
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (!Number.isFinite(peOffset) || peOffset + 24 > buffer.length) return null;
  if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null;

  try {
    const coff = peOffset + 4;
  const sectionCount = buffer.readUInt16LE(coff + 2);
  const optionalSize = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  if (optional + 2 > buffer.length) return null;
  const magic = buffer.readUInt16LE(optional);
  const pe32Plus = magic === 0x20b;
  const dataDirectory = optional + (pe32Plus ? 112 : 96);
  if (dataDirectory + 8 > buffer.length) return null;

  const sectionTable = optional + optionalSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const start = sectionTable + index * 40;
    if (start + 40 > buffer.length) break;
    sections.push({
      virtualAddress: buffer.readUInt32LE(start + 12),
      virtualSize: buffer.readUInt32LE(start + 8),
      raw: buffer.readUInt32LE(start + 20),
      rawSize: buffer.readUInt32LE(start + 16)
    });
  }

  const rvaToOffset = rva => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) return section.raw + (rva - section.virtualAddress);
    }
    return null;
  };
  const readString = offset => {
    let end = offset;
    while (end < buffer.length && buffer[end]) end++;
    return buffer.toString('ascii', offset, end);
  };

  const readThunks = (lookupRva, pe32) => {
    const functions = [];
    let offset = rvaToOffset(lookupRva);
    while (offset !== null && offset + 8 <= buffer.length) {
      const value = pe32 ? buffer.readBigUInt64LE(offset) : BigInt(buffer.readUInt32LE(offset));
      if (value === 0n) break;
      if (value & 0x8000000000000000n) functions.push({ ordinal: Number(value & 0xffffn), name: null });
      else {
        const hintOffset = rvaToOffset(Number(value));
        functions.push(hintOffset === null ? { ordinal: null, name: null } : { ordinal: null, name: readString(hintOffset + 2) });
      }
      offset += pe32 ? 8 : 4;
      if (functions.length > 512) break;
    }
    return functions;
  };

  const imports = [];
  const importRva = buffer.readUInt32LE(dataDirectory + 8);
  if (importRva) {
    let offset = rvaToOffset(importRva);
    while (offset !== null && offset + 20 <= buffer.length) {
      const nameRva = buffer.readUInt32LE(offset + 12);
      const thunkRva = buffer.readUInt32LE(offset);
      const originalThunkRva = buffer.readUInt32LE(offset + 16);
      if (!nameRva && !thunkRva) break;
      const nameOffset = rvaToOffset(nameRva);
      const dll = nameOffset === null ? '' : readString(nameOffset);
      const lookup = originalThunkRva || thunkRva;
      imports.push({ dll, functions: lookup ? readThunks(lookup, pe32Plus) : [] });
      offset += 20;
    }
  }
  const delayRva = buffer.readUInt32LE(dataDirectory + 13 * 8);
  if (delayRva) {
    const offset = rvaToOffset(delayRva);
    if (offset !== null) {
      for (let index = 0; index < 64 && offset + 32 <= buffer.length; index++) {
        const attributes = buffer.readUInt32LE(offset);
        const nameRva = buffer.readUInt32LE(offset + 4);
        const moduleHandle = buffer.readUInt32LE(offset + 8);
        const delayIat = buffer.readUInt32LE(offset + 12);
        const delayInt = buffer.readUInt32LE(offset + 16);
        if (!attributes && !nameRva) break;
        const nameOffset = rvaToOffset(nameRva);
        const dll = nameOffset === null ? '' : readString(nameOffset);
        const lookup = delayInt || delayIat;
        imports.push({ dll, functions: lookup ? readThunks(lookup, pe32Plus) : [] });
        offset += 32;
        if (!moduleHandle && !delayIat) break;
      }
    }
  }

  const exports = [];
  const exportRva = buffer.readUInt32LE(dataDirectory);
  if (exportRva) {
    const exportOffset = rvaToOffset(exportRva);
    if (exportOffset !== null) {
      const nameCount = buffer.readUInt32LE(exportOffset + 24);
      const namesRva = buffer.readUInt32LE(exportOffset + 32);
      const namesOffset = rvaToOffset(namesRva);
      if (namesOffset !== null) {
        for (let index = 0; index < nameCount; index++) {
          const nameRva = buffer.readUInt32LE(namesOffset + index * 4);
          const nameOffset = rvaToOffset(nameRva);
          if (nameOffset !== null) exports.push(readString(nameOffset));
        }
      }
    }
  }

  return { imports, exports };
  } catch {
    // DLL malformada ou truncada: sem tabelas legíveis, o runtime não pode
    // ser avaliado — o chamador trata null/[] como "sem dados" em vez de
    // receber uma exceção crua no meio de uma troca de versão.
    return null;
  }
}

/** Nomes das DLLs importadas (regular + delay import). */
function readPeImports(file) {
  const parsed = parsePe(file);
  if (!parsed) return [];
  const names = [];
  for (const entry of parsed.imports) {
    if (entry.dll && !names.includes(entry.dll)) names.push(entry.dll);
  }
  return names;
}

/** Importações com os símbolos exigidos: [{ dll, functions: [{ name }] }]. */
function readPeImportSymbols(file) {
  const parsed = parsePe(file);
  if (!parsed) return [];
  return parsed.imports
    .filter(entry => entry.dll)
    .map(entry => ({ dll: entry.dll, functions: entry.functions.map(item => item.name).filter(Boolean) }));
}

/** Nomes exportados pela DLL. */
function readPeExports(file) {
  const parsed = parsePe(file);
  if (!parsed) return [];
  return parsed.exports;
}

module.exports = { readPeImports, readPeImportSymbols, readPeExports };
