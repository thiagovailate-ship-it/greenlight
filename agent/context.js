'use strict';

const fs = require('node:fs');
const path = require('node:path');

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function detectTestFramework(root, files = []) {
  const pkg = root ? safeReadJson(path.join(root, 'package.json')) : null;
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const scripts = pkg.scripts || {};
    if (deps.vitest) return 'vitest';
    if (deps.jest) return 'jest';
    if (deps.mocha) return 'mocha';
    if (String(scripts.test || '').includes('node --test')) return 'node:test';
    if (String(scripts.test || '').includes('vitest')) return 'vitest';
    if (String(scripts.test || '').includes('jest')) return 'jest';
  }
  if (root) {
    if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'pytest.ini'))) {
      return 'pytest';
    }
    if (fs.existsSync(path.join(root, 'go.mod'))) return 'go test';
    if (fs.existsSync(path.join(root, 'Gemfile'))) return 'rspec';
    if (fs.existsSync(path.join(root, 'composer.json'))) return 'phpunit';
  }
  const names = files.map((file) => file.path);
  if (names.some((name) => name.endsWith('_test.go'))) return 'go test';
  if (names.some((name) => /(^|\/)test_.*\.py$/.test(name))) return 'pytest';
  if (names.some((name) => /\.(test|spec)\.(js|ts|jsx|tsx)$/.test(name))) return 'node:test';
  return null;
}

function detectPackageManager(root) {
  if (!root) return null;
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return 'npm';
  if (fs.existsSync(path.join(root, 'poetry.lock'))) return 'poetry';
  if (fs.existsSync(path.join(root, 'go.mod'))) return 'go';
  return null;
}

function languageBreakdown(files) {
  const counts = {};
  for (const file of files) {
    if (file.isDoc || file.isConfig || file.binary) continue;
    counts[file.language] = (counts[file.language] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => ({ language, files: count }));
}

function buildContext({ root, files, index, overrides = {} }) {
  const source = files.filter((file) => !file.isTest && !file.isDoc && !file.isConfig && !file.binary);
  const tests = files.filter((file) => file.isTest && file.additions > 0);
  const testFramework =
    overrides.testFramework ||
    (index && index.testFramework) ||
    detectTestFramework(root, files) ||
    null;

  return {
    project: overrides.project || (index && index.projectName) || (root ? path.basename(root) : null),
    learned: Boolean(index),
    sourceChanged: source.map((file) => file.path),
    testsChanged: tests.map((file) => file.path),
    languages: languageBreakdown(files),
    testFramework,
    packageManager: (index && index.packageManager) || null,
    conventions: (index && index.conventions) || null,
    houseRules: 0,
  };
}

module.exports = { buildContext, detectTestFramework, detectPackageManager, languageBreakdown, safeReadJson };
