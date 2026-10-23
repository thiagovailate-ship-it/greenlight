'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createServer } = require('../server');

const RETRY = fs.readFileSync(path.join(__dirname, '..', 'samples', 'retry.diff'), 'utf8');
const SECRET = fs.readFileSync(path.join(__dirname, '..', 'samples', 'secret-sql.diff'), 'utf8');

async function withServer(options, run) {
  const server = createServer({ logger: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ origin, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(origin, pathname, body, headers = {}) {
  return fetch(origin + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('health expõe capacidades sem vazar segredos', async () => {
  await withServer({ env: { OPENAI_API_KEY: 'sk-should-not-leak' } }, async ({ origin }) => {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.name, 'greenlight');
    assert.ok(data.rules >= 30);
    assert.equal(JSON.stringify(data).includes('sk-should-not-leak'), false);
    assert.equal(data.llm.provider, 'openai');
    assert.equal(data.llm.model, 'gpt-4o-mini');
  });
});

test('a landing page é servida com o painel e CSP compatível com o preview', async () => {
  await withServer({}, async ({ origin }) => {
    const response = await fetch(`${origin}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /id="agent"/);
    assert.match(html, /agent\/agent\.js/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors[^;]*e2b\.app/);
    assert.equal(response.headers.get('x-frame-options'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

    const css = await fetch(`${origin}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(await css.text(), /agent__finding/);

    const script = await fetch(`${origin}/agent/agent.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
  });
});

test('scenarios e diffs de exemplo são servidos por allowlist', async () => {
  await withServer({}, async ({ origin }) => {
    const catalogResponse = await fetch(`${origin}/api/scenarios`);
    const data = await catalogResponse.json();
    assert.ok(data.scenarios.length >= 3);
    for (const scenario of data.scenarios) {
      const diff = await fetch(origin + scenario.url);
      assert.equal(diff.status, 200);
      assert.match(await diff.text(), /^diff --git /);
    }
    assert.equal((await fetch(`${origin}/samples/nao-existe.diff`)).status, 404);
    assert.equal((await fetch(`${origin}/.greenlight.json`)).status, 404);
    assert.equal((await fetch(`${origin}/package.json`)).status, 404);
  });
});

test('POST /api/review devolve o veredito e o contexto', async () => {
  await withServer({}, async ({ origin }) => {
    const response = await post(origin, '/api/review', { diff: RETRY, scenarioId: 'retry' });
    assert.equal(response.status, 200);
    const { review, demo } = await response.json();
    assert.equal(review.verdict.status, 'attention');
    assert.equal(review.findings[0].ruleId, 'BUG001');
    assert.equal(review.engine.llm.status, 'disabled');
    assert.equal(demo.memory.dismissed, 0);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('streaming emite etapas reais e termina com done', async () => {
  await withServer({}, async ({ origin }) => {
    const response = await post(origin, '/api/review/stream', { diff: RETRY });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: stage/);
    assert.match(text, /"id":"parse"/);
    assert.match(text, /"status":"done"/);
    assert.match(text, /event: checks/);
    assert.match(text, /event: findings/);
    assert.match(text, /event: done/);
    assert.match(text, /"verdict"/);
  });
});

test('diff inválido e vazio têm 422 com código', async () => {
  await withServer({}, async ({ origin }) => {
    const empty = await post(origin, '/api/review', { diff: '' });
    assert.equal(empty.status, 422);
    assert.equal((await empty.json()).code, 'EMPTY_DIFF');

    const invalid = await post(origin, '/api/review', { diff: 'só um texto' });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).code, 'INVALID_DIFF');
  });
});

test('corpo acima do limite responde 413', async () => {
  await withServer({ env: { GREENLIGHT_MAX_DIFF_BYTES: '4096' } }, async ({ origin }) => {
    const response = await post(origin, '/api/review', { diff: 'x'.repeat(9000) });
    assert.equal(response.status, 413);
  });
});

test('aplicar correção no servidor devolve um diff válido e revisável', async () => {
  await withServer({}, async ({ origin }) => {
    const first = await (await post(origin, '/api/review', { diff: RETRY })).json();
    const finding = first.review.findings[0];
    const applied = await post(origin, '/api/apply', {
      diff: RETRY,
      file: finding.file,
      suggestion: finding.suggestion,
    });
    assert.equal(applied.status, 200);
    const { diff } = await applied.json();
    assert.match(diff, /2 \*\* i/);

    const second = await (await post(origin, '/api/review', { diff })).json();
    assert.equal(second.review.verdict.status, 'ready');
    assert.equal(second.review.findings.length, 0);
  });
});

test('aplicar sugestão inválida é recusado', async () => {
  await withServer({}, async ({ origin }) => {
    const response = await post(origin, '/api/apply', {
      diff: RETRY,
      file: 'api/webhooks.ts',
      suggestion: { mode: 'info', code: 'x' },
    });
    assert.equal(response.status, 400);
  });
});

test('dispensar um achado reexecuta e o contabiliza como dispensado', async () => {
  await withServer({}, async ({ origin }) => {
    const first = await (await post(origin, '/api/review', { diff: RETRY })).json();
    const finding = first.review.findings[0];
    const dismissed = await post(origin, '/api/dismiss', { finding });
    assert.equal(dismissed.status, 200);
    assert.equal((await dismissed.json()).dismissed.length, 1);

    const second = await (await post(origin, '/api/review', { diff: RETRY })).json();
    assert.equal(second.review.findings.length, 0);
    assert.equal(second.review.suppressed.dismissed, 1);

    await fetch(`${origin}/api/dismissed`, { method: 'DELETE' });
    const third = await (await post(origin, '/api/review', { diff: RETRY })).json();
    assert.equal(third.review.findings.length, 1);
  });
});

test('rate limit responde 429 com retry-after', async () => {
  await withServer({ env: { GREENLIGHT_RATE_LIMIT: '2' } }, async ({ origin }) => {
    assert.equal((await post(origin, '/api/review', { diff: RETRY })).status, 200);
    assert.equal((await post(origin, '/api/review', { diff: RETRY })).status, 200);
    const blocked = await post(origin, '/api/review', { diff: RETRY });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
});

test('webhook valida assinatura quando há segredo', async () => {
  const env = { GITHUB_WEBHOOK_SECRET: 'segredo', NODE_ENV: 'production' };
  await withServer({ env }, async ({ origin }) => {
    const body = JSON.stringify({ action: 'opened' });
    const unsigned = await fetch(`${origin}/api/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' },
      body,
    });
    assert.equal(unsigned.status, 401);

    const signature = `sha256=${crypto.createHmac('sha256', 'segredo').update(body).digest('hex')}`;
    const signed = await fetch(`${origin}/api/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature,
      },
      body,
    });
    assert.equal(signed.status, 202);
  });
});

test('webhook responde ao ping e ignora eventos que não são de PR', async () => {
  await withServer({ env: { NODE_ENV: 'test' } }, async ({ origin }) => {
    const ping = await fetch(`${origin}/api/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'ping' },
      body: JSON.stringify({ zen: 'Keep it logically awesome.' }),
    });
    assert.equal(ping.status, 200);
    assert.equal((await ping.json()).zen, 'Keep it logically awesome.');

    const push = await fetch(`${origin}/api/github/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: JSON.stringify({ ref: 'refs/heads/main' }),
    });
    assert.equal(push.status, 202);
    assert.equal((await push.json()).ignored, true);
  });
});

test('status do GitHub App explica o passo a passo quando não configurado', async () => {
  await withServer({ env: {} }, async ({ origin }) => {
    const data = await (await fetch(`${origin}/api/github/status`)).json();
    assert.equal(data.configured, false);
    assert.ok(data.setup.length >= 3);
    assert.equal(JSON.stringify(data).includes('PRIVATE KEY'), false);
  });
});

test('regras expõem catálogo e configuração efetiva', async () => {
  await withServer({}, async ({ origin }) => {
    const data = await (await fetch(`${origin}/api/rules`)).json();
    assert.ok(data.rules.length >= 40);
    assert.equal(data.config.failOn, 'high');
    const ids = new Set(data.rules.map((rule) => rule.id));
    assert.equal(ids.size, data.rules.length, 'ids duplicados');
  });
});

test('rotas desconhecidas não viram arquivo estático', async () => {
  await withServer({}, async ({ origin }) => {
    assert.equal((await fetch(`${origin}/api/nao-existe`)).status, 404);
    assert.equal((await fetch(`${origin}/node_modules/jsdom/package.json`)).status, 404);
    assert.equal((await fetch(`${origin}/..%2f..%2fetc%2fpasswd`)).status, 404);
  });
});
