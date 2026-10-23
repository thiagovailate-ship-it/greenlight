'use strict';

/**
 * Parser de diff unificado (git diff, `diff -u` e patches da API do GitHub).
 * Não depende de git: recebe texto e devolve arquivos, hunks e linhas com os
 * números de linha antigos e novos — é isso que permite comentar exatamente
 * na linha certa do PR.
 */

const path = require('node:path');

const LANGUAGE_BY_EXT = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'ts',
  '.py': 'py',
  '.go': 'go',
  '.rb': 'rb',
  '.php': 'php',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.rs': 'rust',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.json': 'json',
  '.tf': 'terraform',
};

const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const CONFIG_EXT = new Set([
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.lock',
  '.editorconfig',
  '.gitignore',
  '.dockerignore',
  '.npmrc',
]);

const SPECIAL_NAMES = {
  dockerfile: 'docker',
  makefile: 'make',
  'go.mod': 'go',
  'go.sum': 'go',
};

function languageOf(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (SPECIAL_NAMES[base]) return SPECIAL_NAMES[base];
  return LANGUAGE_BY_EXT[path.extname(base)] || 'text';
}

function isTestPath(filePath) {
  const p = filePath.replace(/\\/g, '/');
  return (
    /(^|\/)(__tests__|tests?|specs?|fixtures?|e2e)\//i.test(p) ||
    /(^|\/)[^/]+\.(test|spec)\.[a-z0-9]+$/i.test(p) ||
    /(^|\/)test_[^/]+\.py$/i.test(p) ||
    /_test\.(py|go|rb)$/i.test(p) ||
    /(^|\/)[^/]+_spec\.rb$/i.test(p) ||
    /(^|\/)[^/]+\.test\.(ts|js|tsx|jsx)$/i.test(p)
  );
}

function isDocPath(filePath) {
  const p = filePath.replace(/\\/g, '/');
  return DOC_EXT.has(path.extname(p).toLowerCase()) || /(^|\/)docs?\//i.test(p);
}

function isConfigPath(filePath) {
  const p = filePath.replace(/\\/g, '/');
  const base = path.basename(p).toLowerCase();
  return (
    CONFIG_EXT.has(path.extname(base)) ||
    ['package.json', 'tsconfig.json', 'go.mod', 'dockerfile', 'makefile'].includes(base)
  );
}

function emptyFile(filePath) {
  return {
    path: filePath,
    oldPath: filePath,
    status: 'modified',
    binary: false,
    language: languageOf(filePath),
    isTest: isTestPath(filePath),
    isDoc: isDocPath(filePath),
    isConfig: isConfigPath(filePath),
    additions: 0,
    deletions: 0,
    hunks: [],
  };
}

function parseHunkHeader(header) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(header);
  if (!match) return null;
  return {
    header,
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    section: match[5] || '',
    lines: [],
  };
}

function cleanGitPath(value) {
  let p = value.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      p = JSON.parse(p);
    } catch {
      p = p.slice(1, -1);
    }
  }
  if (p === '/dev/null') return '/dev/null';
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/**
 * @param {string} text diff unificado
 * @param {{defaultPath?: string}} [options]
 * @returns {{files: object[], stats: object, errors: string[]}}
 */
function parseDiff(text, options = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('parseDiff espera uma string com o diff.');
  }

  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const files = [];
  const errors = [];
  let current = null;
  let hunk = null;
  let sawHunk = false;

  const startFile = (filePath) => {
    current = emptyFile(filePath);
    files.push(current);
    hunk = null;
  };

  const ensureFile = () => {
    if (!current) {
      startFile(options.defaultPath || 'diff');
      errors.push('Diff sem cabeçalho de arquivo; usando o caminho padrão.');
    }
    return current;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const filePath = match ? match[2] : options.defaultPath || 'diff';
      startFile(filePath);
      if (match) current.oldPath = match[1];
      continue;
    }

    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      startFile(line.replace(/^diff --(?:cc|combined) /, ''));
      current.status = 'modified';
      continue;
    }

    if (hunk) {
      const first = line.charAt(0);
      if (first === '+' && !line.startsWith('+++ ')) {
        hunk.lines.push({
          type: 'add',
          content: line.slice(1),
          oldLine: null,
          newLine: hunk.newCursor,
          added: true,
        });
        hunk.newCursor += 1;
        current.additions += 1;
        continue;
      }
      if (first === '-' && !line.startsWith('--- ')) {
        hunk.lines.push({
          type: 'del',
          content: line.slice(1),
          oldLine: hunk.oldCursor,
          newLine: null,
          added: false,
        });
        hunk.oldCursor += 1;
        current.deletions += 1;
        continue;
      }
      if (first === ' ') {
        hunk.lines.push({
          type: 'context',
          content: line.slice(1),
          oldLine: hunk.oldCursor,
          newLine: hunk.newCursor,
          added: false,
        });
        hunk.oldCursor += 1;
        hunk.newCursor += 1;
        continue;
      }
      if (first === '\\') {
        hunk.lines.push({
          type: 'meta',
          content: line.slice(1),
          oldLine: null,
          newLine: null,
          added: false,
        });
        continue;
      }
      if (line === '') {
        // Alguns geradores removem o espaço inicial de linhas de contexto vazias.
        hunk.lines.push({
          type: 'context',
          content: '',
          oldLine: hunk.oldCursor,
          newLine: hunk.newCursor,
          added: false,
        });
        hunk.oldCursor += 1;
        hunk.newCursor += 1;
        continue;
      }
      hunk = null;
    }

    if (line.startsWith('@@')) {
      ensureFile();
      const parsed = parseHunkHeader(line);
      if (!parsed) {
        errors.push(`Cabeçalho de hunk inválido: ${line.slice(0, 80)}`);
        continue;
      }
      parsed.oldCursor = parsed.oldStart;
      parsed.newCursor = parsed.newStart;
      current.hunks.push(parsed);
      hunk = parsed;
      sawHunk = true;
      continue;
    }

    if (line.startsWith('--- ')) {
      if (!current || (!hunk && current.hunks.length > 0 && current.path !== options.defaultPath)) {
        startFile(options.defaultPath || 'diff');
      }
      ensureFile();
      const oldPath = cleanGitPath(line.slice(4));
      if (oldPath === '/dev/null') {
        current.status = 'added';
      } else {
        current.oldPath = oldPath;
        if (current.status === 'modified' && current.path === 'diff') current.path = oldPath;
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      ensureFile();
      const newPath = cleanGitPath(line.slice(4));
      if (newPath === '/dev/null') {
        current.status = 'deleted';
      } else {
        if (current.status === 'added' || current.path === 'diff' || current.path === options.defaultPath) {
          current.path = newPath;
          current.language = languageOf(newPath);
          current.isTest = isTestPath(newPath);
          current.isDoc = isDocPath(newPath);
          current.isConfig = isConfigPath(newPath);
        }
      }
      continue;
    }

    if (line.startsWith('new file mode')) {
      ensureFile().status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      ensureFile().status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      ensureFile().oldPath = line.slice(12).trim();
      continue;
    }
    if (line.startsWith('rename to ')) {
      const f = ensureFile();
      f.path = line.slice(10).trim();
      f.language = languageOf(f.path);
      f.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      ensureFile().binary = true;
      continue;
    }
    if (
      line.startsWith('index ') ||
      line.startsWith('similarity index ') ||
      line.startsWith('dissimilarity index ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('copy from ') ||
      line.startsWith('copy to ')
    ) {
      continue;
    }
  }

  for (const file of files) {
    if (file.status === 'modified' && file.oldPath !== file.path) file.status = 'renamed';
    if (file.path === '/dev/null') file.path = file.oldPath;
  }

  const usable = files.filter((file) => file.hunks.length > 0 || file.binary);
  if (!sawHunk) {
    errors.push('Nenhum hunk (@@ … @@) encontrado no diff.');
  }

  return {
    files: usable,
    stats: {
      files: usable.length,
      additions: usable.reduce((sum, file) => sum + file.additions, 0),
      deletions: usable.reduce((sum, file) => sum + file.deletions, 0),
      hunks: usable.reduce((sum, file) => sum + file.hunks.length, 0),
      binary: usable.filter((file) => file.binary).length,
    },
    errors,
  };
}

/** Todas as linhas de hunk, na ordem, com o índice do hunk. */
function fileLines(file) {
  const result = [];
  file.hunks.forEach((hunk, hunkIndex) => {
    hunk.lines.forEach((line) => {
      result.push({ ...line, hunkIndex });
    });
  });
  return result;
}

/** Apenas linhas adicionadas, com hunk e índice dentro do arquivo. */
function addedLines(file) {
  return fileLines(file).filter((line) => line.type === 'add');
}

/** Converte a lista de arquivos da API do GitHub (`files[]` com patch) em diff. */
function diffFromGitHubFiles(files) {
  const chunks = [];
  for (const file of files || []) {
    if (!file || !file.filename) continue;
    const before = file.status === 'added' ? '/dev/null' : `a/${file.previous_filename || file.filename}`;
    const after = file.status === 'removed' ? '/dev/null' : `b/${file.filename}`;
    chunks.push(`diff --git a/${file.previous_filename || file.filename} b/${file.filename}`);
    if (file.status === 'added') chunks.push('new file mode 100644');
    if (file.status === 'removed') chunks.push('deleted file mode 100644');
    chunks.push(`--- ${before}`);
    chunks.push(`+++ ${after}`);
    if (file.patch) chunks.push(file.patch);
    else if (file.status !== 'modified') chunks.push('');
    chunks.push('');
  }
  return chunks.join('\n');
}

module.exports = {
  parseDiff,
  addedLines,
  fileLines,
  diffFromGitHubFiles,
  languageOf,
  isTestPath,
  isDocPath,
  isConfigPath,
};
