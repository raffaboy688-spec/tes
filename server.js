/*
  MADING ONLINE - Server Node.js (tanpa npm install)

  Struktur folder:
    server.js            <- file ini (backend / API)
    public/index.html    <- struktur halaman (HTML)
    public/style.css     <- tampilan (CSS)
    public/script.js     <- logika di browser (JavaScript)

  Menjalankan:  node server.js   lalu buka  http://localhost:3000
  Admin default: admin / admin123  (GANTI SEGERA!)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ------------------------------------------------------------------ KONFIGURASI
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const KATEGORI = ['Umum', 'Akademik', 'Kegiatan', 'Lomba', 'Ekstrakurikuler', 'Penting'];
const PER_PAGE = 6;
const MAX_IMG = 5 * 1024 * 1024;
const MAX_BODY = 8 * 1024 * 1024;
const SESSION_MS = 8 * 60 * 60 * 1000;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ------------------------------------------------------------------- DATABASE (JSON)
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const checkPw = (pw, u) =>
  crypto.timingSafeEqual(crypto.scryptSync(pw, u.salt, 64), Buffer.from(u.hash, 'hex'));
const now = () => {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};

let db;
function save() {
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}
function load() {
  if (fs.existsSync(DATA_FILE)) { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); return; }
  db = { admins: [{ username: 'admin', ...hashPw('admin123') }], posts: [], nextId: 2 };
  db.posts.push({
    id: 1, judul: 'Selamat Datang di Mading Online',
    isi: 'Pengumuman sekolah akan dipublikasikan di sini.\nSilakan cek secara berkala agar tidak ketinggalan informasi.',
    kategori: 'Penting', gambar: null, pinned: true, dilihat: 0, dibuat: now(), diubah: null,
  });
  save();
}
load();

// ------------------------------------------------------------------- SESI
const sessions = new Map();
const attempts = new Map();

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function getSession(req) {
  const t = parseCookies(req).sid;
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  return { token: t, ...s };
}
setInterval(() => {
  for (const [t, s] of sessions) if (s.exp < Date.now()) sessions.delete(t);
}, 60 * 1000).unref();

// ------------------------------------------------------------------- UTILITAS
function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', ...headers,
  });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Ukuran data terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Format data tidak valid')); }
    });
    req.on('error', reject);
  });
}
function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Format gambar harus PNG, JPG, GIF, atau WEBP');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMG) throw new Error('Ukuran gambar maksimal 5 MB');
  const name = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}
function deleteImage(name) {
  if (!name) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(name))); } catch { /* abaikan */ }
}
function validatePost(b) {
  const judul = String(b.judul || '').trim(), isi = String(b.isi || '').trim();
  if (!judul || judul.length > 150) throw new Error('Judul wajib diisi (maks 150 karakter)');
  if (!isi || isi.length > 10000) throw new Error('Isi wajib diisi (maks 10.000 karakter)');
  return { judul, isi, kategori: KATEGORI.includes(b.kategori) ? b.kategori : 'Umum', pinned: !!b.pinned };
}
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
};
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/script.js': 'script.js' };
const sortPosts = arr => [...arr].sort((a, b) => (b.pinned - a.pinned) || (b.id - a.id));

function serveFile(res, file, cache) {
  if (!fs.existsSync(file)) return send(res, 404, { error: 'Tidak ditemukan' });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).slice(1)] || 'application/octet-stream',
    'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

// ------------------------------------------------------------------- SERVER
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, method = req.method;

    // file statis (HTML, CSS, JS)
    if (method === 'GET' && STATIC[p]) return serveFile(res, path.join(PUBLIC_DIR, STATIC[p]), 'no-cache');
    if (method === 'GET' && p.startsWith('/uploads/'))
      return serveFile(res, path.join(UPLOAD_DIR, path.basename(p)), 'public, max-age=86400');

    if (!p.startsWith('/api/')) return send(res, 404, { error: 'Halaman tidak ditemukan' });

    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Origin tidak diizinkan' });
    }

    const sess = getSession(req);
    const isAdmin = !!sess;
    const needAdmin = () => { if (!isAdmin) { send(res, 401, { error: 'Silakan login sebagai admin' }); return false; } return true; };

    // ---- publik
    if (p === '/api/config' && method === 'GET') return send(res, 200, { kategori: KATEGORI });
    if (p === '/api/me' && method === 'GET') return send(res, 200, { admin: sess ? sess.user : null });

    if (p === '/api/posts' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase().trim();
      const kat = url.searchParams.get('kategori') || '';
      let page = Math.max(parseInt(url.searchParams.get('page')) || 1, 1);
      let list = sortPosts(db.posts).filter(x =>
        (!kat || x.kategori === kat) && (!q || x.judul.toLowerCase().includes(q) || x.isi.toLowerCase().includes(q)));
      const total = list.length, totalPages = Math.max(Math.ceil(total / PER_PAGE), 1);
      page = Math.min(page, totalPages);
      list = list.slice((page - 1) * PER_PAGE, page * PER_PAGE)
        .map(x => ({ ...x, isi: x.isi.length > 140 ? x.isi.slice(0, 140) + '...' : x.isi }));
      return send(res, 200, { items: list, total, page, totalPages });
    }

    let m;
    if ((m = p.match(/^\/api\/posts\/(\d+)$/))) {
      const id = +m[1];
      const post = db.posts.find(x => x.id === id);

      if (method === 'GET') {
        if (!post) return send(res, 404, { error: 'Pengumuman tidak ditemukan' });
        if (!(isAdmin && url.searchParams.get('nocount'))) { post.dilihat++; save(); }
        return send(res, 200, post);
      }
      if (method === 'PUT') {
        if (!needAdmin()) return;
        if (!post) return send(res, 404, { error: 'Pengumuman tidak ditemukan' });
        const b = await readJson(req);
        const v = validatePost(b);
        let gambar = post.gambar;
        if (b.gambar) { const baru = saveImage(b.gambar); deleteImage(gambar); gambar = baru; }
        else if (b.hapusGambar) { deleteImage(gambar); gambar = null; }
        Object.assign(post, v, { gambar, diubah: now() });
        save();
        return send(res, 200, post);
      }
      if (method === 'DELETE') {
        if (!needAdmin()) return;
        if (!post) return send(res, 404, { error: 'Pengumuman tidak ditemukan' });
        deleteImage(post.gambar);
        db.posts = db.posts.filter(x => x.id !== id);
        save();
        return send(res, 200, { ok: true });
      }
    }

    // ---- auth
    if (p === '/api/login' && method === 'POST') {
      const ip = req.socket.remoteAddress;
      const a = attempts.get(ip) || { n: 0, until: 0 };
      if (a.until > Date.now()) return send(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' });
      const b = await readJson(req);
      const user = db.admins.find(u => u.username === String(b.username || '').trim());
      if (user && checkPw(String(b.password || ''), user)) {
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { user: user.username, exp: Date.now() + SESSION_MS });
        return send(res, 200, { admin: user.username }, {
          'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`,
        });
      }
      a.n++;
      if (a.n >= 5) { a.until = Date.now() + 5 * 60 * 1000; a.n = 0; }
      attempts.set(ip, a);
      return send(res, 401, { error: 'Username atau password salah' });
    }
    if (p === '/api/logout' && method === 'POST') {
      if (sess) sessions.delete(sess.token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    // ---- admin
    if (p === '/api/admin/posts' && method === 'GET') {
      if (!needAdmin()) return;
      const items = sortPosts(db.posts);
      return send(res, 200, {
        items, total: items.length,
        pinned: items.filter(x => x.pinned).length,
        views: items.reduce((s, x) => s + x.dilihat, 0),
      });
    }
    if (p === '/api/posts' && method === 'POST') {
      if (!needAdmin()) return;
      const b = await readJson(req);
      const v = validatePost(b);
      const gambar = b.gambar ? saveImage(b.gambar) : null;
      const post = { id: db.nextId++, ...v, gambar, dilihat: 0, dibuat: now(), diubah: null };
      db.posts.push(post);
      save();
      return send(res, 201, post);
    }

    send(res, 404, { error: 'Endpoint tidak ditemukan' });
  } catch (e) {
    send(res, 400, { error: e.message || 'Terjadi kesalahan' });
  }
});


server.listen(PORT, () => {
  console.log(`Mading Online berjalan di  http://localhost:${PORT}`);
  console.log('Login admin default: admin / admin123  (segera ganti!)');
});

/*
  MADING ONLINE - Node.js (satu file: server + HTML + CSS + JS, tanpa npm install)

  Cara menjalankan di VS Code:
    1. Install Node.js (https://nodejs.org) versi 18 ke atas
    2. Buka terminal VS Code di folder file ini, lalu jalankan:  node server.js
    3. Buka browser:  http://localhost:3000

  Siswa/pengunjung : halaman utama (hanya membaca)
  Admin            : klik "Login Admin"  ->  username: admin | password: admin123  (GANTI SEGERA!)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ------------------------------------------------------------------ KONFIGURASI
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const KATEGORI = ['Umum', 'Akademik', 'Kegiatan', 'Lomba', 'Ekstrakurikuler', 'Penting'];
const PER_PAGE = 6;
const MAX_IMG = 5 * 1024 * 1024;           // 5 MB
const MAX_BODY = 8 * 1024 * 1024;          // batas request JSON (gambar base64)
const SESSION_MS = 8 * 60 * 60 * 1000;     // sesi admin 8 jam

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ------------------------------------------------------------------- DATABASE (JSON)
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const checkPw = (pw, u) =>
  crypto.timingSafeEqual(crypto.scryptSync(pw, u.salt, 64), Buffer.from(u.hash, 'hex'));
const now = () => {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};

let db;
function save() {
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}
function load() {
  if (fs.existsSync(DATA_FILE)) { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); return; }
  db = { admins: [{ username: 'admin', ...hashPw('admin123') }], posts: [], nextId: 2 };
  db.posts.push({
    id: 1, judul: 'Selamat Datang di Mading Online',
    isi: 'Pengumuman sekolah akan dipublikasikan di sini.\nSilakan cek secara berkala agar tidak ketinggalan informasi.',
    kategori: 'Penting', gambar: null, pinned: true, dilihat: 0, dibuat: now(), diubah: null,
  });
  save();
}
load();

// ------------------------------------------------------------------- SESI & KEAMANAN
const sessions = new Map();   // token -> { user, exp }
const attempts = new Map();   // ip -> { n, until }

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function getSession(req) {
  const t = parseCookies(req).sid;
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  return { token: t, ...s };
}
setInterval(() => {
  for (const [t, s] of sessions) if (s.exp < Date.now()) sessions.delete(t);
}, 60 * 1000).unref();

// ------------------------------------------------------------------- UTILITAS HTTP
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Ukuran data terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Format data tidak valid')); }
    });
    req.on('error', reject);
  });
}
function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Format gambar harus PNG, JPG, GIF, atau WEBP');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMG) throw new Error('Ukuran gambar maksimal 5 MB');
  const name = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}
function deleteImage(name) {
  if (!name) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(name))); } catch { /* abaikan */ }
}
function validatePost(b) {
  const judul = String(b.judul || '').trim(), isi = String(b.isi || '').trim();
  if (!judul || judul.length > 150) throw new Error('Judul wajib diisi (maks 150 karakter)');
  if (!isi || isi.length > 10000) throw new Error('Isi wajib diisi (maks 10.000 karakter)');
  return { judul, isi, kategori: KATEGORI.includes(b.kategori) ? b.kategori : 'Umum', pinned: !!b.pinned };
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const sortPosts = arr => [...arr].sort((a, b) => (b.pinned - a.pinned) || (b.id - a.id));

// ------------------------------------------------------------------- SERVER
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, method = req.method;

    if (p === '/' && method === 'GET') return send(res, 200, PAGE());

    if (p.startsWith('/uploads/') && method === 'GET') {
      const file = path.join(UPLOAD_DIR, path.basename(p));
      if (!fs.existsSync(file)) return send(res, 404, { error: 'Tidak ditemukan' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).slice(1)] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
      });
      return fs.createReadStream(file).pipe(res);
    }

    if (!p.startsWith('/api/')) return send(res, 404, { error: 'Halaman tidak ditemukan' });

    // Perlindungan CSRF sederhana untuk request yang mengubah data
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Origin tidak diizinkan' });
    }

    const sess = getSession(req);
    const isAdmin = !!sess;
    const needAdmin = () => { if (!isAdmin) { send(res, 401, { error: 'Silakan login sebagai admin' }); return false; } return true; };

    // ---- publik
    if (p === '/api/me' && method === 'GET') return send(res, 200, { admin: sess ? sess.user : null });

    if (p === '/api/posts' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase().trim();
      const kat = url.searchParams.get('kategori') || '';
      let page = Math.max(parseInt(url.searchParams.get('page')) || 1, 1);
      let list = sortPosts(db.posts).filter(x =>
        (!kat || x.kategori === kat) && (!q || x.judul.toLowerCase().includes(q) || x.isi.toLowerCase().includes(q)));
      const total = list.length, totalPages = Math.max(Math.ceil(total / PER_PAGE), 1);
      page = Math.min(page, totalPages);
      list = list.slice((page - 1) * PER_PAGE, page * PER_PAGE)
        .map(x => ({ ...x, isi: x.isi.length > 140 ? x.isi.slice(0, 140) + '...' : x.isi }));
      return send(res, 200, { items: list, total, page, totalPages });
    }

    let m;
    if ((m = p.match(/^\/api\/posts\/(\d+)$/))) {
      const id = +m[1];
      const post = db.posts.find(x => x.id === id);

      if (method === 'GET') {
        if (!post) return send(res, 404, { error: 'Pengumuman tidak ditemukan' });
        if (!(isAdmin && url.searchParams.get('nocount'))) { post.dilihat++; save(); }
        return send(res, 200, post);
      }
      if (method === 'PUT') {
        if (!needAdmin()) return;
        if (!post) return send(res, 404, { error: 'Pengumuman tidak ditemukan' });
        const b = await readJson(req);
        const v = validatePost(b);
        let gambar = post.gambar;
        if (b.gambar) { const baru = saveImage(b.gambar); deleteImage(gambar); gambar = baru; }
        else if (b.hapusGambar) { deleteImage(gambar); gambar = null; }
        Object.assign(post, v, { gambar, diubah: now() });
        save();
        return send(res, 200, post);
      }
      if (method === 'DELETE') {
        if (!needAdmin()) return;
        if (!post) return send(res, 404, { error: 'Pengumuman tidak ditemukan' });
        deleteImage(post.gambar);
        db.posts = db.posts.filter(x => x.id !== id);
        save();
        return send(res, 200, { ok: true });
      }
    }

    // ---- auth
    if (p === '/api/login' && method === 'POST') {
      const ip = req.socket.remoteAddress;
      const a = attempts.get(ip) || { n: 0, until: 0 };
      if (a.until > Date.now()) return send(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' });
      const b = await readJson(req);
      const user = db.admins.find(u => u.username === String(b.username || '').trim());
      if (user && checkPw(String(b.password || ''), user)) {
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { user: user.username, exp: Date.now() + SESSION_MS });
        return send(res, 200, { admin: user.username }, {
          'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`,
        });
      }
      a.n++;
      if (a.n >= 5) { a.until = Date.now() + 5 * 60 * 1000; a.n = 0; }
      attempts.set(ip, a);
      return send(res, 401, { error: 'Username atau password salah' });
    }
    if (p === '/api/logout' && method === 'POST') {
      if (sess) sessions.delete(sess.token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    // ---- admin
    if (p === '/api/admin/posts' && method === 'GET') {
      if (!needAdmin()) return;
      const items = sortPosts(db.posts);
      return send(res, 200, {
        items, total: items.length,
        pinned: items.filter(x => x.pinned).length,
        views: items.reduce((s, x) => s + x.dilihat, 0),
      });
    }
    if (p === '/api/posts' && method === 'POST') {
      if (!needAdmin()) return;
      const b = await readJson(req);
      const v = validatePost(b);
      const gambar = b.gambar ? saveImage(b.gambar) : null;
      const post = { id: db.nextId++, ...v, gambar, dilihat: 0, dibuat: now(), diubah: null };
      db.posts.push(post);
      save();
      return send(res, 201, post);
    }

    send(res, 404, { error: 'Endpoint tidak ditemukan' });
  } catch (e) {
    send(res, 400, { error: e.message || 'Terjadi kesalahan' });
  }
});

server.listen(PORT, () => {
  console.log(`Mading Online berjalan di  http://localhost:${PORT}`);
  console.log('Login admin default: admin / admin123  (segera ganti!)');
});

// ===================================================================================
//                          TAMPILAN (HTML + CSS + JS di browser)
// ===================================================================================
const CSS = `
:root{--bg:#f4f6fb;--card:#fff;--text:#1f2937;--muted:#6b7280;--primary:#4f46e5;--primary2:#7c3aed;
--border:#e5e7eb;--danger:#dc2626;--ok:#16a34a;--shadow:0 4px 18px rgba(0,0,0,.07)}
body.dark{--bg:#0f172a;--card:#1e293b;--text:#e5e7eb;--muted:#94a3b8;--border:#334155;--shadow:0 4px 18px rgba(0,0,0,.4)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;transition:.3s}
a{color:var(--primary);text-decoration:none;cursor:pointer}
.container{max-width:1100px;margin:auto;padding:0 18px}
header{background:linear-gradient(135deg,var(--primary),var(--primary2));position:sticky;top:0;z-index:50;box-shadow:var(--shadow)}
.nav{display:flex;align-items:center;justify-content:space-between;padding:14px 0;flex-wrap:wrap;gap:10px}
.brand{font-size:1.4rem;font-weight:800;color:#fff}
.nav-links{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.nav-links a,.nav-links button{color:#fff;background:rgba(255,255,255,.15);padding:7px 14px;border-radius:8px;border:0;cursor:pointer;font-size:.9rem}
.nav-links a:hover,.nav-links button:hover{background:rgba(255,255,255,.3)}
.hero{text-align:center;padding:40px 0 10px}.hero h1{font-size:2rem}.hero p{color:var(--muted)}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}
input,select,textarea{padding:11px 14px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--text);font:inherit;width:100%}
.toolbar input{flex:2;min-width:200px}.toolbar select{flex:1;min-width:150px}
.btn{display:inline-block;padding:10px 18px;border-radius:10px;border:0;cursor:pointer;font-weight:600;background:var(--primary);color:#fff;font-size:.95rem;text-align:center}
.btn:hover{opacity:.9}.btn.danger{background:var(--danger)}.btn.gray{background:var(--muted)}.btn.sm{padding:6px 12px;font-size:.85rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:20px;margin-bottom:30px}
.card{background:var(--card);border-radius:16px;overflow:hidden;box-shadow:var(--shadow);border:1px solid var(--border);display:flex;flex-direction:column;transition:.25s}
.card:hover{transform:translateY(-4px)}.card img{width:100%;height:170px;object-fit:cover}
.card-body{padding:18px;flex:1;display:flex;flex-direction:column}
.card h3{margin:8px 0;font-size:1.1rem}.card p{color:var(--muted);flex:1;font-size:.93rem;white-space:pre-wrap}
.meta{font-size:.8rem;color:var(--muted);margin:12px 0;display:flex;justify-content:space-between}
.badge{display:inline-block;font-size:.72rem;padding:3px 10px;border-radius:20px;background:var(--primary);color:#fff;font-weight:600}
.badge.pin{background:#f59e0b;margin-left:6px}.k-Penting{background:var(--danger)}.k-Lomba{background:#0891b2}.k-Akademik{background:#059669}
.pagination{display:flex;justify-content:center;gap:8px;margin:10px 0 40px;flex-wrap:wrap}
.pagination button{padding:8px 14px;border-radius:8px;background:var(--card);border:1px solid var(--border);color:var(--text);cursor:pointer}
.pagination .active{background:var(--primary);color:#fff;border-color:var(--primary)}
.panel{background:var(--card);border-radius:16px;padding:26px;box-shadow:var(--shadow);border:1px solid var(--border);margin:26px 0}
.panel label{display:block;margin:14px 0 6px;font-weight:600}
.detail img{max-width:100%;border-radius:12px;margin:14px 0}.detail .isi{white-space:pre-wrap;font-size:1.02rem}
table{width:100%;border-collapse:collapse}th,td{padding:12px;text-align:left;border-bottom:1px solid var(--border);font-size:.92rem}th{color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin:20px 0}
.stat{background:var(--card);padding:18px;border-radius:14px;border:1px solid var(--border);box-shadow:var(--shadow)}.stat b{font-size:1.8rem;color:var(--primary)}
.empty{text-align:center;padding:60px 0;color:var(--muted)}
footer{text-align:center;padding:26px;color:var(--muted);font-size:.85rem}
.check{display:flex;align-items:center;gap:8px;margin-top:14px}.check input{width:auto}.check label{margin:0!important}
#toast{position:fixed;right:18px;bottom:18px;z-index:99;display:flex;flex-direction:column;gap:8px}
.toast{padding:12px 18px;border-radius:10px;color:#fff;box-shadow:var(--shadow);animation:in .3s}
.toast.success{background:var(--ok)}.toast.error{background:var(--danger)}
@keyframes in{from{opacity:0;transform:translateY(10px)}}
.skeleton{height:260px;border-radius:16px;background:linear-gradient(90deg,var(--card),var(--border),var(--card));background-size:200% 100%;animation:sk 1.2s infinite}
@keyframes sk{to{background-position:-200% 0}}
@media(max-width:600px){.hero h1{font-size:1.5rem}th:nth-child(3),td:nth-child(3){display:none}}
@media print{header,footer,.btn,#toast{display:none!important}}
`;

// Fungsi ini dijalankan di BROWSER (dikirim sebagai teks ke halaman).
function client() {
  const $ = s => document.querySelector(s);
  const app = $('#app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let me = null;
  const state = { q: '', kat: '', page: 1 };

  async function api(url, method = 'GET', body) {
    const opt = { method, headers: {} };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(url, opt);
    let d = {}; try { d = await r.json(); } catch { /* kosong */ }
    if (!r.ok) throw new Error(d.error || 'Terjadi kesalahan');
    return d;
  }
  function toast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = 'toast ' + type; t.textContent = msg;
    $('#toast').appendChild(t);
    setTimeout(() => t.remove(), 3800);
  }
  const go = h => { location.hash = h; };
  const badge = p => `<span class="badge k-${esc(p.kategori)}">${esc(p.kategori)}</span>` +
    (p.pinned ? '<span class="badge pin">📌 Disematkan</span>' : '');

  // ---------- navbar
  function renderNav() {
    $('#nav').innerHTML = `
      <a class="brand" href="#/">📌 Mading Online</a>
      <div class="nav-links">
        <a href="#/">Beranda</a>
        ${me ? `<a href="#/admin">Dashboard</a><a href="#/admin/new">+ Pengumuman</a><a id="logout">Logout</a>`
             : `<a href="#/login">Login Admin</a>`}
        <button id="themeBtn" title="Ganti tema">${document.body.classList.contains('dark') ? '☀️' : '🌙'}</button>
      </div>`;
    $('#themeBtn').onclick = () => {
      document.body.classList.toggle('dark');
      const d = document.body.classList.contains('dark');
      localStorage.setItem('tema', d ? 'dark' : 'light');
      $('#themeBtn').textContent = d ? '☀️' : '🌙';
    };
    const lo = $('#logout');
    if (lo) lo.onclick = async () => { await api('/api/logout', 'POST'); me = null; toast('Anda telah logout'); go('#/'); route(); };
  }

  // ---------- beranda (siswa/pengunjung)
  async function pageHome() {
    app.innerHTML = `
      <section class="hero"><h1>Papan Pengumuman Sekolah</h1><p>Informasi terbaru untuk seluruh siswa</p></section>
      <div class="toolbar">
        <input id="q" placeholder="🔍 Cari pengumuman..." value="${esc(state.q)}">
        <select id="kat"><option value="">Semua Kategori</option>
          ${window.KATEGORI.map(k => `<option ${k === state.kat ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
      </div>
      <div id="list"></div>`;
    let timer;
    $('#q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value; state.page = 1; loadList(); }, 300); };
    $('#kat').onchange = e => { state.kat = e.target.value; state.page = 1; loadList(); };
    await loadList();
  }
  async function loadList() {
    const box = $('#list');
    box.innerHTML = '<div class="grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    const qs = new URLSearchParams({ q: state.q, kategori: state.kat, page: state.page });
    const d = await api('/api/posts?' + qs);
    state.page = d.page;
    if (!d.items.length) { box.innerHTML = '<div class="empty"><h2>😶 Belum ada pengumuman</h2><p>Coba kata kunci atau kategori lain.</p></div>'; return; }
    box.innerHTML = `<div class="grid">${d.items.map(p => `
      <article class="card">
        ${p.gambar ? `<img loading="lazy" src="/uploads/${esc(p.gambar)}" alt="">` : ''}
        <div class="card-body">
          <div>${badge(p)}</div><h3>${esc(p.judul)}</h3><p>${esc(p.isi)}</p>
          <div class="meta"><span>🕒 ${esc(p.dibuat)}</span><span>👁 ${p.dilihat}</span></div>
          <a class="btn sm" href="#/post/${p.id}">Baca selengkapnya</a>
        </div>
      </article>`).join('')}</div>
      <div class="pagination">${Array.from({ length: d.totalPages }, (_, i) =>
        `<button data-p="${i + 1}" class="${i + 1 === d.page ? 'active' : ''}">${i + 1}</button>`).join('')}</div>`;
    box.querySelectorAll('.pagination button').forEach(b => b.onclick = () => { state.page = +b.dataset.p; loadList(); window.scrollTo(0, 0); });
  }

  // ---------- detail
  async function pageDetail(id) {
    const p = await api('/api/posts/' + id);
    app.innerHTML = `<div class="panel detail">
      <a href="#/">← Kembali</a>
      <div style="margin-top:14px">${badge(p)}</div>
      <h1 style="margin:10px 0">${esc(p.judul)}</h1>
      <div class="meta" style="justify-content:flex-start;gap:18px">
        <span>🕒 ${esc(p.dibuat)}</span>${p.diubah ? `<span>✏️ Diubah ${esc(p.diubah)}</span>` : ''}<span>👁 ${p.dilihat} dilihat</span></div>
      ${p.gambar ? `<img src="/uploads/${esc(p.gambar)}" alt="">` : ''}
      <div class="isi">${esc(p.isi)}</div>
      <div style="margin-top:22px;display:flex;gap:8px">
        <button class="btn gray sm" id="copy">🔗 Salin tautan</button>
        <button class="btn gray sm" onclick="window.print()">🖨 Cetak</button></div></div>`;
    $('#copy').onclick = () => navigator.clipboard.writeText(location.href).then(() => toast('Tautan disalin!'));
  }

  // ---------- login
  function pageLogin() {
    if (me) return go('#/admin');
    app.innerHTML = `<div class="panel" style="max-width:420px;margin:60px auto">
      <h2>🔐 Login Admin</h2>
      <form id="lf">
        <label>Username</label><input id="u" required autofocus autocomplete="username">
        <label>Password</label><input id="pw" type="password" required autocomplete="current-password">
        <div class="check"><input type="checkbox" id="sp"><label for="sp">Tampilkan password</label></div>
        <button class="btn" style="margin-top:18px;width:100%">Masuk</button>
      </form></div>`;
    $('#sp').onchange = e => { $('#pw').type = e.target.checked ? 'text' : 'password'; };
    $('#lf').onsubmit = async e => {
      e.preventDefault();
      try {
        const d = await api('/api/login', 'POST', { username: $('#u').value, password: $('#pw').value });
        me = d.admin; toast('Login berhasil. Selamat datang!'); go('#/admin'); route();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ---------- dashboard admin
  async function pageDash() {
    if (!me) { toast('Silakan login terlebih dahulu', 'error'); return go('#/login'); }
    const d = await api('/api/admin/posts');
    app.innerHTML = `<h2 style="margin-top:28px">Dashboard Admin</h2>
      <div class="stats">
        <div class="stat"><small>Total Pengumuman</small><br><b>${d.total}</b></div>
        <div class="stat"><small>Disematkan</small><br><b>${d.pinned}</b></div>
        <div class="stat"><small>Total Dilihat</small><br><b>${d.views}</b></div></div>
      <div class="panel" style="overflow-x:auto">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <h3>Kelola Pengumuman</h3><a class="btn sm" href="#/admin/new">+ Tambah Baru</a></div>
        <table><tr><th>Judul</th><th>Kategori</th><th>Tanggal</th><th>Dilihat</th><th>Aksi</th></tr>
        ${d.items.map(p => `<tr>
          <td>${p.pinned ? '📌 ' : ''}<a href="#/post/${p.id}">${esc(p.judul)}</a></td>
          <td>${esc(p.kategori)}</td><td>${esc(p.dibuat)}</td><td>${p.dilihat}</td>
          <td style="display:flex;gap:6px"><a class="btn sm" href="#/admin/edit/${p.id}">Edit</a>
            <button class="btn sm danger" data-del="${p.id}">Hapus</button></td></tr>`).join('')
          || '<tr><td colspan="5" class="empty">Belum ada data.</td></tr>'}
        </table></div>`;
    app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Hapus pengumuman ini?')) return;
      try { await api('/api/posts/' + b.dataset.del, 'DELETE'); toast('Pengumuman dihapus'); pageDash(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }

  // ---------- form tambah / edit
  const readFile = f => new Promise((ok, no) => {
    const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f);
  });
  async function pageForm(id) {
    if (!me) { toast('Silakan login terlebih dahulu', 'error'); return go('#/login'); }
    const p = id ? await api('/api/posts/' + id + '?nocount=1') : null;
    app.innerHTML = `<div class="panel" style="max-width:760px;margin:30px auto">
      <h2>${p ? 'Edit' : 'Tambah'} Pengumuman</h2>
      <form id="pf">
        <label>Judul</label><input id="judul" maxlength="150" required value="${esc(p ? p.judul : '')}">
        <label>Kategori</label>
        <select id="kategori">${window.KATEGORI.map(k => `<option ${p && p.kategori === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
        <label>Isi Pengumuman <small id="count" style="color:var(--muted)"></small></label>
        <textarea id="isi" rows="9" required>${esc(p ? p.isi : '')}</textarea>
        <label>Gambar (opsional, maks 5 MB)</label>
        <input type="file" id="gambar" accept="image/png,image/jpeg,image/gif,image/webp">
        <img id="pv" style="max-width:240px;margin-top:10px;border-radius:10px;${p && p.gambar ? '' : 'display:none'}"
             ${p && p.gambar ? `src="/uploads/${esc(p.gambar)}"` : ''}>
        ${p && p.gambar ? '<div class="check"><input type="checkbox" id="hg"><label for="hg">Hapus gambar saat ini</label></div>' : ''}
        <div class="check"><input type="checkbox" id="pinned" ${p && p.pinned ? 'checked' : ''}><label for="pinned">📌 Sematkan di atas</label></div>
        <div style="margin-top:20px;display:flex;gap:10px"><button class="btn">Simpan</button><a class="btn gray" href="#/admin">Batal</a></div>
      </form></div>`;
    const upd = () => { $('#count').textContent = '(' + $('#isi').value.length + ' karakter)'; };
    $('#isi').oninput = upd; upd();
    $('#gambar').onchange = e => {
      const f = e.target.files[0];
      if (f) { $('#pv').src = URL.createObjectURL(f); $('#pv').style.display = 'block'; }
    };
    $('#pf').onsubmit = async e => {
      e.preventDefault();
      try {
        const f = $('#gambar').files[0];
        if (f && f.size > 5 * 1024 * 1024) throw new Error('Ukuran gambar maksimal 5 MB');
        const body = {
          judul: $('#judul').value, isi: $('#isi').value, kategori: $('#kategori').value,
          pinned: $('#pinned').checked, hapusGambar: !!($('#hg') && $('#hg').checked),
        };
        if (f) body.gambar = await readFile(f);
        await api(p ? '/api/posts/' + p.id : '/api/posts', p ? 'PUT' : 'POST', body);
        toast(p ? 'Pengumuman diperbarui' : 'Pengumuman dipublikasikan');
        go('#/admin');
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ---------- router
  async function route() {
    const h = (location.hash.slice(1) || '/');
    renderNav();
    let m;
    try {
      if (h === '/') await pageHome();
      else if ((m = h.match(/^\/post\/(\d+)$/))) await pageDetail(m[1]);
      else if (h === '/login') pageLogin();
      else if (h === '/admin') await pageDash();
      else if (h === '/admin/new') await pageForm();
      else if ((m = h.match(/^\/admin\/edit\/(\d+)$/))) await pageForm(m[1]);
      else app.innerHTML = '<div class="empty"><h2>404</h2><p>Halaman tidak ditemukan.</p></div>';
    } catch (err) {
      app.innerHTML = `<div class="empty"><h2>😕 ${esc(err.message)}</h2><a href="#/">Kembali ke beranda</a></div>`;
    }
    if (!/^\/$/.test(h)) window.scrollTo(0, 0);
  }

  // ---------- mulai
  if (localStorage.getItem('tema') === 'dark') document.body.classList.add('dark');
  window.addEventListener('hashchange', route);
  api('/api/me').then(d => { me = d.admin; }).catch(() => {}).finally(route);
}

function PAGE() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mading Online</title>
<style>${CSS}</style>
</head>
<body>
<header><div class="container nav" id="nav"></div></header>
<main class="container" id="app"></main>
<footer>© ${new Date().getFullYear()} Mading Online Sekolah</footer>
<div id="toast"></div>
<script>
window.KATEGORI = ${JSON.stringify(KATEGORI)};
(${client.toString()})();
</script>
</body>
</html>`;
}

