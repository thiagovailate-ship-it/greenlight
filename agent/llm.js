'use strict';

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  ollama: 'qwen2.5-coder:7b',
};

const REDACTIONS = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END [^-]*-----/g, '[REDIGIDO:chave-privada]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, '[REDIGIDO:github-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDIGIDO:aws-key]'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDIGIDO:slack-token]'],
  [/\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g, '[REDIGIDO:stripe-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDIGIDO:google-key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDIGIDO:jwt]'],
  [
    /((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret)\s*[:=]\s*['"`])([^'"`\n]{8,})(['"`])/gi,
    (match, prefix, secretValue, suffix) => `${prefix}[REDIGIDO]${suffix}`,
  ],
];

const CATEGORIES = new Set(['security', 'bug', 'quality', 'tests']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

function resolveLlm(config = {}, env = process.env) {
  const explicit = String(env.GREENLIGHT_LLM || '').trim().toLowerCase();
  const configEnabled = !config.llm || config.llm.enabled !== false;
  let provider = explicit;

  if (provider && !['openai', 'anthropic', 'ollama', 'off'].includes(provider)) {
    provider = 'off';
  }

  if (!provider) {
    if (env.ANTHROPIC_API_KEY) provider = 'anthropic';
    else if (env.OPENAI_API_KEY) provider = 'openai';
    else if (env.OLLAMA_HOST) provider = 'ollama';
    else provider = 'off';
  }

  const info = {
    enabled: configEnabled && provider !== 'off',
    provider: provider === 'off' ? 'off' : provider,
    model: '',
    baseUrl: '',
    timeoutMs: Math.min(Math.max(Number(env.GREENLIGHT_LLM_TIMEOUT_MS) || 25000, 1000), 120000),
    maxFindings: 8,
    reason: '',
    apiKey: '',
  };

  if (!configEnabled) {
    info.enabled = false;
    info.reason = 'desligado pela configuração do repositório';
    return info;
  }

  if (provider === 'openai') {
    info.apiKey = env.OPENAI_API_KEY || '';
    info.model = env.OPENAI_MODEL || DEFAULT_MODELS.openai;
    info.baseUrl = String(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    if (!info.apiKey) {
      info.enabled = false;
      info.reason = 'OPENAI_API_KEY ausente';
    }
  } else if (provider === 'anthropic') {
    info.apiKey = env.ANTHROPIC_API_KEY || '';
    info.model = env.ANTHROPIC_MODEL || DEFAULT_MODELS.anthropic;
    info.baseUrl = 'https://api.anthropic.com/v1';
    if (!info.apiKey) {
      info.enabled = false;
      info.reason = 'ANTHROPIC_API_KEY ausente';
    }
  } else if (provider === 'ollama') {
    info.model = env.OLLAMA_MODEL || DEFAULT_MODELS.ollama;
    info.baseUrl = String(env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  } else {
    info.enabled = false;
    info.provider = 'off';
    info.reason = 'nenhum provedor configurado';
  }

  return info;
}

function publicLlmInfo(info) {
  return {
    enabled: Boolean(info.enabled),
    provider: info.provider,
    model: info.enabled ? info.model : null,
    reason: info.reason || null,
  };
}

function redactSecrets(text) {
  let output = String(text || '');
  let count = 0;
  for (const [pattern, replacement] of REDACTIONS) {
    output = output.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  }
  return { text: output, count };
}

function allowedLineList(files, perFile = 40) {
  return files
    .filter((file) => !file.binary)
    .map((file) => {
      const lines = file.hunks
        .flatMap((hunk) => hunk.lines)
        .filter((line) => line.type === 'add' && line.newLine)
        .map((line) => line.newLine);
      const shown = lines.slice(0, perFile);
      const extra = lines.length > perFile ? ` … +${lines.length - perFile}` : '';
      return `${file.path}: ${shown.join(', ') || 'sem linhas adicionadas'}${extra}`;
    })
    .join('\n');
}

function clipDiff(diff, budget = 26000) {
  if (diff.length <= budget) return { text: diff, truncated: false };
  const chunks = diff.split(/(?=^diff --git )/m);
  let output = '';
  for (const chunk of chunks) {
    if (output.length + chunk.length > budget) break;
    output += chunk;
  }
  if (!output) output = diff.slice(0, budget);
  return { text: `${output}\n\n[... diff truncado em ${budget} caracteres ...]`, truncated: true };
}

function buildMessages({ diff, files, findings, context, config, redactions }) {
  const deterministic = findings.length
    ? findings
        .slice(0, 25)
        .map(
          (finding) =>
            `- ${finding.ruleId} ${finding.file}:${finding.line} [${finding.severity}] ${finding.title}: ` +
            `${finding.message}`,
        )
        .join('\n')
    : '- nenhum';

  const learned = context.learned
    ? `Projeto: ${context.project || 'não informado'}
Linguagens no diff: ${context.languages.map((item) => item.language).join(', ') || 'não detectadas'}
Framework de teste: ${context.testFramework || 'não detectado'}
Convenções: ${context.conventions ? JSON.stringify(context.conventions) : 'não aprendidas'}`
    : 'Sem índice do repositório. Use apenas o diff.';

  const system =
    'Você é o Greenlight, revisor de código sênior. Analise APENAS as linhas adicionadas de um pull request. ' +
    'Procure bugs de lógica, falhas de segurança, riscos de concorrência, erros de borda e lacunas de teste. ' +
    'Não elogie, não repita os achados determinísticos listados e não invente arquivos ou linhas. ' +
    'Se não houver nada relevante, retorne findings vazio. ' +
    'Responda SOMENTE com JSON válido, sem markdown, neste formato: ' +
    '{"summary":"2 frases em português sobre o PR",' +
    '"findings":[{"file":"caminho/exato.ts","line":12,"severity":"critical|high|medium|low|info",' +
    '"category":"security|bug|quality|tests","title":"curto","message":"o que está errado e o impacto",' +
    '"why":"por que importa","confidence":0.0,"suggestion":{"title":"...","language":"...","code":"..."}}]}. ' +
    'No máximo 8 findings. Prefira poucos achados de alta confiança a muitos duvidosos. ' +
    'O diff pode conter segredos já mascarados como [REDIGIDO]; não tente reconstruí-los.';

  const user =
    `Repositório: ${context.project || 'desconhecido'}\n\n` +
    `Contexto aprendido:\n${learned}\n\n` +
    `Configuração: failOn=${config.failOn}, maxLineLength=${config.rules.maxLineLength}, ` +
    `testes obrigatórios=${config.tests.requireChangedTests ? 'sim' : 'não'}\n\n` +
    `Achados determinísticos já reportados (NÃO repita):\n${deterministic}\n\n` +
    `Linhas adicionadas por arquivo:\n${allowedLineList(files)}\n\n` +
    (redactions > 0 ? `O diff teve ${redactions} segredo(s) redigido(s) antes de sair da máquina.\n\n` : '') +
    `Diff:\n\`\`\`diff\n${diff}\n\`\`\``;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('resposta do modelo não é JSON válido');
  }
}

async function callProvider(info, messages, fetchImpl) {
  const headers = { 'content-type': 'application/json' };
  let url;
  let body;

  if (info.provider === 'openai') {
    url = `${info.baseUrl}/chat/completions`;
    headers.authorization = `Bearer ${info.apiKey}`;
    body = {
      model: info.model,
      messages,
      temperature: 0.1,
      max_tokens: 2200,
    };
  } else if (info.provider === 'anthropic') {
    url = `${info.baseUrl}/messages`;
    headers['x-api-key'] = info.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: info.model,
      system: messages.find((message) => message.role === 'system').content,
      messages: messages.filter((message) => message.role !== 'system'),
      max_tokens: 2200,
      temperature: 0.1,
    };
  } else {
    url = `${info.baseUrl}/api/chat`;
    body = {
      model: info.model,
      messages,
      stream: false,
      format: 'json',
      options: { temperature: 0.1 },
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), info.timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') throw new Error(`timeout de ${info.timeoutMs}ms`);
      throw new Error(`falha de rede: ${error.message}`);
    }
    clearTimeout(timer);

    if (!response.ok) {
      const rawDetail = (await response.text()).replace(/\s+/g, ' ').slice(0, 240);
      const detail = redactSecrets(rawDetail).text;
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        const backoff = 400 * 2 ** attempt + Math.random() * 200;
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }

    const data = await response.json();
    if (info.provider === 'openai') {
      return data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
    }
    if (info.provider === 'anthropic') {
      return (data.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    }
    return data.message?.content || '';
  }
  throw new Error('falha após nova tentativa');
}

function nearestLine(lines, target) {
  if (lines.size === 0) return null;
  if (lines.has(target)) return target;
  let best = null;
  let distance = Infinity;
  for (const line of lines) {
    const delta = Math.abs(line - target);
    if (delta < distance) {
      distance = delta;
      best = line;
    }
  }
  return distance <= 3 ? best : null;
}

function normalizeFindings(rawFindings, { files, deterministic, maxFindings }) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const allowed = new Map();
  for (const file of files) {
    allowed.set(
      file.path,
      new Set(
        file.hunks
          .flatMap((hunk) => hunk.lines)
          .filter((line) => line.type === 'add' && line.newLine)
          .map((line) => line.newLine),
      ),
    );
  }

  const found = [];
  const seen = new Set();
  for (const item of Array.isArray(rawFindings) ? rawFindings : []) {
    if (!item || typeof item !== 'object') continue;
    let filePath = String(item.file || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!byPath.has(filePath)) {
      const suffix = [...byPath.keys()].find((path) => path.endsWith(`/${filePath}`) || filePath.endsWith(`/${path}`));
      if (!suffix) continue;
      filePath = suffix;
    }
    const line = nearestLine(allowed.get(filePath), Number(item.line));
    if (!line) continue;
    if (!SEVERITIES.has(item.severity) || !CATEGORIES.has(item.category)) continue;
    const title = String(item.title || '').trim().slice(0, 90);
    const message = String(item.message || '').trim().slice(0, 600);
    if (!title || !message) continue;
    const key = `${filePath}:${line}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const duplicate = deterministic.some(
      (finding) =>
        finding.file === filePath &&
        Math.abs((finding.line || 0) - line) <= 1 &&
        finding.category === item.category,
    );
    if (duplicate) continue;

    let suggestion = null;
    if (item.suggestion && typeof item.suggestion === 'object' && typeof item.suggestion.code === 'string') {
      suggestion = {
        title: String(item.suggestion.title || 'Correção sugerida').slice(0, 90),
        language: String(item.suggestion.language || 'text').slice(0, 20),
        code: item.suggestion.code.slice(0, 4000),
        mode: 'info',
        applyable: false,
      };
    }

    found.push({
      file: filePath,
      line,
      endLine: line,
      severity: item.severity,
      category: item.category,
      title,
      message,
      why: String(item.why || '').slice(0, 400),
      code: '',
      confidence: Math.min(Math.max(Number(item.confidence) || 0.7, 0.4), 0.9),
      source: 'llm',
      ruleId: 'LLM',
      suggestion,
    });
    if (found.length >= maxFindings) break;
  }
  return found;
}

/**
 * Executa a camada opcional de LLM. Nunca lança: a revisão determinística
 * continua válida mesmo sem rede, sem chave ou com resposta inválida.
 */
async function runLlmReview(options) {
  const {
    diff,
    files,
    findings = [],
    context = {},
    config = {},
    env = process.env,
    fetchImpl = globalThis.fetch,
    logger = null,
  } = options;

  const info = resolveLlm(config, env);
  if (!info.enabled) {
    return { status: 'disabled', ...publicLlmInfo(info), findings: [], summary: '', durationMs: 0 };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      status: 'failed',
      ...publicLlmInfo(info),
      findings: [],
      summary: '',
      error: 'fetch indisponível neste runtime',
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  try {
    const redacted = redactSecrets(diff);
    const clipped = clipDiff(redacted.text);
    const messages = buildMessages({
      diff: clipped.text,
      files,
      findings,
      context,
      config,
      redactions: redacted.count,
    });
    const content = await callProvider(info, messages, fetchImpl);
    const parsed = extractJson(content);
    const llmFindings = normalizeFindings(parsed.findings, {
      files,
      deterministic: findings,
      maxFindings: info.maxFindings,
    });
    const summary = String(parsed.summary || '').replace(/\s+/g, ' ').trim().slice(0, 800);
    return {
      status: 'ok',
      ...publicLlmInfo(info),
      findings: llmFindings,
      summary,
      durationMs: Date.now() - startedAt,
      redactions: redacted.count,
      diffTruncated: clipped.truncated,
    };
  } catch (error) {
    if (logger) logger(`LLM falhou: ${error.message}`);
    return {
      status: 'failed',
      ...publicLlmInfo(info),
      findings: [],
      summary: '',
      error: String(error.message || 'erro desconhecido').slice(0, 300),
      durationMs: Date.now() - startedAt,
    };
  }
}

function describeLlm(config, env = process.env) {
  return publicLlmInfo(resolveLlm(config, env));
}

module.exports = {
  resolveLlm,
  describeLlm,
  publicLlmInfo,
  redactSecrets,
  buildMessages,
  runLlmReview,
  normalizeFindings,
  extractJson,
  clipDiff,
  DEFAULT_MODELS,
};
