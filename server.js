// Local development & standalone Node server (shares exact same RAM engine & API handler as Vercel)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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

// Keep simulation ticking smoothly at 30 Hz locally
setInterval(() => stepEngine(Date.now()), 33);

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  applyHeaderRules(urlPath, res);

  if (urlPath.startsWith('/api/')) {
    return apiHandler(req, res);
  }

  let filePath = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!isInsidePublic(filePath)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = INDEX_FILE;
  }

  const ext = path.extname(filePath);
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  fs.createReadStream(filePath)
    .on('error', () => {
      // An unreadable file must fail this one response, not crash the whole server
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    })
    .pipe(res);
});

server.listen(PORT, () => {
  console.log(`Gilded Brawl server running at http://localhost:${PORT}`);
});
