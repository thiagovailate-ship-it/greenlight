'use strict';

/** Glob mínimo (estilo .gitignore) — `**`, `*` e `?`, sem dependências. */

function normalize(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function globToRegExp(pattern) {
  let p = normalize(pattern);
  if (!p) return /^$/;
  if (p.endsWith('/')) p += '**';

  let out = '';
  for (let i = 0; i < p.length; i += 1) {
    const char = p[i];
    if (char === '*') {
      if (p[i + 1] === '*') {
        i += 1;
        if (p[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      const end = p.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
      } else {
        const parts = p.slice(i + 1, end).split(',').map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&'));
        out += `(?:${parts.join('|')})`;
        i = end;
      }
    } else if (char === '[') {
      const end = p.indexOf(']', i);
      if (end === -1) {
        out += '\\[';
      } else {
        out += p.slice(i, end + 1);
        i = end;
      }
    } else {
      out += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

const cache = new Map();

function matchGlob(filePath, pattern) {
  const target = normalize(filePath);
  let re = cache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    if (cache.size > 500) cache.clear();
    cache.set(pattern, re);
  }
  if (re.test(target)) return true;
  // Sem barra, o padrão vale para qualquer segmento: `*.test.js` casa em `a/b/`.
  if (!normalize(pattern).includes('/')) {
    const base = target.split('/').pop();
    if (re.test(base)) return true;
    return new RegExp(`(?:^|/)${re.source.slice(1, -1)}(?:$|/)`).test(target);
  }
  return false;
}

function matchesAny(filePath, patterns) {
  return (patterns || []).some((pattern) => matchGlob(filePath, pattern));
}

module.exports = { matchGlob, matchesAny, normalize };
