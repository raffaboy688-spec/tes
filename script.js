/* ==========================================================
   MADING ONLINE - script.js (berjalan di browser)
   Halaman memakai alamat hash:
     #/                  beranda (siswa membaca)
     #/post/ID           detail pengumuman
     #/login             login admin
     #/admin             dashboard admin
     #/admin/new         tambah pengumuman
     #/admin/edit/ID     edit pengumuman
   ========================================================== */
(() => {
  const $ = s => document.querySelector(s);
  const app = $('#app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let me = null;                       // nama admin yang sedang login
  let KATEGORI = [];                   // diambil dari server
  const state = { q: '', kat: '', page: 1 };

  /* ---------- Helper ---------- */
  async function api(url, method = 'GET', body) {
    const opt = { method, headers: {} };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(url, opt);
    let d = {};
    try { d = await r.json(); } catch { /* kosong */ }
    if (!r.ok) throw new Error(d.error || 'Terjadi kesalahan');
    return d;
  }

  function toast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    $('#toast').appendChild(t);
    setTimeout(() => t.remove(), 3800);
  }

  const go = h => { location.hash = h; };

  const badge = p =>
    `<span class="badge k-${esc(p.kategori)}">${esc(p.kategori)}</span>` +
    (p.pinned ? '<span class="badge pin">📌 Disematkan</span>' : '');

  const readFile = f => new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = no;
    r.readAsDataURL(f);
  });

  /* ---------- Navigasi ---------- */
  function renderNav() {
    const dark = document.body.classList.contains('dark');
    $('#nav').innerHTML = `
      <a class="brand" href="#/">📌 Mading Online</a>
      <div class="nav-links">
        <a href="#/">Beranda</a>
        ${me
          ? `<a href="#/admin">Dashboard</a><a href="#/admin/new">+ Pengumuman</a><a id="logout">Logout</a>`
          : `<a href="#/login">Login Admin</a>`}
        <button id="themeBtn" title="Ganti tema">${dark ? '☀️' : '🌙'}</button>
      </div>`;

    $('#themeBtn').onclick = () => {
      document.body.classList.toggle('dark');
      const d = document.body.classList.contains('dark');
      localStorage.setItem('tema', d ? 'dark' : 'light');
      $('#themeBtn').textContent = d ? '☀️' : '🌙';
    };
    const lo = $('#logout');
    if (lo) lo.onclick = async () => {
      await api('/api/logout', 'POST');
      me = null;
      toast('Anda telah logout');
      go('#/');
      route();
    };
  }

  /* ---------- Beranda (siswa / pengunjung) ---------- */
  async function pageHome() {
    app.innerHTML = `
      <section class="hero">
        <h1>Papan Pengumuman Sekolah</h1>
        <p>Informasi terbaru untuk seluruh siswa</p>
      </section>
      <div class="toolbar">
        <input id="q" placeholder="🔍 Cari pengumuman..." value="${esc(state.q)}">
        <select id="kat">
          <option value="">Semua Kategori</option>
          ${KATEGORI.map(k => `<option ${k === state.kat ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
      </div>
      <div id="list"></div>`;

    let timer;
    $('#q').oninput = e => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = e.target.value; state.page = 1; loadList(); }, 300);
    };
    $('#kat').onchange = e => { state.kat = e.target.value; state.page = 1; loadList(); };
    await loadList();
  }

  async function loadList() {
    const box = $('#list');
    box.innerHTML = '<div class="grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    const qs = new URLSearchParams({ q: state.q, kategori: state.kat, page: state.page });
    const d = await api('/api/posts?' + qs);
    state.page = d.page;

    if (!d.items.length) {
      box.innerHTML = '<div class="empty"><h2>😶 Belum ada pengumuman</h2><p>Coba kata kunci atau kategori lain.</p></div>';
      return;
    }
    box.innerHTML = `
      <div class="grid">${d.items.map(p => `
        <article class="card">
          ${p.gambar ? `<img loading="lazy" src="/uploads/${esc(p.gambar)}" alt="">` : ''}
          <div class="card-body">
            <div>${badge(p)}</div>
            <h3>${esc(p.judul)}</h3>
            <p>${esc(p.isi)}</p>
            <div class="meta"><span>🕒 ${esc(p.dibuat)}</span><span>👁 ${p.dilihat}</span></div>
            <a class="btn sm" href="#/post/${p.id}">Baca selengkapnya</a>
          </div>
        </article>`).join('')}
      </div>
      <div class="pagination">${Array.from({ length: d.totalPages }, (_, i) =>
        `<button data-p="${i + 1}" class="${i + 1 === d.page ? 'active' : ''}">${i + 1}</button>`).join('')}
      </div>`;

    box.querySelectorAll('.pagination button').forEach(b => b.onclick = () => {
      state.page = +b.dataset.p;
      loadList();
      window.scrollTo(0, 0);
    });
  }

  /* ---------- Detail pengumuman ---------- */
  async function pageDetail(id) {
    const p = await api('/api/posts/' + id);
    app.innerHTML = `
      <div class="panel detail">
        <a href="#/">← Kembali</a>
        <div style="margin-top:14px">${badge(p)}</div>
        <h1 style="margin:10px 0">${esc(p.judul)}</h1>
        <div class="meta" style="justify-content:flex-start;gap:18px">
          <span>🕒 ${esc(p.dibuat)}</span>
          ${p.diubah ? `<span>✏️ Diubah ${esc(p.diubah)}</span>` : ''}
          <span>👁 ${p.dilihat} dilihat</span>
        </div>
        ${p.gambar ? `<img src="/uploads/${esc(p.gambar)}" alt="">` : ''}
        <div class="isi">${esc(p.isi)}</div>
        <div style="margin-top:22px;display:flex;gap:8px">
          <button class="btn gray sm" id="copy">🔗 Salin tautan</button>
          <button class="btn gray sm" onclick="window.print()">🖨 Cetak</button>
        </div>
      </div>`;
    $('#copy').onclick = () =>
      navigator.clipboard.writeText(location.href).then(() => toast('Tautan disalin!'));
  }

  /* ---------- Login admin ---------- */
  function pageLogin() {
    if (me) return go('#/admin');
    app.innerHTML = `
      <div class="panel" style="max-width:420px;margin:60px auto">
        <h2>🔐 Login Admin</h2>
        <form id="lf">
          <label>Username</label>
          <input id="u" required autofocus autocomplete="username">
          <label>Password</label>
          <input id="pw" type="password" required autocomplete="current-password">
          <div class="check"><input type="checkbox" id="sp"><label for="sp">Tampilkan password</label></div>
          <button class="btn" style="margin-top:18px;width:100%">Masuk</button>
        </form>
      </div>`;
    $('#sp').onchange = e => { $('#pw').type = e.target.checked ? 'text' : 'password'; };
    $('#lf').onsubmit = async e => {
      e.preventDefault();
      try {
        const d = await api('/api/login', 'POST', { username: $('#u').value, password: $('#pw').value });
        me = d.admin;
        toast('Login berhasil. Selamat datang!');
        go('#/admin');
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  /* ---------- Dashboard admin ---------- */
  async function pageDash() {
    if (!me) { toast('Silakan login terlebih dahulu', 'error'); return go('#/login'); }
    const d = await api('/api/admin/posts');
    app.innerHTML = `
      <h2 style="margin-top:28px">Dashboard Admin</h2>
      <div class="stats">
        <div class="stat"><small>Total Pengumuman</small><br><b>${d.total}</b></div>
        <div class="stat"><small>Disematkan</small><br><b>${d.pinned}</b></div>
        <div class="stat"><small>Total Dilihat</small><br><b>${d.views}</b></div>
      </div>
      <div class="panel" style="overflow-x:auto">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <h3>Kelola Pengumuman</h3>
          <a class="btn sm" href="#/admin/new">+ Tambah Baru</a>
        </div>
        <table>
          <tr><th>Judul</th><th>Kategori</th><th>Tanggal</th><th>Dilihat</th><th>Aksi</th></tr>
          ${d.items.map(p => `
            <tr>
              <td>${p.pinned ? '📌 ' : ''}<a href="#/post/${p.id}">${esc(p.judul)}</a></td>
              <td>${esc(p.kategori)}</td>
              <td>${esc(p.dibuat)}</td>
              <td>${p.dilihat}</td>
              <td style="display:flex;gap:6px">
                <a class="btn sm" href="#/admin/edit/${p.id}">Edit</a>
                <button class="btn sm danger" data-del="${p.id}">Hapus</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="5" class="empty">Belum ada data.</td></tr>'}
        </table>
      </div>`;

    app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Hapus pengumuman ini?')) return;
      try {
        await api('/api/posts/' + b.dataset.del, 'DELETE');
        toast('Pengumuman dihapus');
        pageDash();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  /* ---------- Form tambah / edit ---------- */
  async function pageForm(id) {
    if (!me) { toast('Silakan login terlebih dahulu', 'error'); return go('#/login'); }
    const p = id ? await api('/api/posts/' + id + '?nocount=1') : null;

    app.innerHTML = `
      <div class="panel" style="max-width:760px;margin:30px auto">
        <h2>${p ? 'Edit' : 'Tambah'} Pengumuman</h2>
        <form id="pf">
          <label>Judul</label>
          <input id="judul" maxlength="150" required value="${esc(p ? p.judul : '')}">
          <label>Kategori</label>
          <select id="kategori">
            ${KATEGORI.map(k => `<option ${p && p.kategori === k ? 'selected' : ''}>${k}</option>`).join('')}
          </select>
          <label>Isi Pengumuman <small id="count" style="color:var(--muted)"></small></label>
          <textarea id="isi" rows="9" required>${esc(p ? p.isi : '')}</textarea>
          <label>Gambar (opsional, maks 5 MB)</label>
          <input type="file" id="gambar" accept="image/png,image/jpeg,image/gif,image/webp">
          <img id="pv" style="max-width:240px;margin-top:10px;border-radius:10px;${p && p.gambar ? '' : 'display:none'}"
               ${p && p.gambar ? `src="/uploads/${esc(p.gambar)}"` : ''}>
          ${p && p.gambar ? '<div class="check"><input type="checkbox" id="hg"><label for="hg">Hapus gambar saat ini</label></div>' : ''}
          <div class="check">
            <input type="checkbox" id="pinned" ${p && p.pinned ? 'checked' : ''}>
            <label for="pinned">📌 Sematkan di atas</label>
          </div>
          <div style="margin-top:20px;display:flex;gap:10px">
            <button class="btn">Simpan</button>
            <a class="btn gray" href="#/admin">Batal</a>
          </div>
        </form>
      </div>`;

    const hitung = () => { $('#count').textContent = '(' + $('#isi').value.length + ' karakter)'; };
    $('#isi').oninput = hitung;
    hitung();

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
          judul: $('#judul').value,
          isi: $('#isi').value,
          kategori: $('#kategori').value,
          pinned: $('#pinned').checked,
          hapusGambar: !!($('#hg') && $('#hg').checked),
        };
        if (f) body.gambar = await readFile(f);
        await api(p ? '/api/posts/' + p.id : '/api/posts', p ? 'PUT' : 'POST', body);
        toast(p ? 'Pengumuman diperbarui' : 'Pengumuman dipublikasikan');
        go('#/admin');
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  /* ---------- Router ---------- */
  async function route() {
    const h = location.hash.slice(1) || '/';
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
    if (h !== '/') window.scrollTo(0, 0);
  }

  /* ---------- Mulai ---------- */
  async function init() {
    if (localStorage.getItem('tema') === 'dark') document.body.classList.add('dark');
    $('#year').textContent = new Date().getFullYear();
    window.addEventListener('hashchange', route);
    try { KATEGORI = (await api('/api/config')).kategori; } catch { /* abaikan */ }
    try { me = (await api('/api/me')).admin; } catch { /* abaikan */ }
    route();
  }
  init();
})();
