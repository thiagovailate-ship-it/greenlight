'use strict';

const { atLeast, countBySeverity, summarizeCounts, SEVERITY_LABEL } = require('./findings');

const CHECKS = [
  { id: 'lint', label: 'Lint', categories: ['quality', 'house'], warnAt: 'low' },
  { id: 'bugs', label: 'Bugs', categories: ['bug'], warnAt: 'medium' },
  { id: 'tests', label: 'Testes', categories: ['tests'], warnAt: 'medium' },
  { id: 'security', label: 'Segurança', categories: ['security'], warnAt: 'low' },
];

function checkForFinding(finding) {
  return CHECKS.find((check) => check.categories.includes(finding.category)) || CHECKS[0];
}

function buildChecks(findings, config) {
  return CHECKS.map((check) => {
    if (config.checks[check.id] === false) {
      return {
        id: check.id,
        label: check.label,
        status: 'skip',
        summary: 'desligada na configuração',
        findings: 0,
        blocking: 0,
      };
    }
    const relevant = findings.filter((finding) => finding.check === check.id);
    const blocking = relevant.filter((finding) => atLeast(finding.severity, config.failOn));
    const warnings = relevant.filter((finding) => atLeast(finding.severity, check.warnAt));
    let status = 'pass';
    let summary = 'sem problemas';
    if (blocking.length > 0) {
      status = 'fail';
      summary = `${blocking.length} ${blocking.length === 1 ? 'bloqueio' : 'bloqueios'}`;
    } else if (warnings.length > 0) {
      status = 'warn';
      summary = `${warnings.length} ${warnings.length === 1 ? 'aviso' : 'avisos'}`;
    }
    return {
      id: check.id,
      label: check.label,
      status,
      summary,
      findings: relevant.length,
      blocking: blocking.length,
      counts: countBySeverity(relevant),
    };
  });
}

function buildVerdict(findings, config) {
  const counts = countBySeverity(findings);
  const blocking = findings.filter((finding) => atLeast(finding.severity, config.failOn));
  const notable = findings.filter((finding) => finding.severity !== 'info');

  if (blocking.length > 0) {
    const worst = blocking[0];
    return {
      status: 'blocked',
      label: 'Merge bloqueado',
      reason: `${blocking.length} ${blocking.length === 1 ? 'achado' : 'achados'} em ${config.failOn} ou acima`,
      detail:
        `O mais grave é ${worst.ruleId} (${SEVERITY_LABEL[worst.severity]}) em ` +
        `${worst.file}:${worst.line}. Limite configurado: failOn=${config.failOn}.`,
      counts,
      exitCode: 1,
    };
  }

  if (notable.length > 0) {
    return {
      status: 'attention',
      label: 'Atenção antes do merge',
      reason: `${summarizeCounts(counts)} — nenhum bloqueio em failOn=${config.failOn}`,
      detail: 'Vale resolver os achados ou registrar por que ficam para depois.',
      counts,
      exitCode: 0,
    };
  }

  return {
    status: 'ready',
    label: 'Pronto para o merge',
    reason: findings.length === 0 ? 'nenhum problema encontrado' : 'apenas observações',
    detail: 'Todas as checagens passaram.',
    counts,
    exitCode: 0,
  };
}

function deterministicSummary(findings, stats, verdict) {
  const head = `${stats.files} ${stats.files === 1 ? 'arquivo' : 'arquivos'}, +${stats.additions} −${stats.deletions}.`;
  if (findings.length === 0) {
    return `${head} Nenhum problema encontrado — sinal verde.`;
  }
  const counts = countBySeverity(findings);
  const top = findings
    .slice(0, 2)
    .map((finding) => `${finding.title} (${finding.file}:${finding.line})`)
    .join('; ');
  return `${head} ${findings.length} ${findings.length === 1 ? 'achado' : 'achados'} — ${summarizeCounts(counts)}. ` +
    `${verdict.label}. Principais: ${top}.`;
}

module.exports = { CHECKS, checkForFinding, buildChecks, buildVerdict, deterministicSummary };
