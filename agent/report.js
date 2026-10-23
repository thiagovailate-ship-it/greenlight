'use strict';

const { SEVERITY_LABEL } = require('./findings');

const ICON = { pass: '✓', fail: '✗', warn: '!', skip: '-' };
const COLOR = {
  critical: '\u001b[91m',
  high: '\u001b[31m',
  medium: '\u001b[33m',
  low: '\u001b[36m',
  info: '\u001b[90m',
  accent: '\u001b[32m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  reset: '\u001b[0m',
};

function painter(enabled) {
  return (color, text) => (enabled && COLOR[color] ? `${COLOR[color]}${text}${COLOR.reset}` : String(text));
}

function verdictBadge(review) {
  if (review.verdict.status === 'ready') return '🟢';
  if (review.verdict.status === 'attention') return '🟡';
  return '🔴';
}

function toMarkdown(review) {
  const out = [];
  out.push(`# ${verdictBadge(review)} ${review.verdict.label}`);
  out.push('');
  out.push(`${review.verdict.reason}.`);
  out.push('');
  out.push(`> ${review.summary}`);
  out.push('');
  out.push('| Checagem | Resultado | Achados |');
  out.push('| --- | --- | ---: |');
  for (const check of review.checks) {
    out.push(`| ${ICON[check.status]} ${check.label} | ${check.summary} | ${check.findings} |`);
  }
  out.push('');
  out.push(
    `**${review.stats.files}** arquivos · **+${review.stats.additions}** −${review.stats.deletions} · ` +
      `${review.durationMs}ms · ${review.engine.rules} regras · LLM: ${review.engine.llm.status}`,
  );
  out.push('');
  if (review.findings.length === 0) {
    out.push('Nenhum problema encontrado.');
  } else {
    out.push('## Achados');
    for (const finding of review.findings) {
      out.push('');
      out.push(
        `### ${SEVERITY_LABEL[finding.severity]} · ${finding.title} ` +
          `\`${finding.ruleId}\` · \`${finding.file}:${finding.line}\``,
      );
      out.push('');
      out.push(finding.message);
      if (finding.why) {
        out.push('');
        out.push(`_Por quê:_ ${finding.why}`);
      }
      if (finding.code) {
        out.push('');
        out.push('```');
        out.push(finding.code);
        out.push('```');
      }
      if (finding.suggestion && finding.suggestion.code) {
        out.push('');
        out.push(`**${finding.suggestion.title || 'Correção sugerida'}**`);
        out.push('');
        out.push(`\`\`\`${finding.suggestion.language || 'text'}`);
        out.push(finding.suggestion.code.replace(/\n+$/, ''));
        out.push('```');
        if (finding.suggestion.filename) {
          out.push('');
          out.push(`Arquivo sugerido: \`${finding.suggestion.filename}\``);
        }
      }
    }
  }
  if (review.suppressed.total > 0) {
    out.push('');
    out.push(`_${review.suppressed.total} achado(s) dispensado(s)._`);
  }
  out.push('');
  out.push(
    `<sub>Greenlight ${review.engine.version} · ${review.id} · failOn=${review.config.failOn}</sub>`,
  );
  return `${out.join('\n')}\n`;
}

function toTerminal(review, options = {}) {
  const color = Boolean(options.color);
  const paint = painter(color);
  const out = [];
  const width = Math.min(Number(options.width) || 78, 100);
  const rule = paint('dim', '─'.repeat(width));

  out.push('');
  out.push(
    `${paint(review.verdict.status === 'ready' ? 'accent' : review.verdict.status === 'blocked' ? 'critical' : 'medium', '●')} ` +
      `${paint('bold', review.verdict.label)} ${paint('dim', `· failOn=${review.config.failOn}`)}`,
  );
  out.push(paint('dim', `  ${review.verdict.reason}.`));
  out.push(rule);
  for (const check of review.checks) {
    const tone =
      check.status === 'pass' ? 'accent' : check.status === 'fail' ? 'critical' : check.status === 'warn' ? 'medium' : 'dim';
    out.push(`  ${paint(tone, ICON[check.status])} ${check.label.padEnd(22)} ${paint('dim', check.summary)}`);
  }
  out.push(rule);
  out.push(
    `  ${review.stats.files} arquivos · +${review.stats.additions} −${review.stats.deletions} · ` +
      `${review.durationMs}ms · ${review.engine.rules} regras · LLM ${review.engine.llm.status}`,
  );

  if (review.findings.length > 0) {
    out.push('');
    for (const finding of review.findings) {
      const tone = finding.severity;
      const label = SEVERITY_LABEL[finding.severity].padEnd(8);
      out.push(`  ${paint(tone, label)} ${paint('bold', finding.title)}`);
      const origin = finding.source === 'llm' ? '  · LLM' : '';
      out.push(
        `  ${' '.repeat(8)} ` +
          paint('dim', `${finding.ruleId}  ${finding.file}:${finding.line}${origin}`),
      );
      out.push(`  ${' '.repeat(8)} ${finding.message}`);
      if (finding.suggestion && finding.suggestion.mode === 'replace' && finding.suggestion.applyable) {
        out.push(`  ${' '.repeat(8)} ${paint('dim', '→ correção aplicável: use --apply ' + finding.id)}`);
      }
    }
  } else {
    out.push('');
    out.push(`  ${paint('accent', 'Nenhum problema encontrado.')}`);
  }

  if (review.findings[0] && review.findings[0].suggestion && options.suggestion) {
    out.push('');
    out.push(paint('dim', '--- sugestão ---'));
    out.push(review.findings[0].suggestion.code);
  }

  out.push('');
  out.push(paint('dim', `  ${review.summary}`));
  if (review.suppressed.total > 0) {
    out.push(paint('dim', `  ${review.suppressed.total} achado(s) dispensado(s).`));
  }
  out.push('');
  return out.join('\n');
}

module.exports = { toMarkdown, toTerminal, verdictBadge, painter, COLOR };
