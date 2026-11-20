// Unified API handler for both Vercel Node.js Serverless Function and local Node server
import { joinPlayer, leavePlayer, handleTick, stepEngine, buildSnapshot } from '../game/engine.js';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/api/status', 'http://localhost');
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (req.method === 'POST' && (path === 'join' || path === 'switch')) {
      const body = await readBody(req);
      const snap = joinPlayer(body);
      return sendJson(res, 200, snap);
    }

    if (req.method === 'POST' && path === 'tick') {
      const body = await readBody(req);
      const snap = handleTick(body);
      return sendJson(res, 200, snap);
    }

    if (req.method === 'POST' && path === 'leave') {
      const body = await readBody(req);
      return sendJson(res, 200, leavePlayer(body.clientId));
    }

    if (req.method === 'GET' && (path === '' || path === 'status' || path === 'state')) {
      const state = stepEngine(Date.now());
      const selfId = url.searchParams.get('clientId') || '';
      const since = Number(url.searchParams.get('since') || 0);
      return sendJson(res, 200, buildSnapshot(state, selfId, since));
    }

    return sendJson(res, 404, { error: 'Not found', path });
  } catch (err) {
    console.error('API error:', err);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
}
