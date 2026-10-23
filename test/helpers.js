'use strict';

const { review } = require('../agent/review');

// Padrões de provedores reais montados em runtime: o código-fonte não contém
// o segredo literal (o que também evita bloqueios de push protection).
const FAKE_STRIPE_KEY = ['sk', 'live', '51NxExampleKeyForGreenlight1234567890'].join('_');
const FAKE_GITHUB_TOKEN = ['ghp', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_');
const FAKE_PRIVATE_KEY = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');

/**
 * Monta um diff de um arquivo a partir de linhas com prefixo:
 * ' ' contexto, '+' adicionada, '-' removida.
 */
function diffOf(filePath, lines, { status = 'modified', oldStart = 1, newStart = 1 } = {}) {
  const oldCount = lines.filter((line) => line.startsWith(' ') || line.startsWith('-')).length;
  const newCount = lines.filter((line) => line.startsWith(' ') || line.startsWith('+')).length;
  const body = lines.map((line) => (line === '' ? ' ' : line)).join('\n');
  const header =
    status === 'added'
      ? `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}`
      : `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}`;
  return `${header}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}\n`;
}

function additions(filePath, codeLines, options) {
  return diffOf(filePath, codeLines.split('\n').map((line) => `+${line}`), options);
}

/** Revisão determinística, sem índice e sem rede. */
function runReview(diff, overrides = {}) {
  return review(diff, {
    config: {
      tests: { requireChangedTests: false },
      ...(overrides.config || {}),
    },
    index: null,
    llm: false,
    ...overrides,
  });
}

function byRule(result, ruleId) {
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}

module.exports = { diffOf, additions, runReview, byRule, FAKE_STRIPE_KEY, FAKE_GITHUB_TOKEN, FAKE_PRIVATE_KEY };
