'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { languageOf, isTestPath, isConfigPath, isDocPath } = require('./diff');
const { detectTestFramework, detectPackageManager, safeReadJson } = require('./context');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'target',
  '.cache',
  '.idea',
  '.vscode',
  '.greenlight',
  'tmp',
]);

const MAX_FILES = 6000;
const MAX_READ_BYTES = 120_000;

function walk(root) {
  const files = [];
  const queue = [''];
  let truncated = false;

  while (queue.length > 0 && files.length < MAX_FILES) {
    const relative = queue.shift();
    const absolute = path.join(root, relative);
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.greenlight.json') {
        if (entry.isDirectory()) continue;
      }
      if (entry.isSymbolicLink()) continue;
      const childRelative = path.posix.join(relative.replace(/\\/g, '/'), entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = fs.statSync(path.join(root, childRelative)).size;
      } catch {
        size = 0;
      }
      files.push({ path: childRelative, size });
    }
  }

  return { files, truncated };
}

function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_READ_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function detectConventions(root, files) {
  const samples = files
    .filter((file) => ['js', 'ts', 'jsx', 'tsx'].includes(languageOf(file.path)))
    .slice(0, 40);
  let singleQuotes = 0;
  let doubleQuotes = 0;
  let semicolonLines = 0;
  let statementLines = 0;
  let tabs = 0;
  let twoSpaces = 0;
  let fourSpaces = 0;

  for (const sample of samples) {
    const text = readText(path.join(root, sample.path));
    if (!text) continue;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      singleQuotes += (line.match(/'/g) || []).length;
      doubleQuotes += (line.match(/"/g) || []).length;
      if (/[;{}]\s*$/.test(trimmed)) {
        statementLines += 1;
        if (trimmed.endsWith(';')) semicolonLines += 1;
      }
      if (/^\t/.test(line)) tabs += 1;
      else if (/^ {4}\S/.test(line)) fourSpaces += 1;
      else if (/^ {2}\S/.test(line)) twoSpaces += 1;
    }
  }

  const indent =
    tabs > twoSpaces && tabs > fourSpaces ? 'tabs' : fourSpaces > twoSpaces ? '4 espaços' : '2 espaços';

  return {
    quotes: singleQuotes >= doubleQuotes ? 'simples' : 'duplas',
    semicolons: statementLines > 0 ? semicolonLines / statementLines > 0.5 : null,
    indent,
    sampledFiles: samples.length,
  };
}

function readProject(root) {
  const pkg = safeReadJson(path.join(root, 'package.json'));
  const pyproject = readText(path.join(root, 'pyproject.toml'));
  const goMod = readText(path.join(root, 'go.mod'));
  const gemfile = readText(path.join(root, 'Gemfile'));
  const composer = safeReadJson(path.join(root, 'composer.json'));

  let name = null;
  const scripts = (pkg && pkg.scripts) || {};
  if (pkg && pkg.name) name = pkg.name;
  else if (pyproject) {
    const match = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject);
    if (match) name = match[1];
  } else if (goMod) {
    const match = /^module\s+(\S+)/m.exec(goMod);
    if (match) name = match[1].split('/').pop();
  } else if (composer && composer.name) name = composer.name;

  return {
    name: name || path.basename(root),
    scripts,
    dependencies: pkg ? Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }) : [],
    hasPython: Boolean(pyproject),
    hasGo: Boolean(goMod),
    hasRuby: Boolean(gemfile),
    hasPhp: Boolean(composer),
  };
}

function summarizeList(values, limit = 5) {
  const list = values.slice(0, limit);
  return values.length > limit ? `${list.join(', ')} +${values.length - limit}` : list.join(', ');
}

function syncRepo(root) {
  const { files, truncated } = walk(root);
  const project = readProject(root);
  const languages = {};
  let sourceFiles = 0;
  let testFiles = 0;
  let totalBytes = 0;

  for (const file of files) {
    totalBytes += file.size;
    if (isTestPath(file.path)) testFiles += 1;
    if (isDocPath(file.path) || isConfigPath(file.path)) continue;
    sourceFiles += 1;
    const language = languageOf(file.path);
    languages[language] = (languages[language] || 0) + 1;
  }

  const readme = ['README.md', 'README.mdx', 'README.txt']
    .map((name) => readText(path.join(root, name)))
    .find(Boolean);

  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    projectName: project.name,
    testFramework: detectTestFramework(root, files),
    packageManager: detectPackageManager(root),
    scripts: project.scripts,
    dependencies: project.dependencies.slice(0, 80),
    counts: {
      files: files.length,
      sourceFiles,
      testFiles,
      totalBytes,
      truncated,
    },
    languages: Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .map(([language, count]) => ({ language, files: count })),
    conventions: detectConventions(root, files),
    topLevel: [...new Set(
      files
        .map((file) => file.path.split('/')[0])
        .filter((name) => name && !name.includes('.')),
    )].slice(0, 15),
    readme: readme ? readme.replace(/\s+/g, ' ').trim().slice(0, 1200) : '',
  };

  const dir = path.join(root, '.greenlight');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'index.json');
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(index, null, 2) + '\n');
  fs.renameSync(temp, target);
  return index;
}

function loadIndex(root) {
  try {
    const file = path.join(root || process.cwd(), '.greenlight', 'index.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function indexSummary(index) {
  if (!index) return 'Nenhum índice ainda. Rode `gl sync` para ensinar o agente sobre o repositório.';
  const languages = summarizeList(index.languages.map((item) => `${item.language} (${item.files})`), 4);
  return [
    `Projeto: ${index.projectName}`,
    `Arquivos: ${index.counts.files} · fonte: ${index.counts.sourceFiles} · testes: ${index.counts.testFiles}`,
    `Linguagens: ${languages || 'não detectadas'}`,
    `Framework de teste: ${index.testFramework || 'não detectado'}`,
    `Convenções: ${index.conventions.indent}, aspas ${index.conventions.quotes}` +
      (index.conventions.semicolons === null ? '' : `, ponto e vírgula: ${index.conventions.semicolons ? 'sim' : 'não'}`),
    `Gerado em: ${index.generatedAt}`,
  ].join('\n');
}

module.exports = { syncRepo, loadIndex, indexSummary, walk, detectConventions, readProject };
