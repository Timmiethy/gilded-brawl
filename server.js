// The game server: one long-running Node process that owns the world. It serves the static client,
// routes /api/* to the shared handler, and steps the simulation at 30 Hz. Run exactly one instance:
// every player must reach the same process, or they end up in different worlds.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import apiHandler from './api/game.js';
import { stepEngine } from './game/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg']);

// vercel.json is the single source of truth for response headers (CSP etc.); apply the same rules here.
// Its sources only use the "(.*)" wildcard, which maps directly onto a regex.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HEADER_RULES = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8')).headers.map((rule) => ({
  pattern: new RegExp(`^${rule.source.split('(.*)').map(escapeRegex).join('.*')}$`),
  headers: rule.headers,
}));

function applyHeaderRules(urlPath, res) {
  for (const rule of HEADER_RULES) {
    if (rule.pattern.test(urlPath)) {
      for (const { key, value } of rule.headers) res.setHeader(key, value);
    }
  }
}

function isInsidePublic(filePath) {
  return filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
}

// Static files are read and compressed once, then served from memory.
// Receipt: all of public/ is ≈2.4 MB raw (≈0.5 MB compressed) — the cache is bounded by the folder itself.
// The mtime check picks up edited files without a restart (local development).
const fileCache = new Map();
function loadStatic(filePath) {
  const { mtimeMs } = fs.statSync(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const raw = fs.readFileSync(filePath);
  const ext = path.extname(filePath);
  const entry = {
    mtimeMs,
    type: MIME[ext] || 'application/octet-stream',
    etag: `"${crypto.createHash('sha1').update(raw).digest('base64url')}"`,
    raw,
    br: COMPRESSIBLE.has(ext) ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : null,
    gzip: COMPRESSIBLE.has(ext) ? zlib.gzipSync(raw, { level: 9 }) : null,
  };
  fileCache.set(filePath, entry);
  return entry;
}

function serveStatic(req, res, urlPath) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!isInsidePublic(filePath)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = INDEX_FILE;

  let file;
  try {
    file = loadStatic(filePath);
  } catch {
    res.statusCode = 500;
    return res.end();
  }
  res.setHeader('Content-Type', file.type);
  res.setHeader('ETag', file.etag);
  // Paths carry no content hash, so browsers must revalidate (a cheap 304) to never run stale code
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === file.etag) {
    res.statusCode = 304;
    return res.end();
  }
  const accept = String(req.headers['accept-encoding'] || '');
  let body = file.raw;
  if (file.br && /\bbr\b/.test(accept)) {
    body = file.br;
    res.setHeader('Content-Encoding', 'br');
  } else if (file.gzip && /\bgzip\b/.test(accept)) {
    body = file.gzip;
    res.setHeader('Content-Encoding', 'gzip');
  }
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Keep simulation ticking smoothly at 30 Hz
setInterval(() => stepEngine(Date.now()), 33);

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  applyHeaderRules(urlPath, res);
  if (urlPath.startsWith('/api/')) return apiHandler(req, res);
  return serveStatic(req, res, urlPath);
});

server.listen(PORT, () => {
  console.log(`Gilded Brawl server running at http://localhost:${PORT}`);
});
