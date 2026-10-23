'use strict';

const path = require('node:path');
const { languageOf } = require('./diff');

const FRAMEWORKS = {
  'node:test': { label: 'node:test', language: 'javascript' },
  vitest: { label: 'Vitest', language: 'javascript' },
  jest: { label: 'Jest', language: 'javascript' },
  mocha: { label: 'Mocha', language: 'javascript' },
  pytest: { label: 'pytest', language: 'python' },
  'go test': { label: 'go test', language: 'go' },
  rspec: { label: 'RSpec', language: 'ruby' },
  phpunit: { label: 'PHPUnit', language: 'php' },
};

function parseParams(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((param) => param.trim().replace(/^\.\.\./, '').split(/[:=]/)[0].trim())
    .map((param) => param.replace(/^\*+/, ''))
    .filter((param) => /^[A-Za-z_$][\w$]*$/.test(param))
    .filter((param) => param !== 'self' && param !== 'cls' && param !== 'ctx');
}

function extractFunctions(file, onlyAdded = true) {
  const functions = [];
  const seen = new Set();
  for (const line of file.hunks.flatMap((hunk) => hunk.lines)) {
    if (onlyAdded && line.type !== 'add') continue;
    const text = line.content;
    let match;

    match = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/.exec(text);
    if (match) {
      addFunction(functions, seen, match[1], match[2], line.newLine, 'function');
      continue;
    }

    match = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/.exec(
      text,
    );
    if (match) {
      addFunction(functions, seen, match[1], match[2] || match[3], line.newLine, 'arrow');
      continue;
    }

    match = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(text);
    if (match) {
      addFunction(functions, seen, match[1], match[2], line.newLine, 'function');
      continue;
    }

    if (file.language === 'py') {
      match = /^\s*def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(text);
      if (match && !match[1].startsWith('_')) {
        addFunction(functions, seen, match[1], match[2], line.newLine, 'function');
      }
      continue;
    }

    if (file.language === 'go') {
      match = /^func\s+([A-Z]\w*)\s*\(([^)]*)\)/.exec(text);
      if (match) addFunction(functions, seen, match[1], match[2], line.newLine, 'function');
      continue;
    }

    if (file.language === 'rust') {
      match = /^\s*pub\s+(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/.exec(text);
      if (match) addFunction(functions, seen, match[1], match[2], line.newLine, 'function');
    }
  }
  return functions;
}

function addFunction(list, seen, name, params, line, kind) {
  if (!name || seen.has(name)) return;
  seen.add(name);
  list.push({ name, params: parseParams(params), line, kind });
}

function sourceName(filePath) {
  return path.basename(filePath).replace(/\.[^.]+$/, '');
}

function testPathFor(filePath, framework) {
  const ext = path.extname(filePath) || '.js';
  const base = sourceName(filePath);
  const dir = path.posix.dirname(filePath.replace(/\\/g, '/'));
  if (framework === 'pytest') return `tests/test_${base}.py`;
  if (framework === 'go test') return `${filePath.replace(/\.go$/, '')}_test.go`;
  if (framework === 'rspec') return `spec/${base}_spec.rb`;
  if (framework === 'phpunit') return `tests/${base}Test.php`;
  if (framework === 'vitest' || framework === 'jest') {
    return path.posix.join(dir === '.' ? '' : dir, `${base}.test${ext}`);
  }
  return path.posix.join('test', `${base}.test${ext === '.ts' ? '.ts' : '.js'}`);
}

function importPathFor(filePath, testPath, language) {
  const fromDir = path.posix.dirname(testPath);
  const target = filePath.replace(/\\/g, '/');
  let relative = path.posix.relative(fromDir, target);
  if (!relative.startsWith('.')) relative = `./${relative}`;
  if (language === 'python') {
    return target.replace(/^src\//, '').replace(/\//g, '.').replace(/\.py$/, '');
  }
  if (language === 'typescript' || language === 'javascript') {
    if (target.endsWith('.ts') || target.endsWith('.tsx')) {
      return relative.replace(/\.tsx?$/, '.js');
    }
    return relative;
  }
  return relative;
}

function fixtures(fn) {
  if (!fn.params.length) return '  // Nenhum parâmetro: o cenário vem do estado do módulo.\n';
  return fn.params
    .map((param, index) => `  const ${param} = criarFixture${index + 1}() // ajuste o cenário`)
    .join('\n') + '\n';
}

function callFor(fn) {
  return `${fn.name}(${fn.params.map((param) => param).join(', ')})`;
}

function nodeTestCode(fn, importPath, isTypeScript) {
  const header = isTypeScript
    ? "import test from 'node:test'\nimport assert from 'node:assert/strict'\n"
    : "const test = require('node:test')\nconst assert = require('node:assert/strict')\n";
  const requireLine = isTypeScript
    ? `import { ${fn.name} } from '${importPath}'\n`
    : `const { ${fn.name} } = require('${importPath}')\n`;
  return (
    header +
    requireLine +
    '\n' +
    `test('${fn.name} devolve o resultado esperado', async () => {\n` +
    fixtures(fn) +
    `  const resultado = await ${callFor(fn)}\n\n` +
    '  assert.ok(resultado !== undefined)\n})\n\n' +
    `test('${fn.name} propaga o erro quando a dependência falha', async () => {\n` +
    '  // Ajuste o cenário para forçar a falha.\n' +
    `  await assert.rejects(async () => {\n    await ${callFor(fn)}\n  })\n})\n`
  );
}

function vitestCode(fn, importPath, packageName) {
  const header = packageName === 'vitest' ? "import { describe, it, expect } from 'vitest'\n" : '';
  return (
    header +
    `import { ${fn.name} } from '${importPath}'\n\n` +
    `describe('${fn.name}', () => {\n` +
    `  it('devolve o resultado esperado', async () => {\n` +
    fixtures(fn) +
    `    const resultado = await ${callFor(fn)}\n\n` +
    '    expect(resultado).toBeDefined()\n  })\n\n' +
    "  it('propaga o erro quando a dependência falha', async () => {\n" +
    '    // Ajuste o cenário para forçar a falha.\n' +
    `    await expect(${callFor(fn)}).rejects.toThrow()\n  })\n})\n`
  );
}

function pytestCode(fn, modulePath) {
  return (
    `from ${modulePath} import ${fn.name}\n\n\n` +
    `def test_${fn.name}_devolve_resultado():\n` +
    '    # Ajuste o cenário.\n' +
    fn.params.map((param, index) => `    ${param} = criar_fixture_${index + 1}()`).join('\n') +
    (fn.params.length ? '\n\n' : '\n') +
    `    resultado = ${callFor(fn)}\n\n` +
    '    assert resultado is not None\n\n\n' +
    `def test_${fn.name}_propaga_erro():\n` +
    '    # Ajuste o cenário para forçar a falha.\n' +
    '    with pytest.raises(Exception):\n' +
    `        ${callFor(fn)}\n`
  );
}

function goTestCode(fn) {
  const args = fn.params.filter((param) => param !== 't');
  return (
    'package main\n\nimport "testing"\n\n' +
    `func Test${fn.name.charAt(0).toUpperCase()}${fn.name.slice(1)}(t *testing.T) {\n` +
    '    // Ajuste o cenário.\n' +
    `    got := ${fn.name}(${args.join(', ')})\n` +
    '    if got == nil {\n        t.Fatal("resultado inesperado: nil")\n    }\n}\n'
  );
}

/**
 * Gera um esqueleto de teste executável para a função (ou para o arquivo).
 * Não inventa asserções: deixa o cenário explícito para quem for completar.
 */
function generateTestSuggestion(file, context = {}, functionName = null) {
  const framework = FRAMEWORKS[context.testFramework] ? context.testFramework : 'node:test';
  const functions = extractFunctions(file)
    .filter((fn) => !functionName || fn.name === functionName)
    .slice(0, 3);
  const fallback = {
    name: sourceName(file.path).replace(/[^\w$]/g, '_'),
    params: [],
    line: null,
    kind: 'function',
  };
  const fn = functions[0] || (functionName ? { ...fallback, name: functionName } : fallback);
  const testPath = testPathFor(file.path, framework);
  const language = languageOf(file.path);
  const importPath = importPathFor(file.path, testPath, language);
  let code;
  let lang = 'javascript';

  if (framework === 'pytest' && language === 'py') {
    code = `import pytest\n\n${pytestCode(fn, importPath)}`;
    lang = 'python';
  } else if (framework === 'go test' && language === 'go') {
    code = goTestCode(fn);
    lang = 'go';
  } else if (framework === 'vitest' || framework === 'jest') {
    code = vitestCode(fn, importPath, framework === 'vitest' ? 'vitest' : 'jest');
  } else if (language === 'ts' || language === 'tsx') {
    code = nodeTestCode(fn, importPath, true);
    lang = 'typescript';
  } else {
    code = nodeTestCode(fn, importPath, false);
  }

  return {
    title: `Teste sugerido para ${fn.name}`,
    language: lang,
    code,
    mode: 'test',
    applyable: false,
    filename: testPath,
    functionName: fn.name,
  };
}

function genericTestSuggestion(file, context = {}) {
  const framework = FRAMEWORKS[context.testFramework] ? context.testFramework : 'node:test';
  if (framework === 'pytest' || file.language === 'py') {
    return {
      title: 'Teste sugerido',
      language: 'python',
      code:
        'import pytest\n\n\n' +
        `def test_${sourceName(file.path)}():\n` +
        '    # Exercite o comportamento novo e verifique o resultado.\n' +
        '    assert True\n',
      mode: 'test',
      applyable: false,
      filename: `tests/test_${sourceName(file.path)}.py`,
    };
  }
  return generateTestSuggestion(file, context);
}

module.exports = {
  FRAMEWORKS,
  extractFunctions,
  testPathFor,
  generateTestSuggestion,
  genericTestSuggestion,
};
