// Unified API handler with per-IP rate limiting, payload caps, and input validation
import { joinPlayer, leavePlayer, handleTick, stepEngine, buildSnapshot } from '../game/engine.js';

const MAX_BODY_BYTES = 4096; // 4 KB strict limit to prevent memory abuse

// Receipts: one tab polls every 70ms (14.3/s) and fires one extra tick per cast (≤ ~4/s with a held
// basic attack + skills) ≈ 18/s; the engine allows 4 players per IP → 72/s. Cap at 120 as a tripwire.
// Status is polled at 14.3/s by every tab that sits on the hero dialog; 60/s covers 4 such tabs.
const RATE_LIMITS = {
  tick: { max: 120, windowMs: 1000 },
  join: { max: 10, windowMs: 10_000 },
  status: { max: 60, windowMs: 1000 },
  leave: { max: 12, windowMs: 10_000 },
  other: { max: 30, windowMs: 1000 },
};

// Number of trusted reverse proxies in front of this server (the Express "trust proxy" model).
// Each proxy appends the address it received from to X-Forwarded-For, so the real client is the
// entry added by the outermost trusted proxy: the TRUST_PROXY_HOPS-th entry from the right.
// Everything to the left of it is client-controlled. 0 (a bare `node server.js`) = socket address only.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? (process.env.VERCEL ? 1 : 0));
let warnedShortForwardedFor = false;

function getRateLimiter() {
  if (!globalThis.__GILDED_BRAWL_RL__) {
    globalThis.__GILDED_BRAWL_RL__ = { buckets: new Map(), lastSweep: Date.now() };
  }
  return globalThis.__GILDED_BRAWL_RL__;
}

// One IPv6 subscriber usually owns a whole /64, so per-IP limits must count the /64, not the address.
function ipv6Prefix64(addr) {
  const [head, tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups
    .slice(0, 4)
    .map((g) => (g || '0').toLowerCase())
    .join(':')}::/64`;
}

function normalizeIp(raw) {
  let ip = String(raw || '').trim().slice(0, 64);
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7); // IPv4-mapped IPv6
  return ip.includes(':') ? ipv6Prefix64(ip) : ip;
}

function getClientIp(req) {
  if (TRUST_PROXY_HOPS > 0) {
    const xff = req.headers['x-forwarded-for'];
    const hops = typeof xff === 'string' ? xff.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (hops.length >= TRUST_PROXY_HOPS) return normalizeIp(hops[hops.length - TRUST_PROXY_HOPS]);
    if (!warnedShortForwardedFor) {
      // Falling back to the socket address puts every player behind one proxy IP (shared limits)
      warnedShortForwardedFor = true;
      console.warn(
        `[api] TRUST_PROXY_HOPS=${TRUST_PROXY_HOPS} but X-Forwarded-For has ${hops.length} entries; ` +
          'using the socket address. Lower TRUST_PROXY_HOPS to the real number of proxies.'
      );
    }
  }
  return normalizeIp(req.socket?.remoteAddress);
}

function checkRateLimit(ip, action) {
  const rule = RATE_LIMITS[action];
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
    limit: rule.max,
    windowMs: rule.windowMs,
    retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function parseJsonObject(raw) {
  if (!raw) return { ok: true, data: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'Expected JSON object' };
    }
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON' };
  }
}

const TOO_LARGE = { ok: false, status: 413, error: `Payload too large (max_body_bytes=${MAX_BODY_BYTES})` };

async function readBody(req) {
  // Reject by declared size before any platform body parsing result is trusted
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return TOO_LARGE;

  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) return TOO_LARGE;
      return parseJsonObject(req.body);
    }
    if (typeof req.body === 'object' && !Array.isArray(req.body) && !Buffer.isBuffer(req.body)) {
      return { ok: true, data: req.body };
    }
    return { ok: false, status: 400, error: 'Expected JSON object' };
  }

  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        finish(TOO_LARGE);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(parseJsonObject(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', () => finish({ ok: false, status: 400, error: 'Read error' }));
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

// The session key is a secret bearer credential (a crypto.randomUUID() from the client)
function isValidSession(s) {
  return typeof s === 'string' && /^[a-zA-Z0-9_-]{20,64}$/.test(s);
}

const ROUTES = {
  join: 'POST',
  tick: 'POST',
  leave: 'POST',
  status: 'GET',
};

export default async function handler(req, res) {
  const url = new URL(req.url || '/api/status', 'http://localhost');
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '') || 'status';
  const ip = getClientIp(req);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Unknown paths share one bucket, so varying the path cannot mint fresh rate-limit buckets
  const action = Object.hasOwn(ROUTES, path) ? path : 'other';
  const rl = checkRateLimit(ip, action);
  if (!rl.allowed) {
    return sendJson(
      res,
      429,
      { error: `Too many requests (${action}: max ${rl.limit} per ${rl.windowMs}ms per IP)` },
      { 'Retry-After': String(rl.retryAfterSec) }
    );
  }

  if (action === 'other') return sendJson(res, 404, { error: 'Not found' });
  if (req.method !== ROUTES[action]) {
    return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: ROUTES[action] });
  }

  try {
    if (action === 'status') {
      const state = stepEngine(Date.now());
      const since = Number(url.searchParams.get('since') || 0);
      return sendJson(res, 200, buildSnapshot(state, '', Number.isFinite(since) ? since : 0));
    }

    const parsed = await readBody(req);
    if (!parsed.ok) {
      // Close the socket so a client cannot keep streaming an oversized body into this connection
      return sendJson(res, parsed.status, { error: parsed.error }, { Connection: 'close' });
    }
    if (!isValidSession(parsed.data.session)) {
      return sendJson(res, 400, { error: 'Invalid session' });
    }

    if (action === 'join') {
      const { session, name, charId } = parsed.data;
      const result = joinPlayer({ session, name, charId, ip });
      if (result.error) return sendJson(res, result.status || 429, { error: result.error });
      return sendJson(res, 200, result);
    }
    if (action === 'tick') return sendJson(res, 200, handleTick(parsed.data));
    return sendJson(res, 200, leavePlayer(parsed.data.session));
  } catch (err) {
    console.error('API error:', err);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
}
