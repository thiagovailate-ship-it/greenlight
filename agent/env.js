'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text || '').split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!KEY.test(key)) continue;
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    values[key] = value;
  }
  return values;
}

/**
 * Lê `.env` da raiz sem sobrescrever variáveis já definidas no ambiente.
 * Sem dependências — o suficiente para um servidor de um arquivo.
 */
function loadEnv(root = process.cwd(), target = process.env) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return { loaded: false, file, count: 0 };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { loaded: false, file, count: 0 };
  }
  const values = parseEnv(text);
  let count = 0;
  for (const [key, value] of Object.entries(values)) {
    if (target[key] === undefined || target[key] === '') {
      target[key] = value;
      count += 1;
    }
  }
  return { loaded: true, file, count };
}

module.exports = { parseEnv, loadEnv };
