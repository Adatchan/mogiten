/**
 * 模擬店（団子）売上ダッシュボード & かんたんレジ — Cloudflare Workers + D1
 *
 *   /            ダッシュボード（public/index.html・認証不要・集計のみ）
 *   /admin       レジ（public/admin.html・レジ用パスワード＋担当者名）
 *   /master      管理画面（public/master.html・マスターパスワード）
 *   /api/...     この Worker が処理する API
 *
 * 認証のしくみ
 *   - ログインに成功するとランダムなセッショントークンを発行し、HttpOnly Cookie に入れる
 *     （パスワード自体は端末に保存しない）。DB にはトークンの SHA-256 だけを保存する。
 *   - パスワードは PBKDF2 でハッシュ化して D1 に保存する。まだ一度も変更していないときは
 *     secret（ADMIN_PASSWORD / MASTER_PASSWORD）と照合する。
 *   - 同じ接続元から 10 分間に 5 回ログインに失敗すると、しばらくログインできなくする。
 *   - 取消・目標変更・パスワード変更・締め出しなどの操作は audit テーブルに記録する。
 */

const DEFAULT_TARGET = 30000;

// セット: 本数と価格（admin.html の SETS と合わせる）
const SETS = [
  { key: 's1', sticks: 1, price: 150 },
  { key: 's3', sticks: 3, price: 400 },
  { key: 's5', sticks: 5, price: 500 },
];
const PAYMENTS = ['現金', 'PayPay', 'd払い'];

/** 容器代: 1〜2本 0円 / 3〜4本 10円 / 5〜8本 20円 / 以降4本ごとに +10円 */
function containerFee(sticks) {
  return sticks < 3 ? 0 : Math.ceil(sticks / 4) * 10;
}

// ログインの種類ごとの設定
const ROLES = {
  register: { label: 'レジ', cookie: 'mogiten_reg', path: '/api/admin', ttl: 3 * 24 * 3600, secret: 'ADMIN_PASSWORD' },
  master: { label: 'マスター', cookie: 'mogiten_master', path: '/api/master', ttl: 12 * 3600, secret: 'MASTER_PASSWORD' },
};
const MAX_FAILS = 5;          // この回数失敗したら
const LOCK_MINUTES = 10;      // この時間ログインできない
const MIN_PASSWORD = 8;       // 新しいパスワードの最低文字数
const PBKDF2_ITER = 100000;   // Workers の上限

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      await ensureSchema(env.DB);
      const route = request.method + ' ' + url.pathname;

      // 別サイトからの書き込みリクエストを拒否（Cookie の SameSite=Strict に加えて念のため）
      if (request.method !== 'GET') {
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin) return json({ error: '不正なリクエストです' }, 403);
      }

      if (route === 'GET /api/summary') return json(await summary(env.DB));
      if (url.pathname.startsWith('/api/admin/')) return await registerApi(request, env, url, route);
      if (url.pathname.startsWith('/api/master/')) return await masterApi(request, env, url, route);
      return json({ error: 'Not Found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500, e.headers);
    }
  },
};

// ===== レジ API =====
async function registerApi(request, env, url, route) {
  const db = env.DB;
  const role = 'register';

  if (route === 'POST /api/admin/login') {
    const body = await readJson(request);
    const staff = cleanName(body.staff);
    if (!staff) throw httpError('担当者名を入力してください', 400);
    await login(request, env, role, body.password);
    const sess = await createSession(request, db, role, staff);
    await audit(db, staff, role, 'ログイン', sess.device);
    return json(await registerData(db, sess.row), 200, { 'Set-Cookie': sess.cookie });
  }
  if (route === 'POST /api/admin/logout') return logout(request, db, role);

  const sess = await requireSession(request, db, role);

  if (route === 'GET /api/admin/data') return json(await registerData(db, sess));
  if (route === 'GET /api/admin/sales.csv') return csv(db);
  if (route === 'POST /api/admin/sales') {
    await recordSale(db, await readJson(request), sess.staff);
    return json(await registerData(db, sess));
  }
  if (route === 'POST /api/admin/target') {
    const n = await setTarget(db, await readJson(request));
    await audit(db, sess.staff, role, '目標金額を変更', yen(n));
    return json(await registerData(db, sess));
  }
  const m = url.pathname.match(/^\/api\/admin\/sales\/(\d+)\/toggle-cancel$/);
  if (request.method === 'POST' && m) {
    const id = Number(m[1]);
    const row = await db.prepare('SELECT * FROM sales WHERE id = ?').bind(id).first();
    if (!row) throw httpError('会計が見つかりません', 404);
    await db.prepare('UPDATE sales SET cancelled = 1 - cancelled WHERE id = ?').bind(id).run();
    await audit(db, sess.staff, role, row.cancelled ? '取消を戻す' : '会計を取消', `#${id} ${yen(row.amount)} ${row.payment}（担当 ${row.staff || '—'}）`);
    return json(await registerData(db, sess));
  }
  return json({ error: 'Not Found' }, 404);
}

// ===== 管理（マスター）API =====
async function masterApi(request, env, url, route) {
  const db = env.DB;
  const role = 'master';

  if (route === 'POST /api/master/login') {
    const body = await readJson(request);
    await login(request, env, role, body.password);
    const sess = await createSession(request, db, role, 'マスター');
    await audit(db, 'マスター', role, 'ログイン', sess.device);
    return json(await masterData(db, sess.row), 200, { 'Set-Cookie': sess.cookie });
  }
  if (route === 'POST /api/master/logout') return logout(request, db, role);

  const sess = await requireSession(request, db, role);

  if (route === 'GET /api/master/data') return json(await masterData(db, sess));
  if (route === 'GET /api/master/sales.csv') return csv(db);

  if (route === 'POST /api/master/register-password') {
    const body = await readJson(request);
    await setPassword(db, 'register', body.next);
    let detail = '';
    if (body.revokeAll) {
      const n = await revokeWhere(db, "role = 'register'");
      detail = `レジ端末 ${n} 台を締め出し`;
    }
    await audit(db, 'マスター', role, 'レジのパスワードを変更', detail);
    return json(await masterData(db, sess));
  }
  if (route === 'POST /api/master/master-password') {
    const body = await readJson(request);
    await login(request, env, role, body.current, '現在のマスターパスワードが違います');
    await setPassword(db, 'master', body.next);
    // 他の端末のマスターログインは無効にする
    await revokeWhere(db, "role = 'master' AND id != ?", sess.id);
    await audit(db, 'マスター', role, 'マスターパスワードを変更', '他の端末のマスターログインを解除');
    return json(await masterData(db, sess));
  }
  if (route === 'POST /api/master/revoke-all') {
    const body = await readJson(request);
    let n, what;
    if (body.target === 'master') {
      n = await revokeWhere(db, "role = 'master' AND id != ?", sess.id);
      what = `ほかのマスター端末 ${n} 台`;
    } else {
      n = await revokeWhere(db, "role = 'register'");
      what = `レジ端末 ${n} 台`;
    }
    await audit(db, 'マスター', role, '締め出し', what);
    return json(await masterData(db, sess));
  }
  if (route === 'POST /api/master/unlock') {
    const res = await db.prepare('DELETE FROM login_failures').run();
    await audit(db, 'マスター', role, 'ログイン制限を解除', `失敗記録 ${res.meta.changes || 0} 件を消去`);
    return json(await masterData(db, sess));
  }
  const m = url.pathname.match(/^\/api\/master\/sessions\/(\d+)\/revoke$/);
  if (request.method === 'POST' && m) {
    const id = Number(m[1]);
    if (id === sess.id) throw httpError('自分自身は締め出せません。ログアウトを使ってください', 400);
    const row = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
    if (!row) throw httpError('端末が見つかりません', 404);
    await revokeWhere(db, 'id = ?', id);
    await audit(db, 'マスター', role, '締め出し', `${ROLES[row.role].label}：${row.staff}（${row.device}）`);
    return json(await masterData(db, sess));
  }
  return json({ error: 'Not Found' }, 404);
}

// ===== 認証 =====

/** パスワードを照合する。失敗回数の制限つき。失敗したら例外を投げる */
async function login(request, env, role, password, wrongMessage) {
  const db = env.DB;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();
  const since = new Date(now - LOCK_MINUTES * 60000).toISOString();

  // 直近 LOCK_MINUTES 分の失敗が MAX_FAILS 回以上ならロック中
  const nth = await db.prepare(`SELECT at FROM login_failures WHERE ip = ? AND role = ? AND at > ?
    ORDER BY at DESC LIMIT 1 OFFSET ?`).bind(ip, role, since, MAX_FAILS - 1).first();
  if (nth) {
    const mins = Math.max(1, Math.ceil((new Date(nth.at).getTime() + LOCK_MINUTES * 60000 - now) / 60000));
    throw httpError(`ログインに続けて失敗したため、あと約${mins}分はログインできません`, 429);
  }

  if (await verifyPassword(env, role, String(password || ''))) {
    await db.batch([
      db.prepare('DELETE FROM login_failures WHERE ip = ? AND role = ?').bind(ip, role),
      db.prepare('DELETE FROM login_failures WHERE at < ?').bind(new Date(now - 86400000).toISOString()),
    ]);
    return;
  }

  await db.prepare('INSERT INTO login_failures (ip, role, at) VALUES (?, ?, ?)').bind(ip, role, new Date(now).toISOString()).run();
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND role = ? AND at > ?')
    .bind(ip, role, since).first();
  await audit(db, '—', role, 'ログイン失敗', `${ROLES[role].label}（${n}回目）`);
  const left = MAX_FAILS - n;
  throw httpError((wrongMessage || 'パスワードが違います') +
    (left > 0 ? `（あと${left}回間違えると${LOCK_MINUTES}分間ログインできなくなります）` : `（${LOCK_MINUTES}分間ログインできません）`), 401);
}

async function verifyPassword(env, role, password) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(role + '_pw_hash').first();
  if (row) return verifyHash(password, row.value);
  // まだ画面から変更していないときは secret と照合
  const initial = env[ROLES[role].secret];
  if (!initial) throw httpError(`${ROLES[role].secret} が設定されていません`, 500);
  return safeEqual(await sha256(password), await sha256(initial));
}

async function setPassword(db, role, next) {
  next = String(next || '');
  if (next.length < MIN_PASSWORD) throw httpError(`新しいパスワードは${MIN_PASSWORD}文字以上にしてください`, 400);
  if (next.length > 200) throw httpError('パスワードが長すぎます', 400);
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(role + '_pw_hash', await hashPassword(next)).run();
}

async function createSession(request, db, role, staff) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  const expires = new Date(now.getTime() + ROLES[role].ttl * 1000);
  const device = deviceName(request.headers.get('User-Agent') || '');
  const res = await db.prepare(`INSERT INTO sessions (token_hash, role, staff, device, created_at, last_seen, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    
    .bind(hex(await sha256(token)), role, staff, device, now.toISOString(), now.toISOString(), expires.toISOString()).run();
  // 古いセッションの掃除
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date(now.getTime() - 7 * 86400000).toISOString()).run();
  const row = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(res.meta.last_row_id).first();
  return { row, device, cookie: cookieHeader(role, token, ROLES[role].ttl) };
}

async function getSession(request, db, role) {
  const token = readCookie(request, ROLES[role].cookie);
  if (!token) return null;
  const now = new Date().toISOString();
  const row = await db.prepare(`SELECT * FROM sessions WHERE token_hash = ? AND role = ? AND revoked = 0 AND expires_at > ?`)
    
    .bind(hex(await sha256(token)), role, now).first();
  if (!row) return null;
  // 最終利用時刻は 1 分に 1 回だけ更新
  if (Date.parse(now) - Date.parse(row.last_seen) > 60000) {
    await db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').bind(now, row.id).run();
  }
  return row;
}

async function requireSession(request, db, role) {
  const sess = await getSession(request, db, role);
  if (!sess) {
    throw httpError('ログインしてください（締め出されたか、期限が切れました）', 401, { 'Set-Cookie': cookieHeader(role, '', 0) });
  }
  return sess;
}

async function logout(request, db, role) {
  const sess = await getSession(request, db, role);
  if (sess) {
    await revokeWhere(db, 'id = ?', sess.id);
    await audit(db, sess.staff, role, 'ログアウト', sess.device);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(role, '', 0) });
}

async function revokeWhere(db, where, ...binds) {
  const res = await db.prepare(`UPDATE sessions SET revoked = 1 WHERE revoked = 0 AND expires_at > ? AND ${where}`)
    .bind(new Date().toISOString(), ...binds).run();
  return res.meta.changes || 0;
}

function cookieHeader(role, token, maxAge) {
  const r = ROLES[role];
  return `${r.cookie}=${token}; Path=${r.path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function deviceName(ua) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '不明な端末';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} / ${br}` : os;
}

// ===== パスワードのハッシュ =====
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(hash)}`;
}

async function verifyHash(password, stored) {
  const [kind, iter, salt, hash] = String(stored).split('$');
  if (kind !== 'pbkdf2') return false;
  const actual = await pbkdf2(password, unb64url(salt), Number(iter));
  return safeEqual(actual, unb64url(hash));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes) {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// ===== DB =====
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      s1 INTEGER NOT NULL DEFAULT 0,
      s3 INTEGER NOT NULL DEFAULT 0,
      s5 INTEGER NOT NULL DEFAULT 0,
      sticks INTEGER NOT NULL,
      goods INTEGER NOT NULL,
      container INTEGER NOT NULL,
      container_auto INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      payment TEXT NOT NULL,
      cancelled INTEGER NOT NULL DEFAULT 0,
      staff TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      staff TEXT NOT NULL,
      device TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      role TEXT NOT NULL,
      at TEXT NOT NULL
    )`),
  ]);
  // 担当者名の列（後から追加したので、古いテーブルには ALTER で足す）
  const cols = await db.prepare('PRAGMA table_info(sales)').all();
  if (!cols.results.some((c) => c.name === 'staff')) {
    await db.prepare("ALTER TABLE sales ADD COLUMN staff TEXT NOT NULL DEFAULT ''").run();
  }
  schemaReady = true;
}

async function audit(db, actor, role, action, detail) {
  await db.prepare('INSERT INTO audit (at, actor, role, action, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), actor, role, action, detail || '').run();
}

async function getTarget(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'target'").first();
  return row ? Number(row.value) : DEFAULT_TARGET;
}

async function summary(db) {
  const t = await db.prepare(`SELECT
      COUNT(*) AS orders,
      COALESCE(SUM(amount), 0) AS total,
      COALESCE(SUM(goods), 0) AS goods,
      COALESCE(SUM(container), 0) AS container,
      COALESCE(SUM(sticks), 0) AS sticks,
      COALESCE(SUM(s1), 0) AS s1,
      COALESCE(SUM(s3), 0) AS s3,
      COALESCE(SUM(s5), 0) AS s5
    FROM sales WHERE cancelled = 0`).first();
  const pays = await db.prepare(`SELECT payment, COUNT(*) AS count, SUM(amount) AS amount
    FROM sales WHERE cancelled = 0 GROUP BY payment`).all();

  const byPayment = {};
  PAYMENTS.forEach((p) => (byPayment[p] = { amount: 0, count: 0 }));
  pays.results.forEach((r) => (byPayment[r.payment] = { amount: r.amount, count: r.count }));

  const target = await getTarget(db);
  return {
    total: t.total,
    goods: t.goods,
    container: t.container,
    target,
    remaining: Math.max(0, target - t.total),
    rate: target > 0 ? t.total / target : 0,
    sticks: t.sticks,
    orders: t.orders,
    sets: { s1: t.s1, s3: t.s3, s5: t.s5 },
    setDefs: SETS.map((x) => ({ ...x, fee: containerFee(x.sticks) })),
    byPayment,
    payments: PAYMENTS,
    updatedAt: new Date().toISOString(),
  };
}

async function recentAudit(db, limit) {
  return (await db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').bind(limit).all()).results;
}

async function registerData(db, sess) {
  const recent = await db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT 15').all();
  return {
    ...(await summary(db)),
    recent: recent.results,
    audit: await recentAudit(db, 30),
    me: { staff: sess.staff, expiresAt: sess.expires_at },
  };
}

async function masterData(db, sess) {
  const sessions = await db.prepare(`SELECT id, role, staff, device, created_at, last_seen, expires_at FROM sessions
      WHERE revoked = 0 AND expires_at > ? ORDER BY role, last_seen DESC`).bind(new Date().toISOString()).all();
  const pw = await db.prepare("SELECT key FROM settings WHERE key IN ('register_pw_hash', 'master_pw_hash')").all();
  const changed = pw.results.map((r) => r.key);
  const locks = await db.prepare(`SELECT role, COUNT(*) AS n FROM login_failures WHERE at > ? GROUP BY ip, role HAVING n >= ?`)
    .bind(new Date(Date.now() - LOCK_MINUTES * 60000).toISOString(), MAX_FAILS).all();
  return {
    ...(await summary(db)),
    sessions: sessions.results.map((s) => ({ ...s, current: s.id === sess.id })),
    audit: await recentAudit(db, 200),
    passwords: {
      registerChanged: changed.includes('register_pw_hash'),
      masterChanged: changed.includes('master_pw_hash'),
    },
    locked: locks.results.map((l) => ROLES[l.role].label),
    me: { expiresAt: sess.expires_at },
  };
}

async function recordSale(db, body, staff) {
  if (!PAYMENTS.includes(body.payment)) throw httpError('支払方法が不正です', 400);
  const counts = {};
  let sticks = 0, goods = 0;
  for (const s of SETS) {
    const n = Math.max(0, Math.floor(Number(body[s.key]) || 0));
    counts[s.key] = n;
    sticks += n * s.sticks;
    goods += n * s.price;
  }
  if (goods <= 0) throw httpError('商品が選択されていません', 400);

  const auto = containerFee(sticks);
  // 容器代は手動修正も可（未指定なら自動計算）
  const container = body.container == null || body.container === ''
    ? auto
    : Math.max(0, Math.floor(Number(body.container) || 0));

  await db.prepare(`INSERT INTO sales
      (created_at, s1, s3, s5, sticks, goods, container, container_auto, amount, payment, staff)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(new Date().toISOString(), counts.s1, counts.s3, counts.s5, sticks, goods, container, auto, goods + container, body.payment, staff)
    .run();
}

async function setTarget(db, body) {
  const n = Math.floor(Number(body.target));
  if (!(n > 0)) throw httpError('目標金額が不正です', 400);
  await db.prepare("INSERT INTO settings (key, value) VALUES ('target', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(String(n)).run();
  return n;
}

// ===== ユーティリティ =====
function httpError(message, status, headers) {
  return Object.assign(new Error(message), { status, headers });
}

async function readJson(request) {
  try { return await request.json(); } catch { throw httpError('リクエストが不正です', 400); }
}

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30);
}

const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function toJst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** 売上明細 CSV（取り消した会計は含めない） */
async function csv(db) {
  const { results } = await db.prepare('SELECT * FROM sales WHERE cancelled = 0 ORDER BY id').all();
  const header = ['ID', '日時', '1本セット', '3本セット', '5本セット', '本数', '商品代', '容器代', '容器代(自動計算)', '合計', '支払方法', '担当者'];
  const lines = [header].concat(results.map((r) => [
    r.id, toJst(r.created_at), r.s1, r.s3, r.s5, r.sticks, r.goods, r.container, r.container_auto, r.amount, r.payment, r.staff,
  ]));
  const body = lines.map((cols) => cols.map((c) => {
    let s = String(c);
    if (/^[=+\-@]/.test(s) && typeof c === 'string') s = "'" + s; // Excel の数式として解釈させない
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
  const stamp = toJst(new Date().toISOString()).replace(/[-: ]/g, '').slice(0, 12);
  // 先頭に BOM を付けて Excel でも文字化けしないようにする
  return new Response('﻿' + body + '\r\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dango_sales_${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
