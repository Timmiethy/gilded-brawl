// Unified API handler with per-IP rate limiting, payload caps, and input validation
import { joinPlayer, leavePlayer, handleTick, stepEngine, buildSnapshot } from '../game/engine.js';

const MAX_BODY_BYTES = 4096; // 4 KB strict limit to prevent memory abuse
const RATE_LIMITS = {
  tick: { max: 55, windowMs: 1000 }, // Supports multiple tabs on same IP + instant action sends
  join: { max: 10, windowMs: 10_000 },
  switch: { max: 10, windowMs: 10_000 },
  status: { max: 30, windowMs: 1000 },
  leave: { max: 12, windowMs: 10_000 },
};

function getRateLimiter() {
  if (!globalThis.__GILDED_BRAWL_RL__) {
    globalThis.__GILDED_BRAWL_RL__ = { buckets: new Map(), lastSweep: Date.now() };
  }
  return globalThis.__GILDED_BRAWL_RL__;
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim().slice(0, 64);
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.length > 0) {
    return realIp.trim().slice(0, 64);
  }
  return (req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

function checkRateLimit(ip, action) {
  const rule = RATE_LIMITS[action] || RATE_LIMITS.status;
  const rl = getRateLimiter();
  const now = Date.now();

  // Periodic cleanup to keep RAM bounded
  if (now - rl.lastSweep > 30_000 || rl.buckets.size > 5000) {
    rl.lastSweep = now;
    for (const [k, b] of rl.buckets.entries()) {
      if (now >= b.resetAt) rl.buckets.delete(k);
    }
  }

  const key = `${ip}:${action}`;
  let bucket = rl.buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + rule.windowMs };
    rl.buckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= rule.max,
    retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return { ok: true, data: req.body };
  if (typeof req.body === 'string') {
    if (req.body.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: 'Payload too large' };
    try {
      const parsed = JSON.parse(req.body);
      return parsed && typeof parsed === 'object' ? { ok: true, data: parsed } : { ok: false, status: 400, error: 'Invalid JSON object' };
    } catch {
      return { ok: false, status: 400, error: 'Invalid JSON' };
    }
  }

  return new Promise((resolve) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooLarge = true;
        resolve({ ok: false, status: 413, error: 'Payload too large' });
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!raw) return resolve({ ok: true, data: {} });
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return resolve({ ok: false, status: 400, error: 'Expected JSON object' });
        }
        resolve({ ok: true, data: parsed });
      } catch {
        resolve({ ok: false, status: 400, error: 'Invalid JSON' });
      }
    });
    req.on('error', () => resolve({ ok: false, status: 400, error: 'Read error' }));
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

function isValidClientId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{3,48}$/.test(id);
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/api/status', 'http://localhost');
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '') || 'status';
  const ip = getClientIp(req);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const rl = checkRateLimit(ip, path);
  if (!rl.allowed) {
    return sendJson(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(rl.retryAfterSec) });
  }

  try {
    if (req.method === 'POST' && (path === 'join' || path === 'switch')) {
      const parsed = await readBody(req);
      if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
      if (parsed.data.clientId && !isValidClientId(parsed.data.clientId)) {
        return sendJson(res, 400, { error: 'Invalid clientId' });
      }
      const result = joinPlayer({ ...parsed.data, ip });
      if (result.error) return sendJson(res, result.status || 429, { error: result.error });
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && path === 'tick') {
      const parsed = await readBody(req);
      if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
      if (!isValidClientId(parsed.data.clientId)) {
        return sendJson(res, 400, { error: 'Invalid clientId' });
      }
      const snap = handleTick(parsed.data);
      return sendJson(res, 200, snap);
    }

    if (req.method === 'POST' && path === 'leave') {
      const parsed = await readBody(req);
      if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
      if (parsed.data.clientId && !isValidClientId(parsed.data.clientId)) {
        return sendJson(res, 400, { error: 'Invalid clientId' });
      }
      return sendJson(res, 200, leavePlayer(parsed.data.clientId));
    }

    if (req.method === 'GET' && (path === 'status' || path === 'state')) {
      const state = stepEngine(Date.now());
      const selfId = url.searchParams.get('clientId') || '';
      const since = Number(url.searchParams.get('since') || 0);
      return sendJson(res, 200, buildSnapshot(state, isValidClientId(selfId) ? selfId : '', Number.isFinite(since) ? since : 0));
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('API error:', err);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
}
