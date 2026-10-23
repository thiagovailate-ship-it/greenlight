'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDiff, diffFromGitHubFiles, isTestPath } = require('../agent/diff');
const { diffOf, additions } = require('./helpers');

const SAMPLE = `diff --git a/api/webhooks.ts b/api/webhooks.ts
index 3f2a1b7..9c4d5e2 100644
--- a/api/webhooks.ts
+++ b/api/webhooks.ts
@@ -8,4 +8,7 @@ import { post } from './http'
 export async function deliver(event: Event) {
   const endpoint = await getEndpoint(event)
-  return await post(endpoint, event)
+  const attempts = MAX_RETRIES
+  for (let i = 0; i < attempts; i++) {
+    await post(endpoint, event)
+  }
 }
`;

test('numera linhas antigas e novas de cada linha do hunk', () => {
  const { files, stats } = parseDiff(SAMPLE);
  assert.equal(files.length, 1);
  const file = files[0];
  assert.equal(file.path, 'api/webhooks.ts');
  assert.equal(file.language, 'ts');
  assert.equal(stats.additions, 4);
  assert.equal(stats.deletions, 1);

  const lines = file.hunks[0].lines;
  assert.equal(lines[0].type, 'context');
  assert.equal(lines[0].newLine, 8);
  const removed = lines.find((line) => line.type === 'del');
  assert.equal(removed.oldLine, 10);
  assert.equal(removed.newLine, null);
  const added = lines.filter((line) => line.type === 'add');
  assert.deepEqual(
    added.map((line) => line.newLine),
    [10, 11, 12, 13],
  );
});

test('reconhece arquivo novo, removido e renomeado', () => {
  const diff = `diff --git a/lib/new.js b/lib/new.js
new file mode 100644
--- /dev/null
+++ b/lib/new.js
@@ -0,0 +1,2 @@
+export const a = 1
+export const b = 2
diff --git a/old.js b/old.js
deleted file mode 100644
--- a/old.js
+++ /dev/null
@@ -1,1 +0,0 @@
-const x = 1
diff --git a/a.js b/b.js
similarity index 90%
rename from a.js
rename to b.js
--- a/a.js
+++ b/b.js
@@ -1,1 +1,1 @@
-const a = 1
+const a = 2
`;
  const { files } = parseDiff(diff);
  assert.deepEqual(
    files.map((file) => [file.path, file.status]),
    [
      ['lib/new.js', 'added'],
      ['old.js', 'deleted'],
      ['b.js', 'renamed'],
    ],
  );
});

test('diff vazio ou sem hunks é sinalizado', () => {
  const result = parseDiff('isto não é um diff');
  assert.equal(result.files.length, 0);
  assert.ok(result.errors.length > 0);
});

test('converte a lista de arquivos da API do GitHub em diff', () => {
  const text = diffFromGitHubFiles([
    {
      filename: 'src/a.js',
      status: 'modified',
      patch: '@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n',
    },
    {
      filename: 'src/b.js',
      status: 'added',
      patch: '@@ -0,0 +1,1 @@\n+export const b = 1\n',
    },
  ]);
  const { files } = parseDiff(text);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/a.js');
  assert.equal(files[1].path, 'src/b.js');
  assert.equal(files[1].status, 'added');
});

test('detecta caminhos de teste em várias linguagens', () => {
  assert.equal(isTestPath('src/foo.test.ts'), true);
  assert.equal(isTestPath('tests/test_api.py'), true);
  assert.equal(isTestPath('api/handler_test.go'), true);
  assert.equal(isTestPath('spec/models/user_spec.rb'), true);
  assert.equal(isTestPath('src/users.ts'), false);
  assert.equal(isTestPath('src/contest.js'), false);
});

test('hunk com contagem omitida e linha \\ No newline funciona', () => {
  const diff = `--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
+new
\\ No newline at end of file
`;
  const { files } = parseDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'file.txt');
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);
});

test('helper diffOf gera cabeçalho consistente', () => {
  const { files } = parseDiff(diffOf('a.js', [' const x = 1', '-const y = 2', '+const y = 3']));
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);
  const added = files[0].hunks[0].lines.find((line) => line.type === 'add');
  assert.equal(added.newLine, 2);
  assert.ok(additions('a.js', 'const a = 1').includes('+const a = 1'));
});
