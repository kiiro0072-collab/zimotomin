const { execSync, fork } = require('child_process');
const path = require('path');

// 依存パッケージの自動インストール
try {
  require.resolve('sql.js');
} catch {
  console.log('Installing dependencies...');
  execSync('npm install sql.js', { cwd: __dirname, stdio: 'inherit' });
}

// server2.js を子プロセスとして起動（内部ポート8001）
const SERVER2_PORT = 8001;
const server2 = fork(path.join(__dirname, 'server2.js'), [`--port=${SERVER2_PORT}`]);
server2.on('exit', code => console.log(`Server2 exited with code ${code}`));

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const port = process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '8000';
const DB_PATH = path.join(__dirname, 'points.db');
const ADMIN_USERS = new Set(['MATAKU01']);
const SESSION_DAYS = 30;

// ===== DB =====
let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`PRAGMA foreign_keys = ON`);
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opinions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (point_id) REFERENCES points(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      viewed_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (point_id) REFERENCES points(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS banned_users (
      user_id INTEGER PRIMARY KEY,
      banned_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS likes (
      point_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (point_id, user_id),
      FOREIGN KEY (point_id) REFERENCES points(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS route_opinions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS travel_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_opinions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (plan_id) REFERENCES travel_plans(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS feedbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // マイグレーション：古いDBに不足カラム・テーブルを追加
  const migrations = [
    // opinions に id がない古いDBへの対応（再作成）
    `CREATE TABLE IF NOT EXISTS opinions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (point_id) REFERENCES points(id) ON DELETE CASCADE
    )`,
  ];
  // opinionsテーブルにidカラムがあるか確認
  try {
    db.run('SELECT id FROM opinions LIMIT 1');
  } catch {
    // idカラムがない → データを移行して再作成
    try {
      db.run(migrations[0]);
      db.run(`INSERT INTO opinions_new (point_id, user_id, text, created_at)
              SELECT point_id, user_id, text, created_at FROM opinions`);
      db.run('DROP TABLE opinions');
      db.run('ALTER TABLE opinions_new RENAME TO opinions');
      console.log('Migration: opinions table rebuilt with id column');
    } catch(e) { console.error('Migration error:', e.message); }
  }
  // feedbacks に score カラムがない古いDBへの対応
  try {
    db.run('SELECT score FROM feedbacks LIMIT 1');
  } catch {
    try {
      db.run('ALTER TABLE feedbacks ADD COLUMN score INTEGER DEFAULT 0');
      console.log('Migration: feedbacks.score column added');
    } catch(e) { console.error('Migration error:', e.message); }
  }
  // views テーブルが存在しない、またはviewed_atカラムがない古いDBへの対応
  try {
    db.run('SELECT viewed_at FROM views LIMIT 1');
  } catch {
    try {
      // テーブル自体が存在するか確認
      const tableExists = dbGet(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='views'`
      );
      if (tableExists) {
        // テーブルはあるがviewed_atカラムがない → カラム追加
        db.run(`ALTER TABLE views ADD COLUMN viewed_at TEXT DEFAULT (datetime('now','localtime'))`);
        console.log('Migration: views.viewed_at column added');
      } else {
        db.run(`CREATE TABLE views (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          point_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          viewed_at TEXT DEFAULT (datetime('now','localtime')),
          FOREIGN KEY (point_id) REFERENCES points(id) ON DELETE CASCADE
        )`);
        console.log('Migration: views table created');
      }
    } catch(e) { console.error('Migration error:', e.message); }
  }

  saveDb();
}

function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ===== ユーティリティ =====
const hashPw = pw => crypto.createHash('sha256').update(pw).digest('hex');

function getUser(token) {
  if (!token) return null;
  const cutoff = new Date(Date.now() - SESSION_DAYS * 86400000).toISOString();
  return dbGet(
    `SELECT u.id, u.username FROM sessions s
     JOIN users u ON s.user_id=u.id
     WHERE s.token=? AND s.created_at > ?`,
    [token, cutoff]
  );
}

function isAdmin(user) {
  return user && ADMIN_USERS.has(user.username);
}

function getToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  });
  res.end(JSON.stringify(body));
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ===== ルーター =====
async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

  // /app2/ 以下はserver2にプロキシ
  if (req.url.startsWith('/app2')) {
    const options = {
      hostname: '127.0.0.1',
      port: SERVER2_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    };
    const proxy = http.request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxy.on('error', () => { res.writeHead(502); res.end('Server2 unavailable'); });
    req.pipe(proxy);
    return;
  }

  const url = req.url.split('?')[0];
  const token = getToken(req);
  const user = getUser(token);

  // POST /api/register
  if (req.method === 'POST' && url === '/api/register') {
    const body = await readBody(req);
    if (!body.username || body.username.length < 2 || !body.password || body.password.length < 4)
      return send(res, 400, { detail: 'ユーザー名は2文字以上、パスワードは4文字以上' });
    try {
      dbRun('INSERT INTO users (username, password) VALUES (?, ?)', [body.username, hashPw(body.password)]);
      return send(res, 200, { ok: true });
    } catch { return send(res, 409, { detail: 'そのユーザー名は使われています' }); }
  }

  // POST /api/login
  if (req.method === 'POST' && url === '/api/login') {
    const body = await readBody(req);
    const row = dbGet('SELECT id FROM users WHERE username=? AND password=?', [body.username, hashPw(body.password)]);
    if (!row) return send(res, 401, { detail: 'ユーザー名またはパスワードが違います' });
    if (dbGet('SELECT 1 FROM banned_users WHERE user_id=?', [row.id]))
      return send(res, 403, { detail: 'このアカウントはBANされています' });
    const tok = crypto.randomBytes(32).toString('hex');
    dbRun('INSERT INTO sessions (token, user_id) VALUES (?, ?)', [tok, row.id]);
    return send(res, 200, { token: tok, username: body.username });
  }

  // POST /api/logout
  if (req.method === 'POST' && url === '/api/logout') {
    if (token) dbRun('DELETE FROM sessions WHERE token=?', [token]);
    return send(res, 200, { ok: true });
  }

  // GET /api/me
  if (req.method === 'GET' && url === '/api/me') {
    if (!user) return send(res, 200, { user: null });
    return send(res, 200, { user: { ...user, is_admin: isAdmin(user) } });
  }

  // GET /api/points/version（軽量ポーリング用：件数+最新IDのハッシュ）
  if (req.method === 'GET' && url === '/api/points/version') {
    try {
      const r = dbGet('SELECT COUNT(*) as cnt, MAX(id) as maxid FROM points');
      const o = dbGet('SELECT MAX(id) as maxid FROM opinions');
      const l = dbGet('SELECT COUNT(*) as cnt FROM likes');
      const v = dbGet('SELECT MAX(id) as maxid FROM views');
      return send(res, 200, { v: `${r.cnt}-${r.maxid}-${o.maxid}-${l.cnt}-${v.maxid}` });
    } catch {
      const r = dbGet('SELECT COUNT(*) as cnt FROM points');
      return send(res, 200, { v: `${r.cnt}` });
    }
  }

  // GET /api/points
  if (req.method === 'GET' && url === '/api/points') {
    const rows = dbAll('SELECT p.id, p.user_id, p.data, u.username FROM points p JOIN users u ON p.user_id=u.id');
    const ops = dbAll('SELECT o.id, o.point_id, o.text, o.created_at, u.username, o.user_id FROM opinions o JOIN users u ON o.user_id=u.id');
    const viewRows = dbAll('SELECT point_id, COUNT(*) as cnt FROM views GROUP BY point_id');
    const likeRows = dbAll('SELECT point_id, COUNT(*) as cnt FROM likes GROUP BY point_id');
    const myLikes = new Set(user ? dbAll('SELECT point_id FROM likes WHERE user_id=?', [user.id]).map(r => r.point_id) : []);

    const opMap = {};
    for (const o of ops) {
      if (!opMap[o.point_id]) opMap[o.point_id] = [];
      opMap[o.point_id].push({ id: o.id, text: o.text, username: o.username, created_at: o.created_at, user_id: o.user_id });
    }
    const viewMap = Object.fromEntries(viewRows.map(r => [r.point_id, r.cnt]));
    const likeMap = Object.fromEntries(likeRows.map(r => [r.point_id, r.cnt]));

    const result = rows.map(r => {
      const pt = JSON.parse(r.data);
      pt.id = r.id; pt.owner_id = r.user_id; pt.owner_name = r.username;
      pt.opinions = opMap[r.id] || [];
      pt.views = viewMap[r.id] || 0;
      pt.likes = likeMap[r.id] || 0;
      pt.liked = myLikes.has(r.id);
      return pt;
    });
    return send(res, 200, result);
  }

  // POST /api/points
  if (req.method === 'POST' && url === '/api/points') {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const body = await readBody(req);
    db.run('INSERT INTO points (user_id, data) VALUES (?, ?)', [user.id, JSON.stringify(body.data)]);
    const row = dbGet('SELECT last_insert_rowid() as id');
    saveDb();
    return send(res, 200, { id: row.id });
  }

  // PUT /api/points/:id
  const putMatch = url.match(/^\/api\/points\/(\d+)$/);
  if (req.method === 'PUT' && putMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(putMatch[1]);
    const row = dbGet('SELECT user_id FROM points WHERE id=?', [id]);
    if (!row) return send(res, 404, { detail: 'Not found' });
    if (row.user_id !== user.id && !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    const body = await readBody(req);
    dbRun('UPDATE points SET data=? WHERE id=?', [JSON.stringify(body.data), id]);
    return send(res, 200, { ok: true });
  }

  // DELETE /api/points/:id
  const delMatch = url.match(/^\/api\/points\/(\d+)$/);
  if (req.method === 'DELETE' && delMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(delMatch[1]);
    const row = dbGet('SELECT user_id FROM points WHERE id=?', [id]);
    if (!row) return send(res, 404, { detail: 'Not found' });
    if (row.user_id !== user.id && !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    dbRun('DELETE FROM opinions WHERE point_id=?', [id]);
    dbRun('DELETE FROM points WHERE id=?', [id]);
    return send(res, 200, { ok: true });
  }

  // POST /api/points/:id/view
  const viewMatch = url.match(/^\/api\/points\/(\d+)\/view$/);
  if (req.method === 'POST' && viewMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(viewMatch[1]);
    const recent = dbGet(
      `SELECT 1 FROM views WHERE point_id=? AND user_id=? AND viewed_at > datetime('now','localtime','-1 hour')`,
      [id, user.id]
    );
    if (!recent) dbRun('INSERT OR IGNORE INTO views (point_id, user_id) VALUES (?, ?)', [id, user.id]);
    return send(res, 200, { ok: true });
  }

  // POST /api/points/:id/like
  const likeMatch = url.match(/^\/api\/points\/(\d+)\/like$/);
  if (req.method === 'POST' && likeMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(likeMatch[1]);
    const existing = dbGet('SELECT 1 FROM likes WHERE point_id=? AND user_id=?', [id, user.id]);
    if (existing) {
      dbRun('DELETE FROM likes WHERE point_id=? AND user_id=?', [id, user.id]);
    } else {
      dbRun('INSERT INTO likes (point_id, user_id) VALUES (?, ?)', [id, user.id]);
    }
    const cnt = dbGet('SELECT COUNT(*) as c FROM likes WHERE point_id=?', [id]);
    return send(res, 200, { liked: !existing, likes: cnt.c });
  }

  // POST /api/points/:id/opinions
  const opAddMatch = url.match(/^\/api\/points\/(\d+)\/opinions$/);
  if (req.method === 'POST' && opAddMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(opAddMatch[1]);
    const body = await readBody(req);
    if (!body.text?.trim()) return send(res, 400, { detail: 'Empty' });
    if (!dbGet('SELECT id FROM points WHERE id=?', [id])) return send(res, 404, { detail: 'Not found' });
    dbRun('INSERT INTO opinions (point_id, user_id, text) VALUES (?, ?, ?)', [id, user.id, body.text.trim()]);
    return send(res, 200, { ok: true });
  }

  // DELETE /api/opinions/:id
  const opDelMatch = url.match(/^\/api\/opinions\/(\d+)$/);
  if (req.method === 'DELETE' && opDelMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(opDelMatch[1]);
    const row = dbGet('SELECT user_id FROM opinions WHERE id=?', [id]);
    if (!row) return send(res, 404, { detail: 'Not found' });
    if (row.user_id !== user.id && !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    dbRun('DELETE FROM opinions WHERE id=?', [id]);
    return send(res, 200, { ok: true });
  }

  // POST /api/users/:id/ban
  const banMatch = url.match(/^\/api\/users\/(\d+)\/ban$/);
  if (req.method === 'POST' && banMatch) {
    if (!isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    const id = parseInt(banMatch[1]);
    dbRun('INSERT OR IGNORE INTO banned_users (user_id) VALUES (?)', [id]);
    dbRun('DELETE FROM sessions WHERE user_id=?', [id]);
    return send(res, 200, { ok: true });
  }

  // DELETE /api/users/:id/ban
  const unbanMatch = url.match(/^\/api\/users\/(\d+)\/ban$/);
  if (req.method === 'DELETE' && unbanMatch) {
    if (!isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    dbRun('DELETE FROM banned_users WHERE user_id=?', [parseInt(unbanMatch[1])]);
    return send(res, 200, { ok: true });
  }

  // GET /api/routes
  if (req.method === 'GET' && url === '/api/routes') {
    const rows = dbAll('SELECT r.id, r.user_id, r.data, u.username FROM routes r JOIN users u ON r.user_id=u.id');
    const ops  = dbAll('SELECT o.id, o.route_id, o.text, o.created_at, u.username, o.user_id FROM route_opinions o JOIN users u ON o.user_id=u.id');
    const opMap = {};
    for (const o of ops) {
      if (!opMap[o.route_id]) opMap[o.route_id] = [];
      opMap[o.route_id].push({ id: o.id, text: o.text, username: o.username, created_at: o.created_at, user_id: o.user_id });
    }
    return send(res, 200, rows.map(r => {
      const rt = JSON.parse(r.data);
      rt.id = r.id; rt.owner_id = r.user_id; rt.owner_name = r.username;
      rt.opinions = opMap[r.id] || [];
      return rt;
    }));
  }

  // POST /api/routes
  if (req.method === 'POST' && url === '/api/routes') {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const body = await readBody(req);
    db.run('INSERT INTO routes (user_id, data) VALUES (?, ?)', [user.id, JSON.stringify(body.data)]);
    const row = dbGet('SELECT last_insert_rowid() as id');
    saveDb();
    return send(res, 200, { id: row.id });
  }

  // PUT /api/routes/:id
  const routePutMatch = url.match(/^\/api\/routes\/(\d+)$/);
  if (req.method === 'PUT' && routePutMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(routePutMatch[1]);
    const row = dbGet('SELECT user_id FROM routes WHERE id=?', [id]);
    if (!row) return send(res, 404, { detail: 'Not found' });
    if (row.user_id !== user.id && !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    const body = await readBody(req);
    dbRun('UPDATE routes SET data=? WHERE id=?', [JSON.stringify(body.data), id]);
    return send(res, 200, { ok: true });
  }

  // DELETE /api/routes/:id
  const routeDelMatch = url.match(/^\/api\/routes\/(\d+)$/);
  if (req.method === 'DELETE' && routeDelMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(routeDelMatch[1]);
    const row = dbGet('SELECT user_id FROM routes WHERE id=?', [id]);
    if (!row) return send(res, 404, { detail: 'Not found' });
    if (row.user_id !== user.id && !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    dbRun('DELETE FROM routes WHERE id=?', [id]);
    return send(res, 200, { ok: true });
  }

  // POST /api/routes/:id/opinions
  const routeOpMatch = url.match(/^\/api\/routes\/(\d+)\/opinions$/);
  if (req.method === 'POST' && routeOpMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(routeOpMatch[1]);
    const body = await readBody(req);
    if (!body.text?.trim()) return send(res, 400, { detail: 'Empty' });
    if (!dbGet('SELECT id FROM routes WHERE id=?', [id])) return send(res, 404, { detail: 'Not found' });
    dbRun('INSERT INTO route_opinions (route_id, user_id, text) VALUES (?, ?, ?)', [id, user.id, body.text.trim()]);
    return send(res, 200, { ok: true });
  }

  // DELETE /api/route_opinions/:id
  const routeOpDelMatch = url.match(/^\/api\/route_opinions\/(\d+)$/);
  if (req.method === 'DELETE' && routeOpDelMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(routeOpDelMatch[1]);
    const row = dbGet('SELECT user_id FROM route_opinions WHERE id=?', [id]);
    if (!row) return send(res, 404, { detail: 'Not found' });
    if (row.user_id !== user.id && !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    dbRun('DELETE FROM route_opinions WHERE id=?', [id]);
    return send(res, 200, { ok: true });
  }

  // GET /api/travel_plans
  if (req.method === 'GET' && url === '/api/travel_plans') {
    const rows = dbAll('SELECT t.id, t.user_id, t.data, u.username FROM travel_plans t JOIN users u ON t.user_id=u.id');
    const ops = dbAll('SELECT o.id, o.plan_id, o.text, o.created_at, u.username, o.user_id FROM plan_opinions o JOIN users u ON o.user_id=u.id');
    const opMap = {};
    for (const o of ops) { (opMap[o.plan_id] = opMap[o.plan_id] || []).push(o); }
    return send(res, 200, rows.map(r => {
      const d = JSON.parse(r.data);
      d.id = r.id; d.owner_id = r.user_id; d.owner_name = r.username;
      d.opinions = opMap[r.id] || [];
      return d;
    }));
  }

  // POST /api/travel_plans
  if (req.method === 'POST' && url === '/api/travel_plans') {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const body = await readBody(req);
    db.run('INSERT INTO travel_plans (user_id, data) VALUES (?, ?)', [user.id, JSON.stringify(body.data)]);
    const row = dbGet('SELECT last_insert_rowid() as id');
    saveDb();
    return send(res, 200, { id: row.id });
  }

  // PUT /api/travel_plans/:id
  const planPutMatch = url.match(/^\/api\/travel_plans\/(\d+)$/);
  if (req.method === 'PUT' && planPutMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(planPutMatch[1]);
    const row = dbGet('SELECT user_id FROM travel_plans WHERE id=?', [id]);
    if (!row) return send(res, 404, { detail: 'Not found' });
    if (row.user_id !== user.id && !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    const body = await readBody(req);
    dbRun('UPDATE travel_plans SET data=? WHERE id=?', [JSON.stringify(body.data), id]);
    return send(res, 200, { ok: true });
  }

  // DELETE /api/travel_plans/:id
  const planDelMatch = url.match(/^\/api\/travel_plans\/(\d+)$/);
  if (req.method === 'DELETE' && planDelMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(planDelMatch[1]);
    const row = dbGet('SELECT user_id FROM travel_plans WHERE id=?', [id]);
    if (!row) return send(res, 404, { detail: 'Not found' });
    if (row.user_id !== user.id && !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    dbRun('DELETE FROM travel_plans WHERE id=?', [id]);
    return send(res, 200, { ok: true });
  }

  // POST /api/travel_plans/:id/opinions
  const planOpAddMatch = url.match(/^\/api\/travel_plans\/(\d+)\/opinions$/);
  if (req.method === 'POST' && planOpAddMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(planOpAddMatch[1]);
    const body = await readBody(req);
    if (!body.text?.trim()) return send(res, 400, { detail: 'Empty' });
    if (!dbGet('SELECT id FROM travel_plans WHERE id=?', [id])) return send(res, 404, { detail: 'Not found' });
    dbRun('INSERT INTO plan_opinions (plan_id, user_id, text) VALUES (?, ?, ?)', [id, user.id, body.text.trim()]);
    saveDb();
    return send(res, 200, { ok: true });
  }

  // DELETE /api/plan_opinions/:id
  const planOpDelMatch = url.match(/^\/api\/plan_opinions\/(\d+)$/);
  if (req.method === 'DELETE' && planOpDelMatch) {
    if (!user) return send(res, 401, { detail: 'Unauthorized' });
    const id = parseInt(planOpDelMatch[1]);
    const row = dbGet('SELECT user_id FROM plan_opinions WHERE id=?', [id]);
    if (!row) return send(res, 404, { detail: 'Not found' });
    if (row.user_id !== user.id && !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    dbRun('DELETE FROM plan_opinions WHERE id=?', [id]);
    saveDb();
    return send(res, 200, { ok: true });
  }

  // POST /api/feedbacks（匿名投稿）
  if (req.method === 'POST' && url === '/api/feedbacks') {
    const body = await readBody(req);
    if (!body.text?.trim()) return send(res, 400, { detail: 'Empty' });
    const score = parseInt(body.score) || 0;
    dbRun('INSERT INTO feedbacks (text, score) VALUES (?, ?)', [body.text.trim(), score]);
    saveDb();
    return send(res, 200, { ok: true });
  }

  // GET /api/feedbacks（管理者のみ）
  if (req.method === 'GET' && url === '/api/feedbacks') {
    if (!user || !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    const rows = dbAll('SELECT * FROM feedbacks ORDER BY id DESC');
    return send(res, 200, rows);
  }

  // DELETE /api/feedbacks/:id（管理者のみ）
  const fbDelMatch = url.match(/^\/api\/feedbacks\/(\d+)$/);
  if (req.method === 'DELETE' && fbDelMatch) {
    if (!user || !isAdmin(user)) return send(res, 403, { detail: 'Forbidden' });
    dbRun('DELETE FROM feedbacks WHERE id=?', [parseInt(fbDelMatch[1])]);
    saveDb();
    return send(res, 200, { ok: true });
  }

  // GET /api/stats
  if (req.method === 'GET' && url === '/api/stats') {
    const visitors = dbGet('SELECT COUNT(DISTINCT user_id) as c FROM sessions').c;
    const users = dbGet('SELECT COUNT(*) as c FROM users').c;
    const points = dbGet('SELECT COUNT(*) as c FROM points').c;
    return send(res, 200, { visitors, users, points });
  }

  // GET /api/ranking
  if (req.method === 'GET' && url === '/api/ranking') {
    const rows = dbAll(`
      SELECT u.username, COUNT(p.id) as cnt
      FROM points p JOIN users u ON p.user_id=u.id
      GROUP BY u.id ORDER BY cnt DESC LIMIT 10
    `);
    return send(res, 200, rows.map(r => ({ username: r.username, count: r.cnt })));
  }

  // 静的ファイル
  serveStatic(req, res);
}

// ===== 起動 =====
initDb().then(() => {
  http.createServer(handleRequest).listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
