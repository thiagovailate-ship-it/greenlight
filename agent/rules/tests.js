'use strict';

const path = require('node:path');
const { infoSuggestion, isInsideStringLiteral, truncate } = require('./util');
const { extractFunctions, generateTestSuggestion, genericTestSuggestion } = require('../suggestions');

const SKIP_OR_ONLY = /\.(?:only|skip)\s*\(|\b(?:fit|xit|fdescribe|xdescribe)\s*\(/;
const PY_SKIP = /pytest\.mark\.(?:skip|skipif)\s*\(|@unittest\.skip\b/;
const GO_SKIP = /\bt\.Skip(?:f|Now)?\s*\(/;
const JAVA_SKIP = /@(?:Disabled|Ignore)\b/;

function sourceFiles(files) {
  return files.filter(
    (file) => !file.isTest && !file.isDoc && !file.isConfig && !file.binary && file.additions > 0,
  );
}

function testFiles(files) {
  return files.filter((file) => file.isTest && file.additions > 0);
}

function fileText(file) {
  return file.hunks.flatMap((hunk) => hunk.lines).map((line) => line.content).join('\n');
}

function anchorLine(file) {
  const added = file.hunks.flatMap((hunk) => hunk.lines).find((line) => line.type === 'add');
  return added ? added.newLine : null;
}

function exportName(line, language) {
  let match = /^\s*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/.exec(line.content);
  if (match) return match[1];
  match = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line.content);
  if (match) return match[1];
  if (language === 'py') {
    match = /^\s*def\s+([A-Za-z_]\w*)\s*\(/.exec(line.content);
    if (match && !match[1].startsWith('_')) return match[1];
  }
  if (language === 'go') {
    match = /^func\s+([A-Z]\w*)\s*\(/.exec(line.content);
    if (match) return match[1];
  }
  if (language === 'rust') {
    match = /^\s*pub\s+(?:async\s+)?fn\s+(\w+)\s*\(/.exec(line.content);
    if (match) return match[1];
  }
  return null;
}

module.exports = [
  {
    id: 'TST001',
    title: 'Mudança sem teste',
    severity: 'medium',
    category: 'tests',
    description: 'Código alterado sem nenhum arquivo de teste no diff.',
    scope: 'diff',
    run({ files, config, context }) {
      if (config.tests.requireChangedTests === false) return [];
      const sources = sourceFiles(files);
      if (sources.length === 0 || testFiles(files).length > 0) return [];
      const first = sources[0];
      const line = anchorLine(first);
      if (!line) return [];
      const names = sources.slice(0, 3).map((file) => file.path);
      const extra = sources.length > 3 ? ` e mais ${sources.length - 3}` : '';
      return [
        {
          file: first.path,
          line,
          severity: 'medium',
          confidence: 0.75,
          message: `Código alterado sem teste correspondente: ${names.join(', ')}${extra}.`,
          why: 'Sem um teste que exercite o comportamento novo, a regressão só aparece em produção.',
          code: truncate(first.path),
          suggestion: genericTestSuggestion(first, context),
        },
      ];
    },
  },
  {
    id: 'TST002',
    title: 'Export sem teste',
    severity: 'medium',
    category: 'tests',
    description: 'Novo export sem referência nos testes alterados.',
    scope: 'diff',
    run({ files, context }) {
      const tests = testFiles(files);
      if (tests.length === 0) return [];
      const testText = tests.map(fileText).join('\n');
      const findings = [];
      for (const file of sourceFiles(files)) {
        if (file.language === 'json' || file.language === 'yaml') continue;
        for (const line of file.hunks.flatMap((hunk) => hunk.lines)) {
          if (line.type !== 'add') continue;
          const name = exportName(line, file.language);
          if (!name) continue;
          const mentioned = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(testText);
          if (mentioned) continue;
          findings.push({
            file: file.path,
            line: line.newLine,
            severity: 'medium',
            confidence: 0.8,
            message: `Novo export "${name}" sem teste que o mencione.`,
            why: 'Os testes alterados cobrem outro caminho; este comportamento fica sem rede de proteção.',
            code: truncate(line.content),
            suggestion: generateTestSuggestion(file, context, name),
          });
          if (findings.length >= 5) return findings;
        }
      }
      return findings;
    },
  },
  {
    id: 'TST003',
    title: 'Teste focado ou pulado',
    severity: 'high',
    category: 'tests',
    description: '.only/.skip ou equivalente em arquivos de teste.',
    languages: ['js', 'ts', 'py', 'go', 'java'],
    testFilesOnly: true,
    run({ content }) {
      const match = [SKIP_OR_ONLY, PY_SKIP, GO_SKIP, JAVA_SKIP]
        .map((pattern) => pattern.exec(content))
        .find((hit) => hit && !isInsideStringLiteral(content, hit.index));
      if (!match) return [];
      const focused = /\.only\s*\(|\b(?:fit|fdescribe)\s*\(/.test(content);
      return [
        {
          severity: focused ? 'high' : 'medium',
          message: focused ? 'Teste com .only: o restante da suíte não roda.' : 'Teste pulado.',
          why: focused
            ? 'O CI fica verde testando apenas um caso, enquanto os outros são ignorados.'
            : 'Um teste desabilitado esconde a regressão que ele deveria pegar.',
          code: truncate(content),
          suggestion: infoSuggestion(
            focused ? 'Remover o .only antes do merge' : 'Reativar ou justificar o skip',
            'text',
            focused
              ? 'Troque `.only(` por `(` e rode a suíte completa.'
              : 'Se o skip for temporário, referencie a issue e a data para remoção.',
          ),
        },
      ];
    },
  },
  {
    id: 'TST004',
    title: 'Teste sem asserção',
    severity: 'low',
    category: 'tests',
    description: 'Arquivo de teste novo sem nenhuma verificação.',
    scope: 'diff',
    run({ files }) {
      const findings = [];
      for (const file of testFiles(files)) {
        const text = fileText(file);
        const declarations = /\b(?:it|test|describe)\s*\(|^\s*def test_|\bfunc Test\w+\s*\(/m.test(text);
        const assertions =
          /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\bassertEqual\b|\bassertTrue\b|\bshould\b|\bt\.(?:Error|Fatal|Fatalf)\b/.test(
            text,
          );
        if (!declarations || assertions) continue;
        const line = anchorLine(file);
        if (!line) continue;
        findings.push({
          file: file.path,
          line,
          severity: 'low',
          message: 'Teste sem nenhuma asserção.',
          why: 'Sem verificação, o teste passa mesmo quando o comportamento está errado.',
          code: truncate(file.path),
          suggestion: infoSuggestion(
            'Adicionar uma verificação',
            'javascript',
            "expect(resultado).toEqual(esperado)\n// ou: assert.equal(resultado, esperado)",
          ),
        });
      }
      return findings.slice(0, 3);
    },
  },
];
