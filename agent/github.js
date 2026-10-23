'use strict';

const crypto = require('node:crypto');
const { SEVERITY_LABEL } = require('./findings');

const API = 'https://api.github.com';

function apiBase(explicit) {
  return String(explicit || process.env.GITHUB_API_URL || API).replace(/\/+$/, '');
}
const SEVERITY_EMOJI = {
  critical: '🟥',
  high: '🟧',
  medium: '🟨',
  low: '🟦',
  info: '⬜',
};

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * JWT RS256 para autenticar como GitHub App (válido por 9 minutos).
 */
function appJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Aceita "owner/repo#123", "owner/repo/pull/123" e a URL completa do GitHub.
 */
function parseRepoRef(input) {
  const value = String(input || '').trim();
  let match = /^(https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\/pull\/(\d+)|#(\d+))(?:[/?#].*)?$/.exec(value);
  if (!match) {
    match = /^(https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)\/(\d+)$/.exec(value);
    if (!match) return null;
    return { repo: `${match[2]}/${match[3]}`, number: Number(match[4]) };
  }
  const number = Number(match[4] || match[5]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repo: `${match[2]}/${match[3]}`, number };
}

function htmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Corpo de um comentário inline; usa ```suggestion para aplicação em 1 clique. */
function inlineCommentFor(finding) {
  const parts = [];
  parts.push(`${SEVERITY_EMOJI[finding.severity]} **${SEVERITY_LABEL[finding.severity]} · ${htmlEscape(finding.title)}**`);
  parts.push('');
  parts.push(htmlEscape(finding.message));
  if (finding.why) {
    parts.push('');
    parts.push(`_Por quê:_ ${htmlEscape(finding.why)}`);
  }
  if (finding.suggestion && finding.suggestion.code) {
    const lang = finding.suggestion.language || 'text';
    if (finding.suggestion.mode === 'replace' && finding.suggestion.applyable) {
      parts.push('');
      parts.push('```suggestion');
      parts.push(finding.suggestion.code.replace(/\n+$/, ''));
      parts.push('```');
    } else {
      parts.push('');
      parts.push(`<details><summary>${htmlEscape(finding.suggestion.title || 'Correção sugerida')}</summary>`);
      parts.push('');
      parts.push(`\`\`\`${lang}`);
      parts.push(finding.suggestion.code.replace(/\n+$/, ''));
      parts.push('```');
      if (finding.suggestion.filename) {
        parts.push('');
        parts.push(`Sugestão de arquivo: \`${htmlEscape(finding.suggestion.filename)}\``);
      }
      parts.push('');
      parts.push('</details>');
    }
  }
  parts.push('');
  parts.push(`<sub>Greenlight · \`${finding.ruleId}\`${finding.source === 'llm' ? ' + LLM' : ''}</sub>`);
  return parts.join('\n');
}

function checksTable(review) {
  const icon = (status) =>
    status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'warn' ? '⚠️' : '➖';
  const rows = review.checks.map(
    (check) => `| ${icon(check.status)} ${check.label} | ${htmlEscape(check.summary)} |`,
  );
  return ['| Checagem | Resultado |', '| --- | --- |', ...rows].join('\n');
}

function findingsList(review, max = 12) {
  if (review.findings.length === 0) return '_Nenhum problema encontrado._';
  const lines = review.findings.slice(0, max).map((finding) => {
    const location = `\`${finding.file}:${finding.line}\``;
    return `- ${SEVERITY_EMOJI[finding.severity]} **${SEVERITY_LABEL[finding.severity]}** ${location} — ${htmlEscape(finding.title)}`;
  });
  if (review.findings.length > max) {
    lines.push(`- … e mais ${review.findings.length - max}`);
  }
  return lines.join('\n');
}

function formatReviewBody(review, context = {}) {
  const stats = review.stats;
  const parts = [];
  const badge =
    review.verdict.status === 'ready' ? '🟢' : review.verdict.status === 'attention' ? '🟡' : '🔴';
  parts.push(`## ${badge} ${htmlEscape(review.verdict.label)}`);
  parts.push('');
  parts.push(htmlEscape(review.verdict.reason) + '.');
  if (review.summary) {
    parts.push('');
    parts.push(htmlEscape(review.summary));
  }
  parts.push('');
  parts.push(
    `**${stats.files} ${stats.files === 1 ? 'arquivo' : 'arquivos'}** · +${stats.additions} −${stats.deletions} · ` +
      `${review.durationMs}ms · failOn: \`${review.config.failOn}\``,
  );
  parts.push('');
  parts.push(checksTable(review));
  parts.push('');
  parts.push('### Achados');
  parts.push('');
  parts.push(findingsList(review));
  if (review.suppressed.total > 0) {
    parts.push('');
    parts.push(
      `<sub>${review.suppressed.total} ${review.suppressed.total === 1 ? 'achado dispensado' : 'achados dispensados'} ` +
        '(greenlight-ignore, exceções ou histórico).</sub>',
    );
  }
  parts.push('');
  const llmLabel = review.engine.llm.status === 'ok' ? review.engine.llm.provider : 'off';
  const commit = context.commit ? ` · ${context.commit.slice(0, 7)}` : '';
  parts.push(
    `<sub>Greenlight ${review.engine.version} · ${review.engine.rules} regras · ` +
      `LLM: ${llmLabel}${commit}</sub>`,
  );
  return parts.join('\n');
}

function buildReviewPayload(review, options = {}) {
  const maxInline = options.maxInlineComments ?? 20;
  const comments = [];
  const used = new Set();
  for (const finding of review.findings) {
    if (comments.length >= maxInline) break;
    if (!finding.line) continue;
    const key = `${finding.file}:${finding.line}`;
    if (used.has(key)) continue; // o GitHub aceita só um comentário por linha
    used.add(key);
    comments.push({
      path: finding.file,
      line: finding.line,
      side: 'RIGHT',
      body: inlineCommentFor(finding),
    });
  }
  const event = options.event || (review.verdict.status === 'blocked' ? 'REQUEST_CHANGES' : 'COMMENT');
  return {
    event,
    body: formatReviewBody(review, options),
    comments,
  };
}

function buildCheckRun(review, options = {}) {
  const conclusion =
    review.verdict.status === 'blocked' ? 'failure' : review.verdict.status === 'attention' ? 'neutral' : 'success';
  const annotations = review.findings
    .filter((finding) => finding.line)
    .slice(0, 50)
    .map((finding) => ({
      path: finding.file,
      start_line: finding.line,
      end_line: finding.endLine || finding.line,
      annotation_level:
        finding.severity === 'critical' || finding.severity === 'high'
          ? 'failure'
          : finding.severity === 'medium'
            ? 'warning'
            : 'notice',
      title: `${finding.ruleId}: ${finding.title}`.slice(0, 255),
      message: `${finding.message}${finding.why ? `\n\n${finding.why}` : ''}`.slice(0, 65000),
    }));
  return {
    name: options.name || 'Greenlight',
    head_sha: options.headSha,
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: review.verdict.label.slice(0, 255),
      summary: `${review.verdict.reason}. ${review.summary}`.slice(0, 65000),
      text: formatReviewBody(review, options).slice(0, 65000),
      annotations,
    },
  };
}

class GitHubClient {
  constructor({ token, fetchImpl = globalThis.fetch, baseUrl = apiBase(), userAgent = 'greenlight-agent' } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.baseUrl = apiBase(baseUrl);
    this.userAgent = userAgent;
  }

  async request(method, path, body = null, { accept = 'application/vnd.github+json', raw = false } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'user-agent': this.userAgent,
        'x-github-api-version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
      const error = new Error(`GitHub ${method} ${path} → ${response.status}: ${text}`);
      error.status = response.status;
      throw error;
    }
    if (raw) return response.text();
    if (response.status === 204) return null;
    return response.json();
  }

  async getPullRequest(repo, number) {
    return this.request('GET', `/repos/${repo}/pulls/${number}`);
  }

  async getPullRequestDiff(repo, number) {
    return this.request('GET', `/repos/${repo}/pulls/${number}`, null, {
      accept: 'application/vnd.github.v3.diff',
      raw: true,
    });
  }

  async listPullRequestFiles(repo, number) {
    const files = [];
    for (let page = 1; page <= 10; page += 1) {
      const batch = await this.request('GET', `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  async createReview(repo, number, payload) {
    return this.request('POST', `/repos/${repo}/pulls/${number}/reviews`, payload);
  }

  async createIssueComment(repo, number, body) {
    return this.request('POST', `/repos/${repo}/issues/${number}/comments`, { body });
  }

  async createCheckRun(repo, payload) {
    return this.request('POST', `/repos/${repo}/check-runs`, payload);
  }

  async getContent(repo, filePath, ref) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      return await this.request('GET', `/repos/${repo}/contents/${filePath}${query}`);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async getInstallation(installationId) {
    return this.request('GET', `/app/installations/${installationId}`);
  }

  async getAuthenticatedUser() {
    return this.request('GET', '/user');
  }
}

async function installationToken({
  appId,
  privateKey,
  installationId,
  fetchImpl = globalThis.fetch,
  baseUrl = apiBase(),
}) {
  const jwt = appJwt(appId, privateKey);
  const response = await fetchImpl(`${apiBase(baseUrl)}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'user-agent': 'greenlight-agent',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Falha ao autenticar a instalação ${installationId}: ${response.status} ${detail}`);
  }
  const data = await response.json();
  return { token: data.token, expiresAt: data.expires_at };
}

module.exports = {
  API,
  apiBase,
  appJwt,
  verifyWebhookSignature,
  htmlEscape,
  inlineCommentFor,
  formatReviewBody,
  buildReviewPayload,
  buildCheckRun,
  GitHubClient,
  installationToken,
  parseRepoRef,
  checksTable,
};
