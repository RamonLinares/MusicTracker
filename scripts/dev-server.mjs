/* Minimal static dev server with caching disabled, so edits always show up
 * on reload (python http.server lets browsers cache heuristically).
 * Usage: node scripts/dev-server.mjs [port]   (default 8642) */
'use strict';

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = parseInt(process.argv[2], 10) || 8642;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.mod': 'application/octet-stream', '.wav': 'audio/wav'
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.normalize(path.join(root, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const headers = {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  };
  // evict anything an earlier (caching) server left in the browser cache
  if (urlPath === '/' || urlPath.endsWith('.html')) headers['Clear-Site-Data'] = '"cache"';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`WebTracker dev server: http://localhost:${port}/ (caching disabled)`);
});
