'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MEMORY_DIR = '.greenlight';
const MEMORY_FILE = 'memory.json';

function memoryPath(root) {
  return path.join(root || process.cwd(), MEMORY_DIR, MEMORY_FILE);
}

function emptyMemory() {
  return {
    version: 1,
    dismissed: [],
    stats: { reviews: 0, findings: 0, lastReviewAt: null },
    updatedAt: null,
  };
}

function loadMemory(root) {
  const file = memoryPath(root);
  if (!fs.existsSync(file)) return emptyMemory();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...emptyMemory(),
      ...parsed,
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
      stats: { ...emptyMemory().stats, ...(parsed.stats || {}) },
    };
  } catch {
    return emptyMemory();
  }
}

function saveMemory(root, memory) {
  const file = memoryPath(root);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ ...memory, updatedAt: new Date().toISOString() }, null, 2) + '\n';
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, payload);
  fs.renameSync(temp, file);
  return file;
}

function isDismissed(finding, memory) {
  return (memory.dismissed || []).some((entry) => {
    if (entry.id) return entry.id === finding.id;
    // Entradas antigas, sem fingerprint: compara o local também, senão uma
    // dispensa silenciaria todos os achados iguais do mesmo arquivo.
    return (
      entry.ruleId === finding.ruleId &&
      entry.file === finding.file &&
      entry.title === finding.title &&
      (entry.line == null || entry.line === finding.line)
    );
  });
}

function applyDismissals(findings, memory) {
  const kept = [];
  const dismissed = [];
  for (const finding of findings) {
    if (isDismissed(finding, memory)) dismissed.push(finding);
    else kept.push(finding);
  }
  return { findings: kept, dismissed };
}

function dismissFinding(root, finding, reason = '') {
  const memory = loadMemory(root);
  const entry = {
    id: finding.id,
    ruleId: finding.ruleId,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    reason: String(reason || '').slice(0, 300),
    at: new Date().toISOString(),
  };
  memory.dismissed = memory.dismissed.filter(
    (item) => !(item.ruleId === entry.ruleId && item.file === entry.file && item.title === entry.title),
  );
  memory.dismissed.push(entry);
  saveMemory(root, memory);
  return entry;
}

function recordReview(root, review) {
  const memory = loadMemory(root);
  memory.stats.reviews += 1;
  memory.stats.findings += review.findings.length;
  memory.stats.lastReviewAt = new Date().toISOString();
  memory.stats.lastVerdict = review.verdict.status;
  saveMemory(root, memory);
  return memory;
}

module.exports = {
  MEMORY_DIR,
  MEMORY_FILE,
  memoryPath,
  loadMemory,
  saveMemory,
  emptyMemory,
  isDismissed,
  applyDismissals,
  dismissFinding,
  recordReview,
};
