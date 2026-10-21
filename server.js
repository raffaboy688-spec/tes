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
