'use strict';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  // A prévia roda dentro de um iframe do Arena (e2b.app); o CSP precisa permitir.
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'self' https://*.e2b.app",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendRedirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

class BodyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new BodyError(`Corpo maior que o limite de ${limitBytes} bytes.`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req, limitBytes) {
  return readBody(req, limitBytes).then((buffer) => {
    if (buffer.length === 0) return {};
    try {
      const parsed = JSON.parse(buffer.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON precisa ser um objeto.');
      }
      return parsed;
    } catch (error) {
      throw new BodyError(`JSON inválido: ${error.message}`, 400);
    }
  });
}

/** Janela deslizante simples por IP; suficiente para um servidor single-process. */
function createRateLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    const timestamps = (hits.get(key) || []).filter((time) => now - time < windowMs);
    if (timestamps.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - timestamps[0])) / 1000);
      hits.set(key, timestamps);
      return { allowed: false, retryAfter };
    }
    timestamps.push(now);
    hits.set(key, timestamps);
    if (hits.size > 5000) {
      for (const [entry, list] of hits) {
        if (list.every((time) => now - time > windowMs)) hits.delete(entry);
      }
    }
    return { allowed: true };
  };
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'desconhecido';
}

function sseStart(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': greenlight\n\n');
}

function sseSend(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseEnd(res) {
  if (!res.writableEnded) res.end();
}

module.exports = {
  SECURITY_HEADERS,
  applySecurityHeaders,
  sendJson,
  sendText,
  sendRedirect,
  readBody,
  readJson,
  BodyError,
  createRateLimiter,
  clientIp,
  sseStart,
  sseSend,
  sseEnd,
};
