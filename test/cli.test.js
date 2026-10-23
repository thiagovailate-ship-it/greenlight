'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'greenlight.js');

function run(args, { input = '' } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    env: { ...process.env, GREENLIGHT_LLM: 'off', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('--version e help', () => {
  assert.equal(run(['--version']).stdout.trim(), '1.0.0');
  const help = run(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /gl review/);
  assert.match(help.stdout, /--pr/);
});

test('comando desconhecido sai com 2', () => {
  const result = run(['nao-existe']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /desconhecido/);
});

test('rules lista o catálogo com a configuração efetiva', () => {
  const result = run(['rules']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /42 regras ativas/);
  assert.match(result.stdout, /SEC001/);
  assert.match(result.stdout, /TST001/);
});

test('review --quiet devolve o veredito e o código de saída', () => {
  const clean = run(['review', 'samples/clean.diff', '--quiet']);
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout.trim(), 'Pronto para o merge');

  const blocked = run(['review', 'samples/secret-sql.diff', '--quiet']);
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stdout.trim(), 'Merge bloqueado');
});

test('review --json e --markdown são serializáveis', () => {
  const json = run(['review', 'samples/retry.diff', '--json']);
  assert.equal(json.status, 0);
  const review = JSON.parse(json.stdout);
  assert.equal(review.verdict.status, 'attention');
  assert.equal(review.findings[0].ruleId, 'BUG001');

  const md = run(['review', 'samples/retry.diff', '--markdown']);
  assert.match(md.stdout, /^# 🟡 Atenção antes do merge/m);
  assert.match(md.stdout, /\| Checagem \| Resultado \|/);
});

test('--fail-on muda o bloqueio', () => {
  const strict = run(['review', 'samples/retry.diff', '--fail-on', 'medium', '--quiet']);
  assert.equal(strict.status, 1);
  assert.equal(strict.stdout.trim(), 'Merge bloqueado');

  // O exemplo tem apenas achados altos: com failOn=critical, nada bloqueia.
  const relaxed = run(['review', 'samples/secret-sql.diff', '--fail-on', 'critical', '--quiet']);
  assert.equal(relaxed.status, 0);
  assert.equal(relaxed.stdout.trim(), 'Atenção antes do merge');
});

test('stdin funciona como fonte do diff', () => {
  const result = run(['review', '-', '--quiet'], {
    input: 'diff --git a/docs/guia.md b/docs/guia.md\n--- a/docs/guia.md\n+++ b/docs/guia.md\n@@ -1 +1 @@\n-antigo\n+novo\n',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'Pronto para o merge');
});

test('diff vazio sai com 2 e mensagem clara', () => {
  const result = run(['review', '-'], { input: '' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /diff/i);
});

test('--apply imprime o diff corrigido e re-revisa', () => {
  const first = JSON.parse(run(['review', 'samples/retry.diff', '--json']).stdout);
  const finding = first.findings[0];
  const result = run(['review', 'samples/retry.diff', '--apply', finding.id]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /RETRY_DELAY \* 2 \*\* i/);
  assert.match(result.stdout, /Pronto para o merge/);
});

test('doctor mostra o estado sem segredos', () => {
  const result = run(['doctor']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /node/);
  assert.match(result.stdout, /\.greenlight\.json/);
  assert.equal(result.stdout.includes(process.env.GITHUB_TOKEN || 'sem-token'), false);
});
