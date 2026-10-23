#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
const { review, ReviewError } = require('../agent/review');
const { catalog, allRules, CORE_RULES } = require('../agent/rules');
const { loadConfig } = require('../agent/config');
const { syncRepo, loadIndex, indexSummary } = require('../agent/learn');
const { loadMemory, dismissFinding } = require('../agent/memory');
const { describeLlm } = require('../agent/llm');
const { toMarkdown, toTerminal } = require('../agent/report');
const { applySuggestion } = require('../agent/patch');
const { diffFromGitHubFiles } = require('../agent/diff');
const { GitHubClient, buildReviewPayload, parseRepoRef } = require('../agent/github');
const { loadEnv } = require('../agent/env');

const HELP = `
greenlight — revisão de pull requests com agente de código

Uso:
  gl review [diff]            Revisa um diff unificado (arquivo, "-" para stdin)
  gl review --pr <repo#n>     Revisa um pull request real do GitHub
  gl rules                    Lista as regras ativas
  gl sync                     Aprende o repositório (índice e convenções)
  gl dismiss <id>             Dispensa um achado da última revisão
  gl last [--json]            Mostra a última revisão salva
  gl doctor                   Diagnóstico de configuração
  gl help | --version

Opções de review:
  --json                Saída JSON completa
  --markdown            Saída Markdown (para colar em issue/PR)
  --fail-on <nível>     critical | high | medium | low | info
  --no-llm              Só o motor determinístico
  --apply <id>          Aplica a correção sugerida de um achado
  --write               Com --apply, grava o diff corrigido no arquivo
  --save                Salva em .greenlight/last-review.json
  --comment             (com --pr) publica a revisão no PR
  --quiet               Só o veredito e o código de saída

Variáveis:
  GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, GREENLIGHT_LLM=off
`;

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function flagValue(args, name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function positional(args) {
  const withValue = new Set(['--fail-on', '--apply', '--pr', '--out', '--reason', '--root']);
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (withValue.has(arg)) i += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function saveLastReview(root, reviewResult) {
  const dir = path.join(root, '.greenlight');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'last-review.json');
  fs.writeFileSync(file, JSON.stringify(reviewResult, null, 2) + '\n');
  return file;
}

function loadLastReview(root) {
  const file = path.join(root, '.greenlight', 'last-review.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function ensureRoot(args) {
  return path.resolve(flagValue(args, 'root', process.cwd()));
}

async function runReview(args) {
  const root = ensureRoot(args);
  const prRef = flagValue(args, 'pr');
  const wantJson = hasFlag(args, 'json');
  const wantMarkdown = hasFlag(args, 'markdown');
  const noLlm = hasFlag(args, 'no-llm');
  const quiet = hasFlag(args, 'quiet');
  const failOn = flagValue(args, 'fail-on');
  const applyId = flagValue(args, 'apply');
  const color = process.stdout.isTTY && !process.env.NO_COLOR && !wantJson && !wantMarkdown;

  let diffText;
  let source = 'diff';
  let repoInfo = null;
  let github = null;

  if (prRef) {
    const parsedRef = parseRepoRef(prRef);
    if (!parsedRef) {
      console.error('Referência de PR inválida. Use owner/repo#123 ou a URL do pull request.');
      return 2;
    }
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      console.error('Defina GITHUB_TOKEN para revisar um PR do GitHub.');
      return 2;
    }
    github = new GitHubClient({ token });
    const pr = await github.getPullRequest(parsedRef.repo, parsedRef.number);
    const files = await github.listPullRequestFiles(parsedRef.repo, parsedRef.number);
    diffText = diffFromGitHubFiles(files);
    source = 'github';
    repoInfo = {
      repo: parsedRef.repo,
      number: parsedRef.number,
      title: pr.title,
      url: pr.html_url,
      commit: pr.head && pr.head.sha,
      draft: pr.draft,
    };
  } else {
    const target = positional(args).find((arg) => !['review'].includes(arg));
    if (!target || target === '-') {
      if (process.stdin.isTTY) {
        console.error('Passe um arquivo de diff, "-" para stdin, ou use --pr owner/repo#123.');
        return 2;
      }
      diffText = await readStdin();
    } else {
      diffText = fs.readFileSync(path.resolve(root, target), 'utf8');
    }
  }

  let result = await review(diffText, {
    root,
    source,
    repo: repoInfo,
    llm: noLlm ? false : undefined,
    failOn: failOn || undefined,
    useMemory: hasFlag(args, 'memory') || Boolean(process.env.GREENLIGHT_MEMORY),
  });

  let patchedDiff = null;
  if (applyId) {
    const finding = result.findings.find((item) => item.id === applyId || item.id.startsWith(applyId));
    if (!finding) {
      console.error(`Achado ${applyId} não está nesta revisão.`);
      return 2;
    }
    patchedDiff = applySuggestion(diffText, { file: finding.file, suggestion: finding.suggestion });
    if (hasFlag(args, 'write') && prRef === null) {
      const target = positional(args).find((arg) => !['review'].includes(arg));
      if (target && target !== '-') {
        fs.writeFileSync(path.resolve(root, target), patchedDiff);
        console.error(`Diff corrigido gravado em ${target}.`);
      }
    }
    result = await review(patchedDiff, {
      root,
      source,
      repo: repoInfo,
      llm: noLlm ? false : undefined,
      failOn: failOn || undefined,
    });
  }

  const saved = hasFlag(args, 'save') || applyId ? saveLastReview(root, result) : null;

  if (wantJson) {
    process.stdout.write(`${JSON.stringify({ ...result, patchedDiff }, null, 2)}\n`);
  } else if (wantMarkdown) {
    process.stdout.write(toMarkdown(result));
  } else if (quiet) {
    process.stdout.write(`${result.verdict.label}\n`);
  } else {
    if (patchedDiff && !hasFlag(args, 'write')) {
      process.stdout.write(`${patchedDiff}\n`);
    }
    process.stdout.write(toTerminal(result, { color }) + '\n');
    if (saved) process.stdout.write(`  revisão salva em ${path.relative(root, saved)}\n`);
  }

  if (github && hasFlag(args, 'comment') && repoInfo) {
    const payload = buildReviewPayload(result, {
      maxInlineComments: result.config.github.maxInlineComments,
      event: hasFlag(args, 'request-changes') ? 'REQUEST_CHANGES' : undefined,
    });
    await github.createReview(repoInfo.repo, repoInfo.number, {
      commit_id: repoInfo.commit,
      body: payload.body,
      comments: payload.comments,
      event: payload.event === 'REQUEST_CHANGES' ? 'REQUEST_CHANGES' : 'COMMENT',
    });
    process.stderr.write(`Revisão publicada em ${repoInfo.url}\n`);
  }

  return result.verdict.exitCode;
}

async function runRules(args) {
  const root = ensureRoot(args);
  const { config, warnings } = loadConfig(root);
  const rules = catalog(config);
  const icon = { critical: '🟥', high: '🟧', medium: '🟨', low: '🟦', info: '⬜' };
  const house = allRules(config).length - CORE_RULES.length;
  console.log(
    `\n${allRules(config).length} regras ativas · ${CORE_RULES.length} fixas · ${house} da casa\n`,
  );
  const byCategory = {};
  for (const rule of rules) (byCategory[rule.category] = byCategory[rule.category] || []).push(rule);
  for (const [category, list] of Object.entries(byCategory)) {
    console.log(`${category.toUpperCase()}`);
    for (const rule of list) {
      console.log(`  ${icon[rule.severity]} ${rule.id.padEnd(7)} ${rule.title}`);
      if (rule.description) console.log(`          ${rule.description}`);
    }
    console.log('');
  }
  if (warnings.length) console.log(`Avisos: ${warnings.join(' | ')}`);
  return 0;
}

async function runSync(args) {
  const root = ensureRoot(args);
  const started = Date.now();
  const index = syncRepo(root);
  console.log(indexSummary(index));
  console.log(`\nÍndice gravado em .greenlight/index.json em ${Date.now() - started}ms.`);
  return 0;
}

async function runDismiss(args) {
  const root = ensureRoot(args);
  const id = positional(args).find((arg) => !['dismiss'].includes(arg));
  const last = loadLastReview(root);
  if (!last) {
    console.error('Nenhuma revisão salva. Rode `gl review --save` antes de dispensar.');
    return 2;
  }
  const finding = last.findings.find((item) => item.id === id || item.id.startsWith(String(id)));
  if (!finding) {
    console.error(`Achado ${id} não está na última revisão.`);
    return 2;
  }
  const reason = flagValue(args, 'reason', '');
  const entry = dismissFinding(root, finding, reason);
  console.log(`Dispensado: ${entry.title} (${entry.file}:${entry.line}) — ${entry.reason || 'sem motivo'}`);
  const memory = loadMemory(root);
  console.log(`Histórico: ${memory.dismissed.length} dispensa(s) em .greenlight/memory.json`);
  return 0;
}

async function runLast(args) {
  const root = ensureRoot(args);
  const last = loadLastReview(root);
  if (!last) {
    console.error('Nenhuma revisão salva.');
    return 2;
  }
  if (hasFlag(args, 'json')) process.stdout.write(`${JSON.stringify(last, null, 2)}\n`);
  else process.stdout.write(toMarkdown(last));
  return 0;
}

async function runDoctor(args) {
  const root = ensureRoot(args);
  const { config, warnings } = loadConfig(root);
  const index = loadIndex(root);
  const llm = describeLlm(config);
  const memory = loadMemory(root);
  const checks = [
    ['node', process.version, true],
    ['diretório', root, true],
    ['config', config.source ? path.relative(root, config.source) : 'padrões embutidos', true],
    ['regras', String(allRules(config).length), true],
    ['índice', index ? `gerado em ${index.generatedAt}` : 'ausente (rode gl sync)', Boolean(index)],
    ['testes', index ? index.testFramework || 'não detectado' : '—', true],
    ['LLM', llm.enabled ? `${llm.provider} · ${llm.model}` : `off (${llm.reason})`, true],
    ['GitHub token', process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? 'presente' : 'ausente', true],
    ['GitHub App', process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY ? 'configurado' : 'ausente', true],
    ['dispensas', String(memory.dismissed.length), true],
    ['revisões no histórico', String(memory.stats.reviews), true],
    ['GREENLIGHT_MEMORY', process.env.GREENLIGHT_MEMORY ? 'ligado (CLI)' : 'desligado (CLI)', true],
  ];
  console.log('');
  for (const [label, value, ok] of checks) {
    console.log(`  ${ok ? '✓' : '!'} ${label.padEnd(24)} ${value}`);
  }
  if (warnings.length) {
    console.log('');
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
  console.log('');
  return 0;
}

async function main(argv) {
  const args = argv.slice(2);
  const command = args[0] || 'help';
  if (command !== 'help') loadEnv(process.cwd());

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(pkg.version);
    return 0;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP.trim());
    return 0;
  }

  try {
    if (command === 'review') return await runReview(args);
    if (command === 'rules') return await runRules(args);
    if (command === 'sync') return await runSync(args);
    if (command === 'dismiss') return await runDismiss(args);
    if (command === 'last') return await runLast(args);
    if (command === 'doctor') return await runDoctor(args);
    if (fs.existsSync(command) && !command.startsWith('-')) return await runReview(['review', ...args]);
    console.error(`Comando desconhecido: ${command}\n`);
    console.log(HELP.trim());
    return 2;
  } catch (error) {
    if (error instanceof ReviewError) {
      console.error(`Erro: ${error.message}`);
      return 2;
    }
    console.error(`Falha: ${error.message}`);
    if (process.env.DEBUG) console.error(error.stack);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main, parseRepoRef };
