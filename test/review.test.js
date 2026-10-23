'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { review, ReviewError } = require('../agent/review');
const { normalizeConfig } = require('../agent/config');
const { dismissFinding, loadMemory } = require('../agent/memory');
const { diffOf, additions, runReview, byRule, FAKE_STRIPE_KEY } = require('./helpers');

test('veredito ready quando não há achados', async () => {
  const result = await runReview(additions('src/sum.ts', 'export const sum = (a, b) => a + b'));
  assert.equal(result.verdict.status, 'ready');
  assert.equal(result.verdict.exitCode, 0);
  assert.equal(result.checks.length, 4);
  assert.ok(result.checks.every((check) => check.status === 'pass'));
});

test('veredito blocked respeita failOn', async () => {
  const diff = additions('src/a.ts', `const key = '${FAKE_STRIPE_KEY}'`);
  const strict = await runReview(diff, { config: { failOn: 'high' } });
  assert.equal(strict.verdict.status, 'blocked');
  assert.equal(strict.verdict.exitCode, 1);

  const relaxed = await runReview(diff, { config: { failOn: 'critical' } });
  assert.equal(relaxed.verdict.status, 'blocked');
});

test('atenção quando o achado fica abaixo de failOn', async () => {
  const result = await runReview(additions('src/a.ts', "console.log('debug')"), { config: { failOn: 'high' } });
  assert.equal(result.verdict.status, 'attention');
  assert.equal(result.verdict.exitCode, 0);
});

test('greenlight-ignore na linha silencia a regra', async () => {
  const result = await runReview(additions('src/a.ts', "console.log('debug') // greenlight-ignore LNT001"));
  assert.equal(byRule(result, 'LNT001').length, 0);
  assert.equal(result.suppressed.inCode, 1);
});

test('greenlight-ignore sem regra silencia tudo na linha', async () => {
  const result = await runReview(additions('src/a.ts', `const key = '${FAKE_STRIPE_KEY}' // greenlight-ignore`));
  assert.equal(result.findings.length, 0);
});

test('greenlight-ignore-next-line silencia a linha seguinte', async () => {
  const result = await runReview(additions('src/a.ts', "// greenlight-ignore-next-line LNT001\nconsole.log('debug')"));
  assert.equal(byRule(result, 'LNT001').length, 0);
});

test('exceções do .greenlight.json são respeitadas', async () => {
  const result = await runReview(additions('agent/rules/x.ts', "console.log('debug')"), {
    config: { exceptions: [{ rule: 'LNT001', paths: ['agent/rules/**'], reason: 'teste' }] },
  });
  assert.equal(byRule(result, 'LNT001').length, 0);
  assert.equal(result.suppressed.byException, 1);
});

test('arquivos ignorados não são analisados', async () => {
  const diff = diffOf('dist/bundle.js', ['+console.log("x")']);
  await assert.rejects(
    () => runReview(diff, { config: { ignore: ['dist/**'] } }),
    (error) => error instanceof ReviewError && error.code === 'NOTHING_TO_REVIEW',
  );
});

test('diff inválido e diff vazio têm erros claros', async () => {
  await assert.rejects(() => review(''), (error) => error.code === 'EMPTY_DIFF');
  await assert.rejects(() => review('texto sem diff'), (error) => error.code === 'INVALID_DIFF');
  await assert.rejects(() => review('diff --git a/x b/y\n--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n', {
    config: { ignore: ['**'] },
  }), (error) => error.code === 'NOTHING_TO_REVIEW');
});

test('TST001 dispara quando não há teste no diff e TST002 quando o export não é citado', async () => {
  const noTest = await review(additions('src/api.ts', 'export function createUser() {}'), {
    config: {},
    index: null,
    llm: false,
  });
  assert.equal(byRule(noTest, 'TST001').length, 1);
  assert.equal(byRule(noTest, 'TST001')[0].suggestion.mode, 'test');

  const withTest = await review(
    additions('src/api.ts', 'export function createUser() {}\n\nexport function deleteUser() {}') +
      additions('test/api.test.ts', "import { createUser } from '../src/api'\n\ntest('cria', () => { createUser() })"),
    { config: {}, index: null, llm: false },
  );
  assert.equal(byRule(withTest, 'TST001').length, 0);
  const uncovered = byRule(withTest, 'TST002');
  assert.equal(uncovered.length, 1);
  assert.match(uncovered[0].message, /deleteUser/);
});

test('TST003 aponta .only em arquivo de teste', async () => {
  const result = await runReview(additions('test/foo.test.js', "test.only('um caso', () => {})"), {
    config: { tests: { requireChangedTests: true } },
  });
  const [finding] = byRule(result, 'TST003');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
});

test('dispensa persistida em memória remove o achado da revisão', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'greenlight-'));
  const diff = additions('src/a.ts', "console.log('debug')");
  const first = await review(diff, { root, config: {}, index: null, llm: false });
  const target = byRule(first, 'LNT001')[0];
  dismissFinding(root, target, 'log esperado no CLI');
  const second = await review(diff, { root, config: {}, index: null, llm: false, useMemory: true });
  assert.equal(byRule(second, 'LNT001').length, 0);
  assert.equal(second.suppressed.dismissed, 1);
  const memory = loadMemory(root);
  assert.equal(memory.dismissed[0].reason, 'log esperado no CLI');
  fs.rmSync(root, { recursive: true, force: true });
});

test('dispensar um achado não silencia achados iguais em outras linhas', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'greenlight-'));
  const diff = additions(
    'src/config.ts',
    `const apiKey = '${FAKE_STRIPE_KEY}'\nconst clientSecret = 'outro-segredo-bem-grande-123'`,
  );
  const first = await review(diff, { root, config: {}, index: null, llm: false });
  const secrets = first.findings.filter((finding) => finding.ruleId === 'SEC001');
  assert.equal(secrets.length, 2);
  dismissFinding(root, secrets[0], 'aceito');
  const second = await review(diff, { root, config: {}, index: null, llm: false, useMemory: true });
  const remaining = second.findings.filter((finding) => finding.ruleId === 'SEC001');
  assert.equal(remaining.length, 1);
  assert.equal(second.suppressed.dismissed, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('config normaliza valores inválidos com avisos', () => {
  const { config, warnings } = normalizeConfig({
    failOn: 'altíssimo',
    rules: { maxLineLength: 10, custom: [{ id: 'X1' }, { id: 'X2', pattern: 'foo', message: 'sem foo' }] },
    llm: { baseUrl: 'http://evil.example' },
    github: { maxInlineComments: 500 },
  });
  assert.equal(config.failOn, 'high');
  assert.equal(config.rules.maxLineLength, 140);
  assert.equal(config.rules.custom.length, 1);
  assert.equal(config.llm.baseUrl, undefined);
  assert.equal(config.github.maxInlineComments, 100);
  assert.ok(warnings.length >= 2);
});

test('regras da casa: import proibido e padrão customizado', async () => {
  const result = await runReview(
    additions('src/date.ts', "import moment from 'moment'\nconst x = new Date()"),
    {
      config: {
        rules: {
          forbidImports: [{ package: 'moment', reason: 'use date-fns' }],
          custom: [{ id: 'HOU900', pattern: 'new Date\\(', message: 'Use o Clock injetado', severity: 'low' }],
        },
      },
    },
  );
  assert.equal(byRule(result, 'HOU001').length, 1);
  assert.equal(byRule(result, 'HOU900').length, 1);
});

test('resultado é serializável e estável', async () => {
  const result = await runReview(additions('src/a.ts', 'const a = 1\nconst b = 2'));
  const json = JSON.parse(JSON.stringify(result));
  assert.equal(json.verdict.status, result.verdict.status);
  assert.match(json.id, /^rv_[0-9a-f]{12}$/);
  assert.equal(json.engine.name, 'greenlight');
});

test('regras da casa da configuração real não quebram o repositório', async () => {
  const { loadConfig } = require('../agent/config');
  const { config } = loadConfig(path.join(__dirname, '..'));
  assert.ok(Array.isArray(config.exceptions));
  assert.equal(config.failOn, 'high');
});
