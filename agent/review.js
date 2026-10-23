'use strict';

const crypto = require('node:crypto');
const pkg = require('../package.json');
const { parseDiff, fileLines } = require('./diff');
const { normalizeConfig, loadConfig, isExcepted } = require('./config');
const { matchesAny } = require('./glob');
const { allRules, CORE_RULES } = require('./rules');
const { createFinding, dedupe, compareFindings, SEVERITY_RANK } = require('./findings');
const { buildChecks, buildVerdict, deterministicSummary } = require('./scoring');
const { buildContext } = require('./context');
const { loadIndex } = require('./learn');
const { loadMemory, applyDismissals } = require('./memory');
const { describeLlm, runLlmReview } = require('./llm');
const { isCommentLine } = require('./rules/util');

class ReviewError extends Error {
  constructor(message, code = 'REVIEW_INVALID') {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
  }
}

function parseSuppressions(files) {
  const map = new Map();
  for (const file of files) {
    for (const line of fileLines(file)) {
      if (line.type !== 'add') continue;
      const match = /greenlight-ignore(-next-line)?\b([^\n]*)/i.exec(line.content);
      if (!match) continue;
      const target = line.newLine + (match[1] ? 1 : 0);
      const rules = [...match[2].matchAll(/\b([A-Z]{2,6}\d{3}|LLM|ALL)\b/g)].map((item) => item[1]);
      const key = `${file.path}:${target}`;
      const set = map.get(key) || new Set();
      if (rules.length === 0) set.add('ALL');
      for (const rule of rules) set.add(rule);
      map.set(key, set);
    }
  }
  return map;
}

function isSuppressed(suppressions, finding) {
  const set = suppressions.get(`${finding.file}:${finding.line}`);
  if (!set) return false;
  return set.has('ALL') || set.has(finding.ruleId);
}

function ruleApplies(rule, file, content) {
  if (rule.scope && rule.scope !== 'line') return false;
  if (rule.testFilesOnly && !file.isTest) return false;
  if (rule.languages && !rule.languages.includes(file.language)) return false;
  if (rule.commentsOnly) return isCommentLine(content, file.language);
  if (rule.skipComments !== false && isCommentLine(content, file.language)) return false;
  return true;
}

function toFinding(rule, file, line, result) {
  if (!result) return null;
  const findingLine = Number.isInteger(result.line) && result.line > 0 ? result.line : line ? line.newLine : null;
  if (!findingLine) return null;
  return createFinding({
    ruleId: rule.id,
    title: result.title || rule.title,
    severity: result.severity || rule.severity,
    category: rule.category,
    file: result.file || file.path,
    line: findingLine,
    endLine: result.endLine || findingLine,
    message: result.message,
    why: result.why || '',
    code: result.code || (line ? line.content : ''),
    suggestion: result.suggestion || null,
    confidence: typeof result.confidence === 'number' ? result.confidence : 0.9,
    source: 'rule',
  });
}

function runLineRules({ files, rules, config, context, errors }) {
  const findings = [];
  const lineRules = rules.filter((rule) => !rule.scope || rule.scope === 'line');
  for (const file of files) {
    if (file.binary || file.ignored || file.additions === 0) continue;
    const lines = fileLines(file);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.type !== 'add') continue;
      for (const rule of lineRules) {
        if (!ruleApplies(rule, file, line.content)) continue;
        if (file.securityExcluded && rule.category === 'security') continue;
        let results;
        try {
          results = rule.run({ content: line.content, file, line, lines, index, config, context });
        } catch (error) {
          if (errors.length < 8 && !errors.some((item) => item.ruleId === rule.id)) {
            errors.push({ ruleId: rule.id, message: String(error.message || error).slice(0, 200) });
          }
          continue;
        }
        for (const result of Array.isArray(results) ? results : results ? [results] : []) {
          const finding = toFinding(rule, file, line, result);
          if (finding) findings.push(finding);
        }
      }
    }
  }
  return findings;
}

function runDiffRules({ files, rules, config, context, errors }) {
  const findings = [];
  for (const rule of rules.filter((item) => item.scope === 'diff')) {
    let results;
    try {
      results = rule.run({ files, config, context });
    } catch (error) {
      if (errors.length < 8 && !errors.some((item) => item.ruleId === rule.id)) {
        errors.push({ ruleId: rule.id, message: String(error.message || error).slice(0, 200) });
      }
      continue;
    }
    for (const result of Array.isArray(results) ? results : results ? [results] : []) {
      const finding = toFinding(rule, result && result.file ? { path: result.file } : { path: files[0]?.path }, null, result);
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

function filterFindings(findings, { suppressions, config, memory }) {
  let suppressed = 0;
  let exceptions = 0;
  const kept = [];
  for (const finding of dedupe(findings)) {
    if (isSuppressed(suppressions, finding)) {
      suppressed += 1;
      continue;
    }
    if (isExcepted(finding, config)) {
      exceptions += 1;
      continue;
    }
    kept.push(finding);
  }
  let dismissed = 0;
  let final = kept;
  if (memory) {
    const result = applyDismissals(kept, memory);
    final = result.findings;
    dismissed = result.dismissed.length;
  }
  return {
    findings: final.sort(compareFindings),
    counts: { suppressed, exceptions, dismissed },
  };
}

function stage(id, label, status, detail = null, ms = null) {
  return { type: 'stage', id, label, status, detail, ms };
}

function prepare(diffText, options) {
  if (typeof diffText !== 'string' || diffText.trim() === '') {
    throw new ReviewError('Envie um diff unificado para revisar.', 'EMPTY_DIFF');
  }
  const parsed = parseDiff(diffText, { defaultPath: options.defaultPath });
  if (parsed.files.length === 0) {
    throw new ReviewError(
      'Nenhum arquivo com alterações encontrado. O texto precisa estar em formato de diff unificado.',
      'INVALID_DIFF',
    );
  }

  const configResult = options.config
    ? normalizeConfig(options.config)
    : loadConfig(options.root || process.cwd());
  const config = configResult.config;
  if (options.failOn && SEVERITY_RANK[options.failOn]) {
    config.failOn = options.failOn;
  }
  const warnings = [...(configResult.warnings || []), ...parsed.errors];

  const files = parsed.files.map((file) => ({
    ...file,
    ignored: matchesAny(file.path, config.ignore),
    securityExcluded: matchesAny(file.path, config.security.excludePaths || []),
  }));

  const analyzable = files.filter((file) => !file.ignored && !file.binary && file.additions > 0);
  if (analyzable.length === 0 && parsed.stats.additions > 0) {
    throw new ReviewError(
      'Todas as alterações foram ignoradas pela configuração (ignore/security.excludePaths).',
      'NOTHING_TO_REVIEW',
    );
  }

  const root = options.root || process.cwd();
  const index = options.index !== undefined ? options.index : loadIndex(root);
  const context = buildContext({ root, files: analyzable, index, overrides: options.contextOverrides || {} });
  const rules = allRules(config);
  context.houseRules = config.rules.forbidImports.length + config.rules.custom.length;
  const memory = options.memory || (options.useMemory ? loadMemory(root) : null);
  const suppressions = parseSuppressions(files);
  const ruleErrors = [];

  return { parsed, config, warnings, files, analyzable, context, rules, memory, suppressions, ruleErrors };
}

/**
 * Pipeline da revisão. Emite eventos reais conforme cada etapa termina — é a
 * mesma fonte de verdade usada pelo CLI, pela API HTTP e pelo servidor SSE.
 */
async function* reviewPipeline(diffText, options = {}) {
  const startedAt = Date.now();
  const logger = typeof options.logger === 'function' ? options.logger : null;
  const { parsed, config, warnings, files, analyzable, context, rules, memory, suppressions, ruleErrors } =
    prepare(diffText, options);

  let mark = Date.now();
  yield stage('parse', 'Lendo o diff', 'running');
  yield stage(
    'parse',
    'Lendo o diff',
    'done',
    `${parsed.stats.files} ${parsed.stats.files === 1 ? 'arquivo' : 'arquivos'} · ` +
      `+${parsed.stats.additions} −${parsed.stats.deletions}`,
    Date.now() - mark,
  );

  mark = Date.now();
  yield stage('context', 'Carregando contexto', 'running');
  yield stage(
    'context',
    'Carregando contexto',
    'done',
    context.learned
      ? `índice de ${context.project || 'repositório'} · ${context.testFramework || 'testes não detectados'}`
      : 'sem índice local · usando o diff',
    Date.now() - mark,
  );

  const stageDefs = [
    { id: 'lint', label: 'Lint e regras da casa', categories: ['quality', 'house'] },
    { id: 'security', label: 'Segurança', categories: ['security'] },
    { id: 'bugs', label: 'Bugs e lógica', categories: ['bug'] },
  ];
  let allFindings = [];

  for (const def of stageDefs) {
    mark = Date.now();
    yield stage(def.id, def.label, 'running');
    const subset = rules.filter((rule) => def.categories.includes(rule.category));
    const found = runLineRules({ files: analyzable, rules: subset, config, context, errors: ruleErrors });
    allFindings = allFindings.concat(found);
    yield stage(
      def.id,
      def.label,
      'done',
      `${found.length} ${found.length === 1 ? 'achado' : 'achados'}`,
      Date.now() - mark,
    );
  }

  mark = Date.now();
  yield stage('tests', 'Testes e cobertura', 'running');
  const testLineRules = rules.filter((rule) => rule.category === 'tests' && (!rule.scope || rule.scope === 'line'));
  const testFindings = runLineRules({
    files: analyzable,
    rules: testLineRules,
    config,
    context,
    errors: ruleErrors,
  });
  const diffFindings = runDiffRules({ files: analyzable, rules, config, context, errors: ruleErrors });
  allFindings = allFindings.concat(testFindings, diffFindings);
  yield stage(
    'tests',
    'Testes e cobertura',
    'done',
    `${testFindings.length + diffFindings.length} ${testFindings.length + diffFindings.length === 1 ? 'achado' : 'achados'}`,
    Date.now() - mark,
  );

  const llmInfo = describeLlm(config, options.env || process.env);
  let llmResult = null;
  if (options.llm === false) {
    llmResult = {
      status: 'disabled',
      ...llmInfo,
      findings: [],
      summary: '',
      reason: 'desligado nesta revisão',
      durationMs: 0,
    };
  } else if (llmInfo.enabled && parsed.stats.additions > 0) {
    yield stage('llm', 'Revisão semântica (LLM)', 'running');
    llmResult = await runLlmReview({
      diff: diffText,
      files: analyzable,
      findings: allFindings,
      context,
      config,
      env: options.env || process.env,
      fetchImpl: options.fetchImpl,
      logger,
    });
    yield stage(
      'llm',
      'Revisão semântica (LLM)',
      llmResult.status === 'ok' ? 'done' : 'warn',
      llmResult.status === 'ok'
        ? `${llmResult.findings.length} ${llmResult.findings.length === 1 ? 'achado' : 'achados'} · ` +
            `${llmResult.provider}/${llmResult.model}`
        : llmResult.error || llmResult.reason || 'indisponível',
      llmResult.durationMs || 0,
    );
    allFindings = allFindings.concat(
      (llmResult.findings || []).map((finding) =>
        createFinding({
          ...finding,
          title: finding.title,
          message: finding.message,
          severity: finding.severity,
          category: finding.category,
          source: 'llm',
          ruleId: 'LLM',
        }),
      ),
    );
  } else {
    llmResult = {
      status: 'disabled',
      ...llmInfo,
      findings: [],
      summary: '',
      durationMs: 0,
    };
  }

  mark = Date.now();
  yield stage('score', 'Calculando o veredito', 'running');
  const filtered = filterFindings(allFindings, { suppressions, config, memory });
  const findings = filtered.findings;
  const checks = buildChecks(findings, config);
  const verdict = buildVerdict(findings, config);
  const deterministic = deterministicSummary(findings, parsed.stats, verdict);
  const summary =
    llmResult && llmResult.status === 'ok' && llmResult.summary ? llmResult.summary : deterministic;

  const suppressedTotal =
    filtered.counts.suppressed + filtered.counts.exceptions + filtered.counts.dismissed;

  const review = {
    id: `rv_${crypto.randomBytes(6).toString('hex')}`,
    version: 1,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    source: options.source || 'diff',
    repo: options.repo || null,
    stats: {
      ...parsed.stats,
      analyzedFiles: analyzable.length,
      ignoredFiles: files.filter((file) => file.ignored).length,
    },
    context: {
      project: context.project,
      learned: context.learned,
      languages: context.languages,
      testFramework: context.testFramework,
      testsChanged: context.testsChanged,
      sourceChanged: context.sourceChanged,
      conventions: context.conventions,
      houseRules: context.houseRules,
      configSource: configResultSource(options, config),
      configWarnings: warnings.slice(0, 10),
    },
    engine: {
      name: 'greenlight',
      version: pkg.version,
      deterministic: true,
      rules: rules.length,
      coreRules: CORE_RULES.length,
      ruleErrors,
      llm: {
        enabled: Boolean(llmInfo.enabled) && options.llm !== false,
        provider: llmInfo.provider,
        model: llmInfo.model,
        status: llmResult ? llmResult.status : 'disabled',
        durationMs: llmResult ? llmResult.durationMs || 0 : 0,
        error: llmResult && llmResult.error ? llmResult.error : null,
        redactions: llmResult && llmResult.redactions ? llmResult.redactions : 0,
        diffTruncated: Boolean(llmResult && llmResult.diffTruncated),
      },
    },
    checks,
    verdict,
    findings,
    summary,
    suppressed: {
      total: suppressedTotal,
      inCode: filtered.counts.suppressed,
      byException: filtered.counts.exceptions,
      dismissed: filtered.counts.dismissed,
    },
    config: {
      failOn: config.failOn,
      maxLineLength: config.rules.maxLineLength,
      testsRequired: config.tests.requireChangedTests,
      exceptions: config.exceptions.length,
      customRules: config.rules.custom.length,
      forbiddenImports: config.rules.forbidImports.length,
      github: { ...config.github },
    },
  };

  yield stage(
    'score',
    'Calculando o veredito',
    'done',
    `${findings.length} ${findings.length === 1 ? 'achado' : 'achados'} · ${verdict.label}`,
    Date.now() - mark,
  );
  yield { type: 'checks', checks };
  yield { type: 'findings', findings };
  yield { type: 'summary', summary };
  yield { type: 'done', review };

  if (logger) {
    logger(
      `review ${review.id}: ${findings.length} achados · ${verdict.status} · ${review.durationMs}ms · ` +
        `rules=${rules.length} llm=${review.engine.llm.status}`,
    );
  }
}

function configResultSource(options, config) {
  if (options.configSource) return options.configSource;
  if (options.config) return 'inline';
  return config.source ? '.greenlight.json' : null;
}

async function review(diffText, options = {}) {
  let result = null;
  for await (const event of reviewPipeline(diffText, options)) {
    if (event.type === 'done') result = event.review;
  }
  if (!result) throw new ReviewError('A revisão não produziu resultado.', 'REVIEW_FAILED');
  return result;
}

module.exports = { review, reviewPipeline, ReviewError, parseSuppressions, filterFindings };
