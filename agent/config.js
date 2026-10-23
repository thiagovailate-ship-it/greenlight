'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SEVERITY_RANK } = require('./findings');
const { matchesAny } = require('./glob');

const CONFIG_FILENAME = '.greenlight.json';

const DEFAULTS = {
  version: 1,
  failOn: 'high',
  ignore: [
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    'coverage/**',
    '.next/**',
    '.venv/**',
    '__pycache__/**',
    '.greenlight/**',
    '*.min.js',
    '*.lock',
  ],
  checks: {
    lint: true,
    bugs: true,
    tests: true,
    security: true,
  },
  tests: {
    requireChangedTests: true,
    testFilePatterns: ['**/*.test.js', '**/*.test.ts', '**/test_*.py', '**/*_test.go', '**/*_spec.rb'],
  },
  rules: {
    maxLineLength: 140,
    forbidImports: [],
    custom: [],
  },
  security: {
    excludePaths: [],
  },
  exceptions: [],
  github: {
    requestChanges: false,
    reviewDrafts: false,
    maxInlineComments: 20,
    checks: true,
  },
  llm: {
    enabled: true,
  },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, extra) {
  if (!isPlainObject(extra)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function validateSeverity(value, fallback, warnings, field) {
  if (value === undefined) return fallback;
  if (SEVERITY_RANK[value]) return value;
  warnings.push(`${field} inválido (${JSON.stringify(value)}); usando "${fallback}".`);
  return fallback;
}

function normalizeConfig(raw, warnings = []) {
  const merged = deepMerge(DEFAULTS, raw || {});

  merged.failOn = validateSeverity(merged.failOn, 'high', warnings, 'failOn');
  merged.ignore = Array.isArray(merged.ignore) ? merged.ignore.map(String) : [...DEFAULTS.ignore];

  for (const check of Object.keys(DEFAULTS.checks)) {
    merged.checks[check] = merged.checks[check] !== false;
  }

  merged.rules = deepMerge(DEFAULTS.rules, isPlainObject(merged.rules) ? merged.rules : {});
  const maxLineLength = Number(merged.rules.maxLineLength);
  merged.rules.maxLineLength =
    Number.isFinite(maxLineLength) && maxLineLength >= 40 ? maxLineLength : DEFAULTS.rules.maxLineLength;
  merged.rules.forbidImports = Array.isArray(merged.rules.forbidImports)
    ? merged.rules.forbidImports.filter((item) => item && typeof item.package === 'string')
    : [];
  merged.rules.custom = Array.isArray(merged.rules.custom)
    ? merged.rules.custom
        .filter((rule) => rule && typeof rule.id === 'string' && typeof rule.pattern === 'string')
        .map((rule) => ({
          id: rule.id.slice(0, 20),
          pattern: rule.pattern,
          message: String(rule.message || `Padrão proibido (${rule.id}).`),
          severity: SEVERITY_RANK[rule.severity] ? rule.severity : 'medium',
          files: Array.isArray(rule.files) ? rule.files.map(String) : null,
          suggestion: typeof rule.suggestion === 'string' ? rule.suggestion : '',
        }))
    : [];

  merged.security.excludePaths = Array.isArray(merged.security.excludePaths)
    ? merged.security.excludePaths.map(String)
    : [];

  merged.exceptions = Array.isArray(merged.exceptions)
    ? merged.exceptions
        .filter((item) => item && typeof item.rule === 'string' && Array.isArray(item.paths))
        .map((item) => ({
          rule: item.rule,
          paths: item.paths.map(String),
          reason: String(item.reason || ''),
        }))
    : [];

  merged.tests.requireChangedTests = merged.tests.requireChangedTests !== false;
  merged.github.requestChanges = merged.github.requestChanges === true;
  merged.github.reviewDrafts = merged.github.reviewDrafts === true;
  merged.github.checks = merged.github.checks !== false;
  merged.github.maxInlineComments = Math.min(
    Math.max(Number(merged.github.maxInlineComments) || DEFAULTS.github.maxInlineComments, 0),
    100,
  );
  merged.llm.enabled = merged.llm.enabled !== false;
  if (merged.llm.model && String(merged.llm.model).length > 80) {
    merged.llm.model = String(merged.llm.model).slice(0, 80);
    warnings.push('llm.model truncado em 80 caracteres.');
  }
  if (merged.llm.baseUrl) {
    // Base URL só pode vir do ambiente: um repositório não deve redirecionar
    // os dados da revisão para um endpoint escolhido por quem abre o PR.
    delete merged.llm.baseUrl;
    warnings.push('llm.baseUrl ignorado no arquivo de configuração; use OPENAI_BASE_URL.');
  }

  return { config: merged, warnings };
}

function loadConfig(root = process.cwd()) {
  const file = path.join(root, CONFIG_FILENAME);
  const warnings = [];
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      warnings.push(`Não foi possível ler ${CONFIG_FILENAME}: ${error.message}`);
    }
  }
  if (process.env.GREENLIGHT_FAIL_ON) raw = { ...raw, failOn: process.env.GREENLIGHT_FAIL_ON };
  const result = normalizeConfig(raw, warnings);
  result.source = fs.existsSync(file) ? file : null;
  result.config.source = result.source;
  return result;
}

function isExcepted(finding, config) {
  return (config.exceptions || []).some(
    (exception) =>
      (exception.rule === '*' || exception.rule === finding.ruleId) &&
      matchesAny(finding.file, exception.paths),
  );
}

module.exports = {
  CONFIG_FILENAME,
  DEFAULTS,
  normalizeConfig,
  loadConfig,
  isExcepted,
  deepMerge,
};
