'use strict';

const { parseDiff } = require('./diff');

function serializeFile(file) {
  const out = [];
  out.push(`diff --git a/${file.oldPath} b/${file.path}`);
  if (file.status === 'added') out.push('new file mode 100644');
  if (file.status === 'deleted') out.push('deleted file mode 100644');
  if (file.status === 'added') out.push('--- /dev/null');
  else out.push(`--- a/${file.oldPath}`);
  if (file.status === 'deleted') out.push('+++ /dev/null');
  else out.push(`+++ b/${file.path}`);

  for (const hunk of file.hunks) {
    const oldLines = file.status === 'added'
      ? 0
      : hunk.lines.filter((line) => line.type === 'context' || line.type === 'del').length;
    const newLines = file.status === 'deleted'
      ? 0
      : hunk.lines.filter((line) => line.type === 'context' || line.type === 'add').length;
    const section = hunk.section ? ` ${hunk.section}` : '';
    out.push(`@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@${section}`);
    for (const line of hunk.lines) {
      const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'meta' ? '\\' : ' ';
      out.push(`${sign}${line.content}`);
    }
  }
  return out.join('\n');
}

function renumber(file) {
  for (const hunk of file.hunks) {
    let oldCursor = hunk.oldStart;
    let newCursor = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        line.oldLine = oldCursor;
        line.newLine = newCursor;
        oldCursor += 1;
        newCursor += 1;
      } else if (line.type === 'del') {
        line.oldLine = oldCursor;
        line.newLine = null;
        oldCursor += 1;
      } else if (line.type === 'add') {
        line.oldLine = null;
        line.newLine = newCursor;
        newCursor += 1;
      }
    }
  }
}

function splitCode(code) {
  return String(code || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '')
    .split('\n');
}

/**
 * Aplica uma correção sugerida (modo "replace") no texto do diff: troca as
 * linhas adicionadas da faixa pelo código da sugestão. Devolve um diff novo,
 * que pode ser revisado de novo — o ciclo completo do "Aplicar".
 */
function applySuggestion(diffText, { file, suggestion }) {
  if (!suggestion || suggestion.mode !== 'replace') {
    throw new Error('Esta sugestão não pode ser aplicada automaticamente.');
  }
  const start = suggestion.startLine;
  const end = suggestion.endLine || start;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error('A sugestão não informa uma faixa de linhas válida.');
  }
  if (String(suggestion.code || '').length > 20000) {
    throw new Error('A sugestão é grande demais para aplicar.');
  }

  const parsed = parseDiff(diffText);
  const target = parsed.files.find((item) => item.path === file);
  if (!target) throw new Error(`O arquivo ${file} não está no diff.`);

  const inRange = (line) => line.type === 'add' && line.newLine >= start && line.newLine <= end;
  const hunk = target.hunks.find((item) => item.lines.some(inRange));
  if (!hunk) throw new Error('As linhas da sugestão não estão mais no diff.');

  const insertion = splitCode(suggestion.code).map((content) => ({
    type: 'add',
    content,
    oldLine: null,
    newLine: null,
  }));

  let inserted = false;
  const next = [];
  for (const line of hunk.lines) {
    if (inRange(line)) {
      if (!inserted) {
        next.push(...insertion);
        inserted = true;
      }
      continue;
    }
    next.push(line);
  }
  hunk.lines = next;

  renumber(target);
  target.additions = target.hunks.reduce(
    (sum, item) => sum + item.lines.filter((line) => line.type === 'add').length,
    0,
  );
  target.deletions = target.hunks.reduce(
    (sum, item) => sum + item.lines.filter((line) => line.type === 'del').length,
    0,
  );

  const serialized = `${parsed.files.map(serializeFile).join('\n')}\n`;
  const check = parseDiff(serialized);
  if (check.files.length === 0) throw new Error('A correção geraria um diff inválido.');
  return serialized;
}

module.exports = { applySuggestion, serializeFile, renumber };
