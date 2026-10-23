'use strict';

const {
  GitHubClient,
  installationToken,
  verifyWebhookSignature,
  buildReviewPayload,
  buildCheckRun,
} = require('../agent/github');
const { normalizeConfig } = require('../agent/config');
const { review } = require('../agent/review');
const { diffFromGitHubFiles } = require('../agent/diff');
const { readBody, sendJson, BodyError } = require('./http');

const ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);
const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

function readAppConfig(env = process.env) {
  const privateKey = String(env.GITHUB_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return {
    appId: env.GITHUB_APP_ID || '',
    privateKey,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET || '',
    apiUrl: String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    configured: Boolean(env.GITHUB_APP_ID && privateKey),
    allowUnsigned:
      env.GREENLIGHT_ALLOW_UNSIGNED_WEBHOOKS === '1' || env.NODE_ENV === 'development' || env.NODE_ENV === 'test',
  };
}

function appStatus(env = process.env) {
  const config = readAppConfig(env);
  return {
    configured: config.configured,
    webhook: config.configured && Boolean(config.webhookSecret),
    apiUrl: config.apiUrl,
    signedWebhooksRequired: !config.allowUnsigned,
    events: [...ACTIONS],
    setup: config.configured
      ? null
      : [
          'Crie um GitHub App em Settings → Developer settings → GitHub Apps.',
          'Webhook URL: https://SEU_DOMINIO/api/github/webhook',
          'Permissões: Pull requests (read/write), Contents (read), Checks (read/write), Metadata (read).',
          'Eventos: Pull request.',
          'Gere uma private key e defina GITHUB_APP_ID, GITHUB_PRIVATE_KEY e GITHUB_WEBHOOK_SECRET.',
        ],
  };
}

async function fetchRepoConfig(client, repo, ref, logger) {
  try {
    const content = await client.getContent(repo, '.greenlight.json', ref);
    if (!content || content.type !== 'file' || !content.content) return null;
    const text = Buffer.from(content.content, content.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    if (text.length > 100_000) return null;
    const { config, warnings } = normalizeConfig(JSON.parse(text));
    if (warnings.length && logger) logger(`config de ${repo}: ${warnings.join(' | ')}`);
    return config;
  } catch (error) {
    if (logger) logger(`config de ${repo} ignorada: ${error.message}`);
    return null;
  }
}

/**
 * Revisa um PR e publica o resultado: comentários inline, resumo e check run.
 * Exportado para testes; o handler HTTP chama em background.
 */
async function processPullRequest({
  payload,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = () => {},
}) {
  const repo = payload.repository && payload.repository.full_name;
  const number = payload.pull_request && payload.pull_request.number;
  const headSha = payload.pull_request && payload.pull_request.head && payload.pull_request.head.sha;
  const installationId = payload.installation && payload.installation.id;
  if (!repo || !number || !installationId) {
    return { status: 'ignored', reason: 'payload sem repo/número/instalação' };
  }

  const app = readAppConfig(env);
  if (!app.configured) {
    return { status: 'skipped', reason: 'GitHub App não configurado' };
  }

  const { token } = await installationToken({
    appId: app.appId,
    privateKey: app.privateKey,
    installationId,
    fetchImpl,
    baseUrl: app.apiUrl,
  });
  const client = new GitHubClient({ token, fetchImpl, baseUrl: app.apiUrl });

  const repoConfig = await fetchRepoConfig(client, repo, headSha, logger);
  const config = repoConfig || normalizeConfig({}).config;
  const draft = Boolean(payload.pull_request.draft);
  if (draft && !config.github.reviewDrafts) {
    return { status: 'skipped', reason: 'rascunho (github.reviewDrafts=false)' };
  }

  const files = await client.listPullRequestFiles(repo, number);
  if (!files.length) return { status: 'skipped', reason: 'PR sem arquivos' };
  const diff = diffFromGitHubFiles(files);

  const result = await review(diff, {
    root: env.GREENLIGHT_ROOT || process.cwd(),
    config,
    index: null,
    source: 'github',
    repo: { repo, number, commit: headSha },
    env,
    fetchImpl,
    logger,
  });

  const payloadReview = buildReviewPayload(result, {
    maxInlineComments: config.github.maxInlineComments,
    event: config.github.requestChanges && result.verdict.status === 'blocked' ? 'REQUEST_CHANGES' : 'COMMENT',
    commit: headSha,
  });

  let posted = false;
  try {
    await client.createReview(repo, number, {
      commit_id: headSha,
      body: payloadReview.body,
      comments: payloadReview.comments,
      event: payloadReview.event,
    });
    posted = true;
  } catch (error) {
    // 422 acontece quando um comentário cai fora do diff ou o diff é grande
    // demais; nesse caso o resumo em comentário simples ainda é útil.
    logger(`revisão inline falhou em ${repo}#${number}: ${error.message}`);
    await client.createIssueComment(repo, number, payloadReview.body);
    posted = true;
  }

  let checkRunId = null;
  if (config.github.checks && headSha) {
    try {
      const check = await client.createCheckRun(repo, buildCheckRun(result, { headSha, commit: headSha }));
      checkRunId = check && check.id ? check.id : null;
    } catch (error) {
      logger(`check run falhou em ${repo}#${number}: ${error.message}`);
    }
  }

  return {
    status: 'reviewed',
    repo,
    number,
    commit: headSha,
    reviewId: result.id,
    verdict: result.verdict.status,
    findings: result.findings.length,
    posted,
    checkRunId,
  };
}

function createDedupe() {
  const seen = new Map();
  return function shouldProcess(key) {
    const now = Date.now();
    for (const [entry, time] of seen) {
      if (now - time > 10 * 60_000) seen.delete(entry);
    }
    if (seen.has(key)) return false;
    seen.set(key, now);
    return true;
  };
}

function createWebhookHandler({ env = process.env, fetchImpl = globalThis.fetch, logger = console.log } = {}) {
  const shouldProcess = createDedupe();
  return async function webhook(req, res) {
    const app = readAppConfig(env);
    let raw;
    try {
      raw = await readBody(req, MAX_WEBHOOK_BYTES);
    } catch (error) {
      sendJson(res, error instanceof BodyError ? error.status : 400, { error: error.message });
      return;
    }

    if (app.webhookSecret) {
      const signature = req.headers['x-hub-signature-256'];
      if (!verifyWebhookSignature(raw, signature, app.webhookSecret)) {
        sendJson(res, 401, { error: 'assinatura do webhook inválida' });
        return;
      }
    } else if (!app.allowUnsigned) {
      sendJson(res, 400, {
        error: 'GITHUB_WEBHOOK_SECRET não configurado; webhooks sem assinatura são recusados em produção.',
      });
      return;
    }

    const event = String(req.headers['x-github-event'] || '');
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      sendJson(res, 400, { error: 'payload não é JSON' });
      return;
    }

    if (event === 'ping') {
      sendJson(res, 200, { ok: true, zen: payload.zen || null });
      return;
    }
    if (event !== 'pull_request' || !ACTIONS.has(payload.action)) {
      sendJson(res, 202, { ignored: true, event, action: payload.action || null });
      return;
    }

    const key = `${payload.repository && payload.repository.full_name}#${payload.pull_request && payload.pull_request.number}@${
      payload.pull_request && payload.pull_request.head && payload.pull_request.head.sha
    }`;
    if (!shouldProcess(key)) {
      sendJson(res, 202, { ignored: true, reason: 'entrega duplicada' });
      return;
    }

    // O GitHub corta a entrega em 10s: confirma agora e processa em background.
    sendJson(res, 202, { accepted: true, delivery: req.headers['x-github-delivery'] || null });
    processPullRequest({ payload, env, fetchImpl, logger })
      .then((outcome) => {
        logger(
          `webhook ${key}: ${outcome.status}` +
            (outcome.reason ? ` (${outcome.reason})` : '') +
            (outcome.findings !== undefined ? ` · ${outcome.findings} achados · ${outcome.verdict}` : ''),
        );
      })
      .catch((error) => logger(`webhook ${key} falhou: ${error.message}`));
  };
}

module.exports = { readAppConfig, appStatus, processPullRequest, createWebhookHandler, fetchRepoConfig };
