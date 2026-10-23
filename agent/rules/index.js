'use strict';

const security = require('./security');
const bugs = require('./bugs');
const quality = require('./quality');
const tests = require('./tests');
const { houseRules } = require('./house');

const CORE_RULES = [...security, ...bugs, ...quality, ...tests];

function allRules(config) {
  return [...CORE_RULES, ...(config ? houseRules(config) : [])];
}

function catalog(config) {
  return allRules(config).map((rule) => ({
    id: rule.id,
    title: rule.title,
    severity: rule.severity,
    category: rule.category,
    check: rule.category === 'security' ? 'security' : rule.category === 'tests' ? 'tests' : rule.category === 'bug' ? 'bugs' : 'lint',
    languages: rule.languages || [],
    description: rule.description || '',
  }));
}

function findRule(id, config) {
  return allRules(config).find((rule) => rule.id === id) || null;
}

module.exports = { CORE_RULES, allRules, catalog, findRule };
