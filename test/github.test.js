'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  parseRepoRef,
  verifyWebhookSignature,
  buildReviewPayload,
  buildCheckRun,
  inlineCommentFor,
  formatReviewBody,
  appJwt,
} = require('../agent/github');
const { additions, runReview, FAKE_STRIPE_KEY } = require('./helpers');

async function blockedReview() {
  return runReview(
    additions('api/charges.ts', `const key = '${FAKE_STRIPE_KEY}'\nconsole.log('x')`),
  );
}

test('parseRepoRef aceita as formas usuais', () => {
  assert.deepEqual(parseRepoRef('acme/api#42'), { repo: 'acme/api', number: 42 });
  assert.deepEqual(parseRepoRef('acme/api/pull/42'), { repo: 'acme/api', number: 42 });
  assert.deepEqual(parseRepoRef('https://github.com/acme/api/pull/42/files'), { repo: 'acme/api', number: 42 });
  assert.deepEqual(parseRepoRef('acme/api/42'), { repo: 'acme/api', number: 42 });
  assert.equal(parseRepoRef('acme/api'), null);
  assert.equal(parseRepoRef(''), null);
});

test('assinatura do webhook usa HMAC-SHA256', () => {
  const secret = 'super-secret';
  const body = Buffer.from('{"action":"opened"}');
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  assert.equal(verifyWebhookSignature(body, `${signature}0`, secret), false);
  assert.equal(verifyWebhookSignature(body, null, secret), false);
  assert.equal(verifyWebhookSignature(body, signature, ''), false);
});

test('payload de revisão usa suggestion aplicável e um comentário por linha', async () => {
  const review = await blockedReview();
  const payload = buildReviewPayload(review, { maxInlineComments: 20 });
  assert.equal(payload.event, 'REQUEST_CHANGES');
  assert.ok(payload.comments.length >= 2);
  const paths = new Set();
  for (const comment of payload.comments) {
    const key = `${comment.path}:${comment.line}`;
    assert.equal(paths.has(key), false, 'linha duplicada');
    paths.add(key);
    assert.equal(comment.side, 'RIGHT');
    assert.ok(comment.body.includes('greenlight') || comment.body.includes('Greenlight'));
  }
  assert.match(payload.body, /Merge bloqueado/);
  assert.match(payload.body, /Checagem/);
});

test('sugestão aplicável vira bloco ```suggestion; informativa vira details', async () => {
  const replace = inlineCommentFor({
    severity: 'medium',
    title: 'Retry',
    message: 'sem backoff',
    why: 'porque sim',
    ruleId: 'BUG001',
    source: 'rule',
    suggestion: { mode: 'replace', applyable: true, language: 'typescript', code: 'await wait(base * 2 ** i)' },
  });
  assert.match(replace, /```suggestion\nawait wait/);

  const info = inlineCommentFor({
    severity: 'high',
    title: 'SQL',
    message: 'injeção',
    ruleId: 'SEC002',
    source: 'rule',
    suggestion: { mode: 'info', applyable: false, language: 'javascript', code: 'db.query(sql, params)' },
  });
  assert.match(info, /<details>/);
  assert.match(info, /```javascript/);
});

test('escapa HTML do conteúdo do PR', async () => {
  const body = inlineCommentFor({
    severity: 'low',
    title: '<script>alert(1)</script>',
    message: '<img src=x onerror=alert(1)>',
    ruleId: 'LNT001',
    source: 'rule',
    suggestion: null,
  });
  assert.equal(body.includes('<script>'), false);
  assert.match(body, /&lt;script&gt;/);
});

test('check run tem conclusão e anotações coerentes com o veredito', async () => {
  const review = await blockedReview();
  const check = buildCheckRun(review, { headSha: 'abc123' });
  assert.equal(check.status, 'completed');
  assert.equal(check.conclusion, 'failure');
  assert.equal(check.head_sha, 'abc123');
  assert.ok(check.output.annotations.length > 0);
  assert.ok(['failure', 'warning', 'notice'].includes(check.output.annotations[0].annotation_level));
});

test('JWT do GitHub App tem header e payload esperados', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const jwt = appJwt(12345, pem, 1700000000);
  const [header, payload] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.iss, '12345');
  assert.equal(claims.exp - claims.iat, 600);
});

test('corpo da revisão lista os achados e o rodapé do motor', async () => {
  const review = await blockedReview();
  const body = formatReviewBody(review, { commit: 'abcdef1234' });
  assert.match(body, /## 🔴 Merge bloqueado/);
  assert.match(body, /### Achados/);
  assert.match(body, /Greenlight 1\.0\.0/);
  assert.match(body, /abcdef1/);
});
