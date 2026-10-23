'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const pkg = require('../package.json');
const { review, reviewPipeline, ReviewError } = require('../agent/review');
const { loadConfig } = require('../agent/config');
const { catalog } = require('../agent/rules');
const { describeLlm } = require('../agent/llm');
const { loadIndex, indexSummary } = require('../agent/learn');
const { applySuggestion } = require('../agent/patch');
const { createFinding } = require('../agent/findings');
const { appStatus, createWebhookHandler } = require('./github-app');
const { loadEnv } = require('../agent/env');
const {
  applySecurityHeaders,
  sendJson,
  sendText,
  sendRedirect,
  readJson,
  readBody,
  BodyError,
  createRateLimiter,
  clientIp,
  sseStart,
  sseSend,
  sseEnd,
} = require('./http');

const ROOT = path.resolve(__dirname, '..');
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/main.js', { file: 'main.js', type: 'text/javascript; charset=utf-8' }],
  ['/agent/agent.js', { file: 'agent/agent.js', type: 'text/javascript; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
]);

function loadScenarios() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'samples', 'scenarios.json'), 'utf8');
    const list = JSON.parse(raw);
    return list.filter(
      (scenario) =>
        scenario &&
        typeof scenario.id === 'string' &&
        /^[a-z0-9-]+$/.test(scenario.id) &&
        typeof scenario.file === 'string' &&
        /^[a-z0-9-]+\.diff$/.test(scenario.file),
    );
  } catch {
    return [];
  }
}

function createServer(options = {}) {
  const root = options.root || ROOT;
  const env = options.env || process.env;
  const logger = options.logger || console.log;
  const maxDiffBytes = Math.min(Math.max(Number(env.GREENLIGHT_MAX_DIFF_BYTES) || 512 * 1024, 4096), 4 * 1024 * 1024);
  const startedAt = Date.now();
  const scenarios = loadScenarios();
  const reviewLimiter = createRateLimiter({ windowMs: 60_000, max: Number(env.GREENLIGHT_RATE_LIMIT) || 40 });
  const actionLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
  const sessionMemory = { dismissed: [] };
  const history = [];
  const configResult = loadConfig(root);
  const config = configResult.config;
  const llm = describeLlm(config, env);
  const index = loadIndex(root);

  const webhook = createWebhookHandler({ env, logger });

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // curl/CLI
    try {
      const parsed = new URL(origin);
      return parsed.host === req.headers.host;
    } catch {
      return false;
    }
  }

  function guard(req, res, limiter) {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: 'origem não permitida' });
      return false;
    }
    const result = limiter(clientIp(req));
    if (!result.allowed) {
      res.setHeader('retry-after', String(result.retryAfter));
      sendJson(res, 429, { error: `Muitas requisições. Tente de novo em ${result.retryAfter}s.` });
      return false;
    }
    return true;
  }

  async function readDiff(req) {
    const body = await readJson(req, maxDiffBytes + 8192);
    const diff = typeof body.diff === 'string' ? body.diff : '';
    if (!diff.trim()) throw new ReviewError('Envie o diff unificado em "diff".', 'EMPTY_DIFF');
    if (Buffer.byteLength(diff) > maxDiffBytes) {
      throw new ReviewError(`Diff maior que o limite de ${maxDiffBytes} bytes.`, 'DIFF_TOO_LARGE');
    }
    return { body, diff };
  }

  function remember(reviewResult, scenarioId) {
    history.unshift({
      id: reviewResult.id,
      at: reviewResult.createdAt,
      scenarioId: scenarioId || null,
      verdict: reviewResult.verdict.status,
      findings: reviewResult.findings.length,
      files: reviewResult.stats.files,
      durationMs: reviewResult.durationMs,
    });
    if (history.length > 20) history.pop();
  }

  function demoMetadata() {
    return {
      serverTime: new Date().toISOString(),
      llm: describeLlm(config, env),
      memory: { dismissed: sessionMemory.dismissed.length, persistent: false },
    };
  }

  const server = http.createServer(async (req, res) => {
    const requestStarted = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { error: 'URL inválida' });
      return;
    }

    applySecurityHeaders(res);
    res.on('finish', () => {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/samples/')) {
        logger(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - requestStarted}ms`);
      }
    });

    try {
      /* --------------------------------------------------------------- API -- */
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          name: 'greenlight',
          version: pkg.version,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          node: process.version,
          rules: catalog(config).length,
          llm: describeLlm(config, env),
          github: (() => {
            const status = appStatus(env);
            return { configured: status.configured, webhook: status.webhook };
          })(),
          index: index
            ? { learned: true, generatedAt: index.generatedAt, project: index.projectName, testFramework: index.testFramework }
            : { learned: false },
          scenarios: scenarios.length,
          limits: { maxDiffBytes, reviewsPerMinute: Number(env.GREENLIGHT_RATE_LIMIT) || 40 },
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/rules') {
        sendJson(res, 200, {
          rules: catalog(config),
          config: {
            failOn: config.failOn,
            maxLineLength: config.rules.maxLineLength,
            testsRequired: config.tests.requireChangedTests,
            forbidImports: config.rules.forbidImports.map((item) => item.package),
            customRules: config.rules.custom.map((rule) => rule.id),
            exceptions: config.exceptions.length,
          },
          index: index ? { ...index, readme: undefined, dependencies: undefined } : null,
          warnings: configResult.warnings,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/scenarios') {
        sendJson(res, 200, {
          scenarios: scenarios.map((scenario) => ({
            id: scenario.id,
            title: scenario.title,
            subtitle: scenario.subtitle,
            note: scenario.note,
            url: `/samples/${scenario.id}.diff`,
          })),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        sendJson(res, 200, {
          failOn: config.failOn,
          checks: config.checks,
          github: { checks: config.github.checks, requestChanges: config.github.requestChanges },
          tests: config.tests,
          rules: config.rules.custom.length + config.rules.forbidImports.length,
          llm: describeLlm(config, env),
          index: index ? { generatedAt: index.generatedAt, project: index.projectName } : null,
          warnings: configResult.warnings,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/history') {
        sendJson(res, 200, { history });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/dismissed') {
        sendJson(res, 200, { dismissed: sessionMemory.dismissed, demo: demoMetadata() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/dismiss') {
        if (!guard(req, res, actionLimiter)) return;
        const body = await readJson(req, 8192);
        if (!body.finding || typeof body.finding !== 'object') {
          sendJson(res, 400, { error: 'envie o achado em "finding"' });
          return;
        }
        const finding = body.finding;
        if (typeof finding.id !== 'string' || typeof finding.ruleId !== 'string' || typeof finding.file !== 'string') {
          sendJson(res, 400, { error: 'achado sem id/ruleId/file' });
          return;
        }
        const normalized = createFinding({
          ...finding,
          title: String(finding.title || 'achado'),
          message: String(finding.message || ''),
          severity: finding.severity || 'medium',
          category: finding.category || 'quality',
          ruleId: finding.ruleId,
          file: finding.file,
          line: Number(finding.line) || null,
        });
        if (!sessionMemory.dismissed.some((entry) => entry.id === normalized.id)) {
          sessionMemory.dismissed.push({
            id: normalized.id,
            ruleId: normalized.ruleId,
            file: normalized.file,
            title: normalized.title,
            reason: String(body.reason || '').slice(0, 200),
            at: new Date().toISOString(),
          });
        }
        sendJson(res, 200, { dismissed: sessionMemory.dismissed, demo: demoMetadata() });
        return;
      }

      if (req.method === 'DELETE' && url.pathname === '/api/dismissed') {
        if (!guard(req, res, actionLimiter)) return;
        sessionMemory.dismissed = [];
        sendJson(res, 200, { dismissed: [], demo: demoMetadata() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/apply') {
        if (!guard(req, res, actionLimiter)) return;
        const body = await readJson(req, maxDiffBytes + 8192);
        const diff = typeof body.diff === 'string' ? body.diff : '';
        const suggestion = body.suggestion;
        const file = typeof body.file === 'string' ? body.file : '';
        if (!diff || !file || !suggestion || typeof suggestion !== 'object') {
          sendJson(res, 400, { error: 'envie diff, file e suggestion' });
          return;
        }
        if (suggestion.mode !== 'replace' || typeof suggestion.code !== 'string' || suggestion.code.length > 20000) {
          sendJson(res, 400, { error: 'só correções "replace" podem ser aplicadas' });
          return;
        }
        const patched = applySuggestion(diff, {
          file,
          suggestion: {
            mode: 'replace',
            code: suggestion.code,
            startLine: Number(suggestion.startLine),
            endLine: Number(suggestion.endLine),
          },
        });
        sendJson(res, 200, { diff: patched });
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/api/review' || url.pathname === '/api/review/stream')) {
        if (!guard(req, res, reviewLimiter)) return;
        const { body, diff } = await readDiff(req);
        const overrides = body.options && typeof body.options === 'object' ? body.options : {};
        const common = {
          root,
          env,
          config: overrides.config && typeof overrides.config === 'object' ? overrides.config : config,
          index: null,
          memory: sessionMemory,
          source: body.scenarioId ? `demo:${body.scenarioId}` : 'web',
          llm: overrides.llm === false ? false : undefined,
          failOn: typeof overrides.failOn === 'string' ? overrides.failOn : undefined,
        };

        if (url.pathname === '/api/review/stream') {
          sseStart(res);
          const heartbeat = setInterval(() => {
            if (!res.writableEnded) res.write(': ping\n\n');
          }, 15_000);
          let aborted = false;
          res.on('close', () => {
            aborted = true;
            clearInterval(heartbeat);
          });
          try {
            for await (const event of reviewPipeline(diff, common)) {
              if (aborted) break;
              if (event.type === 'done') {
                remember(event.review, body.scenarioId);
                sseSend(res, 'done', event);
              } else if (event.type === 'stage') {
                sseSend(res, 'stage', event);
              } else if (event.type === 'checks') {
                sseSend(res, 'checks', event.checks);
              } else if (event.type === 'findings') {
                sseSend(res, 'findings', event.findings);
              } else if (event.type === 'summary') {
                sseSend(res, 'summary', event.summary);
              }
            }
          } catch (error) {
            if (!aborted) {
              sseSend(res, 'error', {
                error: error instanceof ReviewError ? error.message : 'Falha ao revisar o diff.',
                code: error.code || 'REVIEW_FAILED',
              });
            }
          } finally {
            clearInterval(heartbeat);
            sseEnd(res);
          }
          return;
        }

        const result = await review(diff, common);
        remember(result, body.scenarioId);
        sendJson(res, 200, { review: result, demo: demoMetadata() });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/github/status') {
        sendJson(res, 200, appStatus(env));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/github/webhook') {
        await webhook(req, res);
        return;
      }

      /* ------------------------------------------------------------ Static -- */
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname === '/demo' || url.pathname === '/agent' || url.pathname === '/agente') {
          sendRedirect(res, '/#agent');
          return;
        }

        const sampleMatch = /^\/samples\/([a-z0-9-]+)\.diff$/.exec(url.pathname);
        if (sampleMatch) {
          const scenario = scenarios.find((item) => item.id === sampleMatch[1]);
          if (!scenario) {
            sendText(res, 404, 'Cenário não encontrado.\n');
            return;
          }
          const file = path.join(root, 'samples', scenario.file);
          if (!fs.existsSync(file)) {
            sendText(res, 404, 'Diff não encontrado.\n');
            return;
          }
          const text = fs.readFileSync(file, 'utf8');
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': Buffer.byteLength(text),
            'cache-control': 'no-cache',
          });
          res.end(req.method === 'HEAD' ? undefined : text);
          return;
        }

        const entry = STATIC_FILES.get(url.pathname);
        if (entry) {
          const file = path.join(root, entry.file);
          if (!fs.existsSync(file)) {
            sendText(res, 404, 'Arquivo não encontrado.\n');
            return;
          }
          const data = fs.readFileSync(file);
          res.writeHead(200, {
            'content-type': entry.type,
            'content-length': data.length,
            'cache-control': 'no-cache',
          });
          res.end(req.method === 'HEAD' ? undefined : data);
          return;
        }
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        sendText(res, 404, 'não encontrado\n');
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'endpoint não encontrado' });
        return;
      }
      if (req.method === 'GET' && !path.extname(url.pathname).includes('.')) {
        sendRedirect(res, '/#agent');
        return;
      }
      sendText(res, 404, 'não encontrado\n');
    } catch (error) {
      if (error instanceof BodyError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (error instanceof ReviewError) {
        sendJson(res, error.code === 'DIFF_TOO_LARGE' ? 413 : 422, { error: error.message, code: error.code });
        return;
      }
      logger(`erro em ${req.method} ${url.pathname}: ${error.message}`);
      if (process.env.DEBUG) console.error(error.stack);
      if (!res.headersSent) sendJson(res, 500, { error: 'erro interno' });
      else if (!res.writableEnded) res.end();
    }
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.greenlight = { root, env, history, sessionMemory, scenarios };
  return server;
}

function start() {
  const envResult = loadEnv(process.cwd());
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    const app = appStatus(process.env);
    const llm = describeLlm(loadConfig(process.cwd()).config);
    console.log('');
    console.log('  greenlight · revisão de PR com agente de código');
    console.log(`  ▸ http://localhost:${port}`);
    console.log(`  ▸ LLM: ${llm.enabled ? `${llm.provider} (${llm.model})` : `off — ${llm.reason}`}`);
    if (envResult.loaded) console.log(`  ▸ .env: ${envResult.count} variável(is) carregada(s)`);
    console.log(`  ▸ GitHub App: ${app.configured ? 'configurado' : 'não configurado (veja .env.example)'}`);
    console.log('');
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} recebido, encerrando…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (require.main === module) start();

module.exports = { createServer, start, loadScenarios, ROOT };
