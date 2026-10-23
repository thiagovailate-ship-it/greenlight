'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseEnv, loadEnv } = require('../agent/env');

test('parseEnv entende comentários, aspas e export', () => {
  const values = parseEnv(
    [
      '# comentário',
      'OPENAI_API_KEY=sk-123',
      'export PORT=4000',
      'GITHUB_PRIVATE_KEY="linha1\\nlinha2"',
      "CUSTOM='valor com espaço # não é comentário'",
      'VAZIO=',
      'SEM_VALOR',
      'CHAVE INVALIDA=1',
      'COM_COMENTARIO=abc # nota',
    ].join('\n'),
  );
  assert.equal(values.OPENAI_API_KEY, 'sk-123');
  assert.equal(values.PORT, '4000');
  assert.equal(values.GITHUB_PRIVATE_KEY, 'linha1\nlinha2');
  assert.equal(values.CUSTOM, 'valor com espaço # não é comentário');
  assert.equal(values.VAZIO, '');
  assert.equal(values.SEM_VALOR, undefined);
  assert.equal(values['CHAVE INVALIDA'], undefined);
  assert.equal(values.COM_COMENTARIO, 'abc');
});

test('loadEnv não sobrescreve variáveis já definidas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'greenlight-env-'));
  fs.writeFileSync(path.join(root, '.env'), 'A=do-arquivo\nB=do-arquivo\n');
  const target = { A: 'do-ambiente' };
  const result = loadEnv(root, target);
  assert.equal(result.loaded, true);
  assert.equal(result.count, 1);
  assert.equal(target.A, 'do-ambiente');
  assert.equal(target.B, 'do-arquivo');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadEnv sem arquivo é silencioso', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'greenlight-env-'));
  const result = loadEnv(root, {});
  assert.equal(result.loaded, false);
  fs.rmSync(root, { recursive: true, force: true });
});
