'use strict';

const HASH_COMMENT_LANGS = new Set(['py', 'rb', 'shell', 'yaml', 'terraform', 'make', 'docker', 'php']);
const CODE_LANGS = new Set([
  'js',
  'ts',
  'py',
  'go',
  'rb',
  'php',
  'java',
  'kotlin',
  'rust',
  'csharp',
  'swift',
  'sql',
  'shell',
  'terraform',
]);

function isCommentLine(content, language) {
  const text = String(content || '').trim();
  if (!text) return false;
  if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('*') || text.startsWith('<!--')) {
    return true;
  }
  if (HASH_COMMENT_LANGS.has(language) && text.startsWith('#')) return true;
  if (language === 'sql' && text.startsWith('--')) return true;
  return false;
}

/** Remove strings e comentários de linha para reduzir falsos positivos. */
function stripStrings(content) {
  return String(content || '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')
    .replace(/\/\/.*$/, '');
}

/** Remove literais de regex (heurística) para não ler padrões como código. */
function stripRegexLiterals(text) {
  return String(text || '').replace(
    /(^|[=(,:!&|?{};]\s*)\/(?![*/])(?:\\.|\[[^\]]*\]|[^/\\\n]){1,300}\/[gimsuy]*/g,
    '$1',
  );
}

/** Diz se a posição cai dentro de uma string/template literal da linha. */
function isInsideStringLiteral(text, index) {
  let quote = null;
  let escaped = false;
  const limit = Math.min(Math.max(index, 0), String(text || '').length);
  for (let i = 0; i < limit; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    }
  }
  return quote !== null;
}

function indentOf(content) {
  const match = /^[ \t]*/.exec(String(content || ''));
  return match ? match[0] : '';
}

function countIndent(content) {
  const indent = indentOf(content);
  let width = 0;
  for (const char of indent) width += char === '\t' ? 4 : 1;
  return width;
}

function infoSuggestion(title, language, code) {
  return { title, language, code, mode: 'info', applyable: false };
}

function replaceSuggestion(title, language, code, startLine, endLine) {
  return {
    title,
    language,
    code,
    mode: 'replace',
    applyable: Boolean(startLine && endLine),
    startLine: startLine || null,
    endLine: endLine || null,
  };
}

function testSuggestion(title, language, code, filename) {
  return { title, language, code, mode: 'test', applyable: false, filename };
}

function truncate(text, max = 180) {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Extrai o bloco balanceado por chaves a partir de uma linha (JS/TS/Go/Java). */
function findBraceBlockEnd(lines, startIndex) {
  let depth = 0;
  let opened = false;
  for (let i = startIndex; i < lines.length; i += 1) {
    const text = lines[i].content;
    for (let j = 0; j < text.length; j += 1) {
      const char = text[j];
      if (!opened) {
        // O `}` que fecha o bloco anterior (ex.: "} catch (e) {") não conta.
        if (char === '{') {
          opened = true;
          depth = 1;
        }
        continue;
      }
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    if (!opened && i > startIndex) return startIndex;
  }
  return opened ? lines.length - 1 : startIndex;
}

/** Bloco por indentação (Python): termina na primeira linha com indentação menor. */
function findIndentBlockEnd(lines, startIndex) {
  const baseIndent = countIndent(lines[startIndex].content);
  let sawIndented = false;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const text = lines[i].content;
    if (!text.trim()) continue;
    const indent = countIndent(text);
    if (indent > baseIndent) {
      sawIndented = true;
      continue;
    }
    return sawIndented ? i - 1 : startIndex;
  }
  return sawIndented ? lines.length - 1 : startIndex;
}

module.exports = {
  CODE_LANGS,
  isCommentLine,
  stripStrings,
  stripRegexLiterals,
  isInsideStringLiteral,
  indentOf,
  countIndent,
  infoSuggestion,
  replaceSuggestion,
  testSuggestion,
  truncate,
  findBraceBlockEnd,
  findIndentBlockEnd,
};
