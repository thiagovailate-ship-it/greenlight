'use strict';

const crypto = require('node:crypto');

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

const SEVERITY_RANK = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const SEVERITY_LABEL = {
  critical: 'crítico',
  high: 'alto',
  medium: 'médio',
  low: 'baixo',
  info: 'info',
};

const CATEGORY_LABEL = {
  security: 'Segurança',
  bug: 'Bugs',
  quality: 'Qualidade',
  tests: 'Testes',
  house: 'Regras da casa',
};

function rank(severity) {
  return SEVERITY_RANK[severity] || 0;
}

function atLeast(severity, threshold) {
  return rank(severity) >= rank(threshold);
}

function fingerprint(parts) {
  return crypto
    .createHash('sha256')
    .update(parts.filter(Boolean).join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Normaliza um achado bruto de regra/LLM em um objeto estável e serializável.
 */
function createFinding(input) {
  const severity = SEVERITY_RANK[input.severity] ? input.severity : 'medium';
  const category = CATEGORY_LABEL[input.category] ? input.category : 'quality';
  const code = String(input.code || '').slice(0, 400);
  const file = String(input.file || 'diff');
  const line = Number.isInteger(input.line) && input.line > 0 ? input.line : null;
  const ruleId = String(input.ruleId || 'GEN000');

  return {
    id: fingerprint([ruleId, file, line, input.title, code.trim()]),
    ruleId,
    title: input.title,
    severity,
    category,
    check: input.check || checkForCategory(category),
    file,
    line,
    endLine: input.endLine || line,
    message: input.message,
    why: input.why || '',
    code,
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.9,
    source: input.source === 'llm' ? 'llm' : 'rule',
    suggestion: input.suggestion || null,
    docs: input.docs || '',
  };
}

function checkForCategory(category) {
  if (category === 'security') return 'security';
  if (category === 'tests') return 'tests';
  if (category === 'bug') return 'bugs';
  return 'lint';
}

function compareFindings(a, b) {
  if (rank(a.severity) !== rank(b.severity)) return rank(b.severity) - rank(a.severity);
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  return (a.line || 0) - (b.line || 0);
}

function dedupe(findings) {
  const byFingerprint = new Map();
  for (const finding of findings) {
    const key = fingerprint([finding.ruleId, finding.file, finding.line, finding.code.trim()]);
    const existing = byFingerprint.get(key);
    if (!existing) {
      byFingerprint.set(key, finding);
      continue;
    }
    // Mantém a versão de maior confiança (o LLM costuma complementar a regra).
    if (finding.confidence > existing.confidence) byFingerprint.set(key, finding);
  }
  return [...byFingerprint.values()].sort(compareFindings);
}

function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function countByCategory(findings) {
  const counts = {};
  for (const finding of findings) counts[finding.category] = (counts[finding.category] || 0) + 1;
  return counts;
}

function summarizeCounts(counts) {
  const parts = [];
  for (const severity of SEVERITIES) {
    if (counts[severity]) parts.push(`${counts[severity]} ${SEVERITY_LABEL[severity]}`);
  }
  return parts.join(' · ');
}

module.exports = {
  SEVERITIES,
  SEVERITY_RANK,
  SEVERITY_LABEL,
  CATEGORY_LABEL,
  rank,
  atLeast,
  fingerprint,
  createFinding,
  checkForCategory,
  compareFindings,
  dedupe,
  countBySeverity,
  countByCategory,
  summarizeCounts,
};
