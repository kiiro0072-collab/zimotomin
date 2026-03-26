const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '8001';
const ROOT = path.join(__dirname, 'App');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
  // /app2/ プレフィックスを除去してファイルパスに変換
  let urlPath = req.url.split('?')[0].replace(/^\/app2/, '') || '/';
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);

  // ディレクトリトラバーサル防止
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`Server2 (homepage) running on port ${port}`);
});
