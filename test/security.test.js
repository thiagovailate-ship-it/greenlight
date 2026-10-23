'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { additions, runReview, byRule, FAKE_STRIPE_KEY, FAKE_GITHUB_TOKEN, FAKE_PRIVATE_KEY } = require('./helpers');

async function rulesFor(code, file = 'src/app.ts') {
  const result = await runReview(additions(file, code));
  return { result, ids: result.findings.map((finding) => finding.ruleId) };
}

test('SEC001 detecta chave do Stripe e sugere variável de ambiente', async () => {
  const { result } = await rulesFor(`const key = '${FAKE_STRIPE_KEY}'`);
  const [finding] = byRule(result, 'SEC001');
  assert.ok(finding, 'achado SEC001');
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.line, 1);
  assert.match(finding.suggestion.code, /process\.env|cofre/);
});

test('SEC001 detecta token do GitHub e chave privada', async () => {
  const token = await rulesFor(`const token = '${FAKE_GITHUB_TOKEN}'`);
  assert.ok(byRule(token.result, 'SEC001').length >= 1);

  const key = await rulesFor(FAKE_PRIVATE_KEY);
  assert.ok(byRule(key.result, 'SEC001').some((finding) => finding.severity === 'critical'));
});

test('SEC001 ignora placeholders e leituras do ambiente', async () => {
  const { ids } = await rulesFor(
    "const password = process.env.DB_PASSWORD\nconst apiKey = 'change-me'\nconst token = 'your-token-here'",
  );
  assert.equal(ids.includes('SEC001'), false);
});

test('SEC002 aponta SQL interpolado e não aponta consulta parametrizada', async () => {
  const bad = await rulesFor('const rows = await db.query(`SELECT * FROM users WHERE id = ${req.body.id}`)');
  assert.ok(byRule(bad.result, 'SEC002').length === 1);

  const good = await rulesFor("const rows = await db.query('SELECT * FROM users WHERE id = $1', [id])");
  assert.equal(byRule(good.result, 'SEC002').length, 0);
});

test('SEC003 aponta exec com interpolação e SEC004 aponta eval', async () => {
  const exec = await rulesFor("exec(`git log ${branch}`)");
  assert.ok(byRule(exec.result, 'SEC003').length === 1);

  const evalFinding = await rulesFor('const payload = eval(req.body.script)');
  assert.ok(byRule(evalFinding.result, 'SEC004').length === 1);
});

test('SEC005 aponta innerHTML dinâmico e aceita textContent', async () => {
  const bad = await rulesFor('el.innerHTML = req.query.html');
  assert.equal(byRule(bad.result, 'SEC005').length, 1);

  const literal = await rulesFor("el.innerHTML = '<p>ok</p>'");
  assert.equal(byRule(literal.result, 'SEC005').length, 0);

  const good = await rulesFor('el.textContent = req.query.text');
  assert.equal(byRule(good.result, 'SEC005').length, 0);
});

test('SEC006 e SEC008 apontam criptografia e aleatoriedade fracas', async () => {
  const { result } = await rulesFor(
    "const digest = createHash('md5').update(data).digest('hex')\nconst sessionToken = Math.random().toString(36)",
  );
  assert.equal(byRule(result, 'SEC006').length, 1);
  assert.equal(byRule(result, 'SEC008').length, 1);
});

test('SEC007 aponta TLS desligado', async () => {
  const { result } = await rulesFor('const agent = new https.Agent({ rejectUnauthorized: false })');
  assert.equal(byRule(result, 'SEC007').length, 1);
});

test('SEC009 aponta path traversal e SEC016 aponta filtro NoSQL', async () => {
  const fs = await rulesFor("const content = await readFile(path.join('uploads', req.query.file))");
  assert.equal(byRule(fs.result, 'SEC009').length, 1);

  const nosql = await rulesFor('const user = await User.findOne(req.body)');
  assert.equal(byRule(nosql.result, 'SEC016').length, 1);
});

test('SEC013 não dispara em log comum sem credencial', async () => {
  const { result } = await rulesFor("logger.info({ userId }, 'requisição concluída')");
  assert.equal(byRule(result, 'SEC013').length, 0);

  const leak = await rulesFor("console.log('token', token)");
  assert.equal(byRule(leak.result, 'SEC013').length, 1);
});

test('comentários não geram achados de segurança', async () => {
  const { result } = await rulesFor(`// eval(req.body.script)\n// const key = '${FAKE_STRIPE_KEY}'`);
  assert.equal(result.findings.length, 0);
});

test('arquivo inteiro excluído do scan de segurança só perde regras de segurança', async () => {
  const code = `const key = '${FAKE_STRIPE_KEY}'\nconsole.log('oi')`;
  const result = await runReview(additions('src/generated.ts', code), {
    config: {
      security: { excludePaths: ['src/generated.ts'] },
      tests: { requireChangedTests: false },
    },
  });
  assert.equal(byRule(result, 'SEC001').length, 0);
  assert.equal(byRule(result, 'LNT001').length, 1);
});
