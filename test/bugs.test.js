'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { additions, runReview, byRule } = require('./helpers');
const { applySuggestion } = require('../agent/patch');

const RETRY = `  for (let i = 0; i < attempts; i++) {
    try {
      return await post(endpoint, event)
    } catch (err) {
      await wait(RETRY_DELAY)
    }
  }`;

test('BUG001 aponta retry com espera fixa e sugere backoff com jitter', async () => {
  const result = await runReview(additions('api/webhooks.ts', RETRY));
  const [finding] = byRule(result, 'BUG001');
  assert.ok(finding);
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.suggestion.mode, 'replace');
  assert.match(finding.suggestion.code, /2 \*\* i/);
  assert.match(finding.suggestion.code, /Math\.random/);
});

test('BUG001 aceita backoff exponencial já implementado', async () => {
  const code = `  for (let i = 0; i < attempts; i++) {
    try {
      return await post(endpoint, event)
    } catch (err) {
      await wait(RETRY_DELAY * 2 ** i + Math.random() * RETRY_DELAY)
    }
  }`;
  const result = await runReview(additions('api/webhooks.ts', code));
  assert.equal(byRule(result, 'BUG001').length, 0);
});

test('aplicar a correção de BUG001 deixa a revisão verde', async () => {
  const diff = additions('api/webhooks.ts', RETRY);
  const before = await runReview(diff);
  const finding = byRule(before, 'BUG001')[0];
  const patched = applySuggestion(diff, { file: finding.file, suggestion: finding.suggestion });
  const after = await runReview(patched);
  assert.equal(byRule(after, 'BUG001').length, 0);
  assert.ok(patched.includes('RETRY_DELAY * 2 ** i + Math.random() * RETRY_DELAY'));
});

test('BUG002 aponta catch vazio em uma linha e em bloco', async () => {
  const inline = await runReview(additions('src/a.ts', 'try { run() } catch (error) {}'));
  assert.equal(byRule(inline, 'BUG002').length, 1);

  const block = await runReview(additions('src/a.ts', 'try {\n  run()\n} catch (error) {\n}'));
  assert.equal(byRule(block, 'BUG002').length, 1);

  const handled = await runReview(
    additions('src/a.ts', 'try {\n  run()\n} catch (error) {\n  logger.error(error)\n  throw error\n}'),
  );
  assert.equal(byRule(handled, 'BUG002').length, 0);
});

test('BUG002 aponta except/pass em Python', async () => {
  const result = await runReview(additions('app/task.py', 'try:\n    run()\nexcept Exception:\n    pass'));
  assert.equal(byRule(result, 'BUG002').length, 1);
});

test('LNT001 pega console.log indentado e ignora a palavra em string/regex', async () => {
  const indented = await runReview(additions('src/a.ts', 'if (debug) {\n  console.log(value)\n}'));
  assert.equal(byRule(indented, 'LNT001').length, 1);

  const quoted = await runReview(additions('src/a.ts', "const help = 'use console.log para depurar'"));
  assert.equal(byRule(quoted, 'LNT001').length, 0);
});

test('BUG003 aponta == e ignora ===/!== e comparação com null', async () => {
  const bad = await runReview(additions('src/a.js', "if (status == 'ok') {}"));
  assert.equal(byRule(bad, 'BUG003').length, 1);

  const good = await runReview(additions('src/a.js', "if (status === 'ok') {}\nif (value == null) {}"));
  assert.equal(byRule(good, 'BUG003').length, 0);
});

test('BUG004 sugere radix aplicável', async () => {
  const diff = additions('src/a.js', "const n = parseInt(input)");
  const result = await runReview(diff);
  const [finding] = byRule(result, 'BUG004');
  assert.ok(finding);
  const patched = applySuggestion(diff, { file: finding.file, suggestion: finding.suggestion });
  assert.ok(patched.includes('parseInt(input, 10)'));
});

test('BUG005 aponta fetch sem await e BUG006 aponta forEach async', async () => {
  const fetchFinding = await runReview(additions('src/a.ts', 'const response = await fetch(url)\nconst data = fetch(url)'));
  assert.equal(byRule(fetchFinding, 'BUG005').length, 1);

  const forEach = await runReview(additions('src/a.ts', 'items.forEach(async (item) => { await save(item) })'));
  assert.equal(byRule(forEach, 'BUG006').length, 1);
});

test('BUG009 aponta executor async em Promise', async () => {
  const result = await runReview(additions('src/a.ts', 'const p = new Promise(async (resolve) => { resolve(await load()) })'));
  assert.equal(byRule(result, 'BUG009').length, 1);
});

test('LNT001 e LNT002 apontam console.log e debugger, com remoção aplicável', async () => {
  const diff = additions('src/a.ts', "console.log('debug')\ndebugger");
  const result = await runReview(diff);
  const log = byRule(result, 'LNT001')[0];
  const debuggerFinding = byRule(result, 'LNT002')[0];
  assert.ok(log);
  assert.ok(debuggerFinding);
  const patched = applySuggestion(diff, { file: log.file, suggestion: log.suggestion });
  assert.equal(patched.includes("console.log('debug')"), false);
});

test('regras não quebram em linhas estranhas', async () => {
  const weird = ['const a = `', '}{)([]', '#!/bin/bash', 'SELECT * FROM', '@@@', '\\'];
  for (const line of weird) {
    const result = await runReview(additions('src/a.ts', line));
    assert.ok(Array.isArray(result.findings));
    assert.deepEqual(result.engine.ruleErrors, []);
  }
});
