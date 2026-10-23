'use strict';

const { matchesAny } = require('../glob');
const { infoSuggestion, truncate } = require('./util');

function importedPackages(content, language) {
  const packages = [];
  let match;
  const jsFrom = /\bfrom\s+['"]([^'"]+)['"]/g;
  while ((match = jsFrom.exec(content))) packages.push(match[1]);
  const jsRequire = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = jsRequire.exec(content))) packages.push(match[1]);
  const jsBare = /^\s*import\s+['"]([^'"]+)['"]/g;
  while ((match = jsBare.exec(content))) packages.push(match[1]);
  if (language === 'py') {
    const pyImport = /^\s*import\s+([\w.]+)/g;
    while ((match = pyImport.exec(content))) packages.push(match[1]);
    const pyFrom = /^\s*from\s+([\w.]+)\s+import/g;
    while ((match = pyFrom.exec(content))) packages.push(match[1]);
  }
  return packages;
}

function packageMatches(found, forbidden) {
  return found === forbidden || found.startsWith(`${forbidden}/`) || found.startsWith(`${forbidden}.`);
}

/**
 * Regras que vêm da configuração do repositório ("a base de código ensina").
 * @param {object} config
 */
function houseRules(config) {
  const rules = [];

  if (config.rules.forbidImports.length > 0) {
    rules.push({
      id: 'HOU001',
      title: 'Import proibido',
      severity: 'medium',
      category: 'house',
      description: 'Pacote vetado pelas regras da casa.',
      languages: ['js', 'ts', 'py'],
      run({ content, file }) {
        const found = importedPackages(content, file.language);
        const hits = [];
        for (const item of config.rules.forbidImports) {
          const forbidden = typeof item === 'string' ? item : item.package;
          if (!forbidden) continue;
          if (item.files && !matchesAny(file.path, item.files)) continue;
          if (!found.some((name) => packageMatches(name, forbidden))) continue;
          hits.push({
            severity: item.severity || 'medium',
            message: `Import de "${forbidden}" vetado pelas regras da casa.`,
            why: item.reason || 'O time escolheu outra solução para este problema.',
            code: truncate(content),
            suggestion: infoSuggestion(
              'Usar a alternativa aprovada',
              'text',
              item.reason || `Substitua "${forbidden}" pela alternativa definida em .greenlight.json.`,
            ),
          });
        }
        return hits;
      },
    });
  }

  for (const custom of config.rules.custom) {
    let pattern;
    try {
      pattern = new RegExp(custom.pattern);
    } catch {
      continue;
    }
    rules.push({
      id: custom.id,
      title: custom.message.slice(0, 60),
      severity: custom.severity,
      category: 'house',
      description: custom.message,
      languages: null,
      run({ content, file }) {
        if (custom.files && !matchesAny(file.path, custom.files)) return [];
        if (!pattern.test(content)) return [];
        return [
          {
            severity: custom.severity,
            message: custom.message,
            why: 'Regra personalizada definida em .greenlight.json.',
            code: truncate(content),
            suggestion: custom.suggestion
              ? infoSuggestion('Correção sugerida', file.language === 'py' ? 'python' : 'javascript', custom.suggestion)
              : null,
          },
        ];
      },
    });
  }

  return rules;
}

module.exports = { houseRules, importedPackages };
