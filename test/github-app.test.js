'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const { processPullRequest } = require('../server/github-app');

const FILES = [
  {
    filename: 'api/webhooks.ts',
    status: 'modified',
    additions: 7,
    deletions: 1,
    patch:
      '@@ -8,3 +8,10 @@\n' +
      ' export async function deliver(event: Event) {\n' +
      '   const endpoint = await getEndpoint(event)\n' +
      '-  return await post(endpoint, event)\n' +
      '+  const attempts = MAX_RETRIES\n' +
      '+  for (let i = 0; i < attempts; i++) {\n' +
      '+    try {\n' +
      '+      return await post(endpoint, event)\n' +
      '+    } catch (err) {\n' +
      '+      await wait(RETRY_DELAY)\n' +
      '+    }\n' +
      '+  }\n' +
      ' }\n',
  },
  {
    filename: 'api/webhooks.test.ts',
    status: 'added',
    additions: 3,
    deletions: 0,
    patch:
      '@@ -0,0 +1,3 @@\n' +
      "+import test from 'node:test'\n" +
      "+import assert from 'node:assert/strict'\n" +
      '+\n',
  },
];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function fakeGitHub({ repoConfig = null } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://fake');
    calls.push({
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      body: body ? JSON.parse(body) : null,
      headers: req.headers,
    });

    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'POST' && url.pathname === '/app/installations/99/access_tokens') {
      return json(201, { token: 'inst-token', expires_at: '2030-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && url.pathname === '/repos/acme/api/pulls/7/files') {
      return json(200, FILES);
    }
    if (req.method === 'GET' && url.pathname === '/repos/acme/api/contents/.greenlight.json') {
      if (!repoConfig) return json(404, { message: 'Not Found' });
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(repoConfig)).toString('base64'),
      });
    }
    if (req.method === 'POST' && url.pathname === '/repos/acme/api/pulls/7/reviews') {
      return json(200, { id: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/repos/acme/api/issues/7/comments') {
      return json(201, { id: 2 });
    }
    if (req.method === 'POST' && url.pathname === '/repos/acme/api/check-runs') {
      return json(201, { id: 5 });
    }
    return json(404, { message: `sem rota: ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function appEnv(baseUrl) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    GITHUB_APP_ID: '123',
    GITHUB_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    GITHUB_API_URL: baseUrl,
    GITHUB_WEBHOOK_SECRET: 'segredo',
    NODE_ENV: 'test',
  };
}

function payload(overrides = {}) {
  return {
    action: 'opened',
    installation: { id: 99 },
    repository: { full_name: 'acme/api' },
    pull_request: {
      number: 7,
      draft: false,
      head: { sha: 'abc123' },
      ...overrides,
    },
  };
}

test('revisa o PR, comenta inline com suggestion e cria o check run', async () => {
  const github = await fakeGitHub();
  try {
    const outcome = await processPullRequest({
      payload: payload(),
      env: appEnv(github.baseUrl),
      logger: () => {},
    });

    assert.equal(outcome.status, 'reviewed');
    assert.equal(outcome.verdict, 'attention');
    assert.equal(outcome.posted, true);
    assert.equal(outcome.checkRunId, 5);

    const tokenCall = github.calls.find((call) => call.path.endsWith('/access_tokens'));
    assert.ok(tokenCall, 'pediu token de instalação');
    assert.match(tokenCall.headers.authorization, /^Bearer eyJ/);

    const review = github.calls.find((call) => call.path.endsWith('/reviews'));
    assert.ok(review, 'publicou revisão');
    assert.equal(review.headers.authorization, 'Bearer inst-token');
    assert.equal(review.body.event, 'COMMENT');
    assert.equal(review.body.commit_id, 'abc123');
    assert.ok(review.body.comments.length >= 1);
    const bug = review.body.comments.find((comment) => comment.body.includes('BUG001'));
    assert.ok(bug, 'comentário do BUG001');
    assert.equal(bug.path, 'api/webhooks.ts');
    assert.match(bug.body, /```suggestion/);
    assert.equal(bug.side, 'RIGHT');
    assert.match(review.body.body, /Achados/);

    const check = github.calls.find((call) => call.path.endsWith('/check-runs'));
    assert.equal(check.body.head_sha, 'abc123');
    assert.equal(check.body.conclusion, 'neutral');
    assert.ok(check.body.output.annotations.length >= 1);
  } finally {
    await github.close();
  }
});

test('config do repositório do PR desliga o check run e muda o failOn', async () => {
  const github = await fakeGitHub({
    repoConfig: { failOn: 'medium', github: { checks: false, maxInlineComments: 1 } },
  });
  try {
    const outcome = await processPullRequest({
      payload: payload(),
      env: appEnv(github.baseUrl),
      logger: () => {},
    });
    assert.equal(outcome.status, 'reviewed');
    // BUG001 é médio; com failOn=medium vira bloqueio.
    assert.equal(outcome.verdict, 'blocked');
    const review = github.calls.find((call) => call.path.endsWith('/reviews'));
    assert.equal(review.body.comments.length, 1);
    assert.equal(review.body.event, 'COMMENT');
    assert.equal(github.calls.some((call) => call.path.endsWith('/check-runs')), false);
  } finally {
    await github.close();
  }
});

test('rascunho é ignorado quando reviewDrafts=false', async () => {
  const github = await fakeGitHub();
  try {
    const outcome = await processPullRequest({
      payload: payload({ draft: true }),
      env: appEnv(github.baseUrl),
      logger: () => {},
    });
    assert.equal(outcome.status, 'skipped');
    assert.match(outcome.reason, /rascunho/);
    assert.equal(github.calls.some((call) => call.path.endsWith('/reviews')), false);
  } finally {
    await github.close();
  }
});

test('sem App configurado, o processamento é pulado sem chamadas externas', async () => {
  const outcome = await processPullRequest({ payload: payload(), env: {}, logger: () => {} });
  assert.equal(outcome.status, 'skipped');
  assert.match(outcome.reason, /não configurado/);
});

test('payload sem instalação/repo é ignorado', async () => {
  const outcome = await processPullRequest({ payload: { action: 'opened' }, env: {}, logger: () => {} });
  assert.equal(outcome.status, 'ignored');
});

test('422 na revisão inline cai para comentário simples', async () => {
  const github = await fakeGitHub();
  const server = github; // reaproveita o servidor falso, mas /reviews responde 422
  const original = server.calls;
  // Reescreve a rota via proxy de fetch: intercepta a chamada de reviews.
  const realFetch = globalThis.fetch;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/pulls/7/reviews')) {
      original.push({ method: 'POST', path: '/repos/acme/api/pulls/7/reviews', body: JSON.parse(init.body) });
      return {
        ok: false,
        status: 422,
        text: async () => 'Unprocessable Entity',
        json: async () => ({}),
      };
    }
    return realFetch(url, init);
  };
  try {
    const outcome = await processPullRequest({
      payload: payload(),
      env: appEnv(github.baseUrl),
      fetchImpl,
      logger: () => {},
    });
    assert.equal(outcome.status, 'reviewed');
    assert.equal(outcome.posted, true);
    assert.ok(github.calls.some((call) => call.path.endsWith('/issues/7/comments')));
  } finally {
    await github.close();
  }
});
