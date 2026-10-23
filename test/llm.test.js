'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { review } = require('../agent/review');
const { redactSecrets, resolveLlm, normalizeFindings } = require('../agent/llm');
const { additions, byRule, FAKE_STRIPE_KEY, FAKE_GITHUB_TOKEN } = require('./helpers');

function fakeFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  impl.calls = calls;
  return impl;
}

const DIFF = additions('src/checkout.ts', 'export async function total(cart) {\n  return cart.items.length\n}');

test('sem chave, o LLM fica desligado e a revisão continua', async () => {
  const result = await review(DIFF, {
    config: {},
    index: null,
    llm: false,
    env: {},
  });
  assert.equal(result.engine.llm.enabled, false);
  assert.equal(result.engine.llm.status, 'disabled');
  assert.ok(result.verdict.status);
});

test('resolve provedor pela chave presente e respeita GREENLIGHT_LLM=off', () => {
  assert.equal(resolveLlm({}, { OPENAI_API_KEY: 'x' }).provider, 'openai');
  assert.equal(resolveLlm({}, { ANTHROPIC_API_KEY: 'x' }).provider, 'anthropic');
  assert.equal(resolveLlm({}, { OLLAMA_HOST: 'http://x' }).provider, 'ollama');
  assert.equal(resolveLlm({}, {}).provider, 'off');
  assert.equal(resolveLlm({}, { OPENAI_API_KEY: 'x', GREENLIGHT_LLM: 'off' }).enabled, false);
  assert.equal(resolveLlm({ llm: { enabled: false } }, { OPENAI_API_KEY: 'x' }).enabled, false);
});

test('redige segredos antes de enviar o diff', () => {
  const { text, count } = redactSecrets(
    `const token = '${FAKE_GITHUB_TOKEN}'\nconst key = '${FAKE_STRIPE_KEY}'`,
  );
  assert.ok(count >= 2);
  assert.equal(text.includes(FAKE_GITHUB_TOKEN), false);
  assert.equal(text.includes(FAKE_STRIPE_KEY), false);
  assert.match(text, /REDIGIDO/);
});

test('LLM responde com achado válido e ele entra na revisão', async () => {
  const fetchImpl = fakeFetch({
    choices: [
      {
        message: {
          content: JSON.stringify({
            summary: 'A função soma o número de itens em vez de somar os preços.',
            findings: [
              {
                file: 'src/checkout.ts',
                line: 2,
                severity: 'high',
                category: 'bug',
                title: 'Total calculado com a quantidade de itens',
                message: 'cart.items.length devolve a quantidade, não o valor total.',
                why: 'O cliente paga o número de itens em centavos.',
                confidence: 0.9,
                suggestion: {
                  title: 'Somar preços',
                  language: 'typescript',
                  code: 'return cart.items.reduce((sum, item) => sum + item.price, 0)',
                },
              },
            ],
          }),
        },
      },
    ],
  });

  const result = await review(DIFF, {
    config: {},
    index: null,
    env: { OPENAI_API_KEY: 'fake', OPENAI_MODEL: 'gpt-test' },
    fetchImpl,
  });

  assert.equal(result.engine.llm.status, 'ok');
  assert.equal(result.engine.llm.provider, 'openai');
  const llmFindings = result.findings.filter((finding) => finding.source === 'llm');
  assert.equal(llmFindings.length, 1);
  assert.equal(llmFindings[0].ruleId, 'LLM');
  assert.equal(llmFindings[0].line, 2);
  assert.equal(result.summary, 'A função soma o número de itens em vez de somar os preços.');

  const sent = fetchImpl.calls[0];
  assert.match(sent.url, /chat\/completions$/);
  assert.equal(sent.body.model, 'gpt-test');
  assert.match(JSON.stringify(sent.body), /linhas adicionadas/);
});

test('LLM não pode inventar arquivo ou linha fora do diff', async () => {
  const fetchImpl = fakeFetch({
    choices: [
      {
        message: {
          content: JSON.stringify({
            summary: 'x',
            findings: [
              { file: 'src/outro.ts', line: 10, severity: 'high', category: 'bug', title: 'a', message: 'b' },
              { file: 'src/checkout.ts', line: 999, severity: 'high', category: 'bug', title: 'c', message: 'd' },
              { file: 'src/checkout.ts', line: 2, severity: 'nonsense', category: 'bug', title: 'e', message: 'f' },
            ],
          }),
        },
      },
    ],
  });
  const result = await review(DIFF, {
    config: {},
    index: null,
    env: { OPENAI_API_KEY: 'fake' },
    fetchImpl,
  });
  assert.equal(result.engine.llm.status, 'ok');
  assert.equal(result.findings.filter((finding) => finding.source === 'llm').length, 0);
});

test('falha do provedor não derruba a revisão', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
    text: async () => 'boom',
  });
  const result = await review(DIFF, {
    config: {},
    index: null,
    env: { OPENAI_API_KEY: 'fake' },
    fetchImpl,
  });
  assert.equal(result.engine.llm.status, 'failed');
  assert.ok(result.engine.llm.error);
  assert.equal(result.verdict.status !== 'blocked', true);
});

test('resposta que não é JSON também é tolerada', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'desculpe, não consegui' } }] });
  const result = await review(DIFF, {
    config: {},
    index: null,
    env: { OPENAI_API_KEY: 'fake' },
    fetchImpl,
  });
  assert.equal(result.engine.llm.status, 'failed');
  assert.match(result.engine.llm.error, /JSON/);
});

test('achado do LLM na mesma linha e categoria de uma regra é descartado', () => {
  const files = [
    {
      path: 'src/a.ts',
      hunks: [{ lines: [{ type: 'add', newLine: 3, content: 'x' }] }],
    },
  ];
  const deterministic = [{ file: 'src/a.ts', line: 3, category: 'security' }];
  const kept = normalizeFindings(
    [{ file: 'src/a.ts', line: 3, severity: 'high', category: 'security', title: 'dup', message: 'dup' }],
    { files, deterministic, maxFindings: 8 },
  );
  assert.equal(kept.length, 0);
});

test('ambiente Anthropic usa o endpoint de messages e o system separado', async () => {
  const fetchImpl = fakeFetch({
    content: [{ type: 'text', text: JSON.stringify({ summary: 'ok', findings: [] }) }],
  });
  const result = await review(DIFF, {
    config: {},
    index: null,
    env: { ANTHROPIC_API_KEY: 'fake' },
    fetchImpl,
  });
  assert.equal(result.engine.llm.status, 'ok');
  assert.match(fetchImpl.calls[0].url, /anthropic\.com\/v1\/messages$/);
  assert.ok(fetchImpl.calls[0].body.system);
  assert.equal(fetchImpl.calls[0].body.messages.length, 1);
});
