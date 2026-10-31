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
 *
 * 商品と価格は products テーブル（管理画面で編集）、容器代のルールは settings に保存する。
 * 会計ごとの明細は sale_items に「その時点の商品名・価格」で保存するので、
 * あとで価格を変えても過去の記録は変わらない。
 */

import { DEFAULT_RULE, DEFAULT_PRODUCTS, MAX_QTY, priceCart, describeItems } from '../public/pricing.js';

const DEFAULT_TARGET = 30000;

const PAYMENTS = ['現金', 'PayPay', 'd払い'];

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
      // 通信できるかの確認用（レジのオンライン／オフライン表示）。DB には触らない
      if (url.pathname === '/api/ping') return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
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
  if (route === 'GET /api/admin/sales') return json(await salesPage(db, url.searchParams));
  if (route === 'POST /api/admin/sales') {
    const body = await readJson(request);
    await recordSale(db, body, sess.staff);
    // オフライン再送（lite）のときは重い集計を返さない
    return json(body.lite ? { ok: true } : await registerData(db, sess));
  }
  // 取消／戻すを「状態を指定して」設定する（同じ操作を何度送っても結果は同じ）
  if (route === 'POST /api/admin/sales/set-cancel') {
    const body = await readJson(request);
    // 売上記録の全リセットより前に端末で行った操作は捨てる（リセットした記録を復活させない）
    if (body.epoch != null && Number(body.epoch) !== await getEpoch(db)) return json({ ok: true, stale: true });
    const row = body.clientId
      ? await db.prepare('SELECT * FROM sales WHERE client_id = ?').bind(String(body.clientId)).first()
      : await db.prepare('SELECT * FROM sales WHERE id = ?').bind(Number(body.id) || 0).first();
    if (!row) throw httpError('会計が見つかりません', 404);
    const want = body.cancelled ? 1 : 0;
    if (row.cancelled !== want) {
      await db.prepare('UPDATE sales SET cancelled = ? WHERE id = ?').bind(want, row.id).run();
      await audit(db, sess.staff, role, want ? '会計を取消' : '取消を戻す',
        `#${row.id} ${yen(row.amount)} ${row.payment}（担当 ${row.staff || '—'}）` + (body.offline ? '・オフライン操作' : ''));
    }
    return json({ ok: true, id: row.id, cancelled: want });
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

  if (route === 'POST /api/master/target') {
    const before = await getTarget(db);
    const n = await setTarget(db, await readJson(request));
    await audit(db, 'マスター', role, '目標金額を変更', `${yen(before)} → ${yen(n)}`);
    return json(await masterData(db, sess));
  }
  if (route === 'POST /api/master/products') {
    const body = await readJson(request);
    const { before, after } = await saveProduct(db, body);
    await audit(db, 'マスター', role, before ? '商品を変更' : '商品を追加', before ? productDiff(before, after) : productText(after));
    return json(await masterData(db, sess));
  }
  if (route === 'POST /api/master/container-rule') {
    const before = await getRule(db);
    const after = await saveRule(db, await readJson(request));
    await audit(db, 'マスター', role, '容器代のルールを変更', `${ruleText(before)} → ${ruleText(after)}`);
    return json(await masterData(db, sess));
  }
  const pm = url.pathname.match(/^\/api\/master\/products\/(\d+)\/(move|delete)$/);
  if (request.method === 'POST' && pm) {
    const id = Number(pm[1]);
    const prod = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    if (!prod) throw httpError('商品が見つかりません', 404);
    if (pm[2] === 'delete') {
      const used = await db.prepare('SELECT COUNT(*) AS n FROM sale_items WHERE product_id = ?').bind(id).first();
      if (used.n > 0) throw httpError('販売の記録がある商品は削除できません。「販売中」を外して販売停止にしてください', 400);
      await db.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
      await audit(db, 'マスター', role, '商品を削除', prod.name);
    } else {
      const dir = Number((await readJson(request)).dir) < 0 ? -1 : 1;
      const list = (await db.prepare('SELECT id FROM products ORDER BY sort, id').all()).results.map((x) => x.id);
      const i = list.indexOf(id), j = i + dir;
      if (j >= 0 && j < list.length) {
        [list[i], list[j]] = [list[j], list[i]];
        await db.batch(list.map((pid, k) => db.prepare('UPDATE products SET sort = ? WHERE id = ?').bind(k + 1, pid)));
      }
    }
    return json(await masterData(db, sess));
  }
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
  // 売上記録の全リセット（テスト用）。確認の文字とマスターパスワードの再入力が必要
  if (route === 'POST /api/master/reset-sales') {
    const body = await readJson(request);
    if (String(body.confirm || '').trim() !== 'リセット') throw httpError('確認のため「リセット」と入力してください', 400);
    await login(request, env, role, body.password, 'マスターパスワードが違います');
    const before = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN cancelled = 0 THEN amount ELSE 0 END), 0) AS total,
        COALESCE(SUM(cancelled), 0) AS cancelled FROM sales`).first();
    const epoch = await getEpoch(db);
    await db.batch([
      db.prepare('DELETE FROM sale_items'),
      db.prepare('DELETE FROM sales'),
      db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('sales', 'sale_items')"),
      db.prepare("DELETE FROM audit WHERE action IN ('会計を取消', '取消を戻す', '今の価格と違う会計を記録')"),
      db.prepare("INSERT INTO settings (key, value) VALUES ('sales_epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(epoch + 1)),
    ]);
    await audit(db, 'マスター', role, '売上記録を全リセット',
      `会計 ${before.n} 件（うち取消 ${before.cancelled} 件・売上 ${yen(before.total)}）を削除`);
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
    db.prepare(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '本',
      sets TEXT NOT NULL,
      container INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      set_qty INTEGER NOT NULL,
      set_price INTEGER NOT NULL,
      count INTEGER NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items (sale_id)'),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS products_name ON products (name)'),
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
    await addColumn(db, "ALTER TABLE sales ADD COLUMN staff TEXT NOT NULL DEFAULT ''");
  }
  // 端末で付けた会計ID（オフライン会計の再送で二重登録しないため。同じ ID は 1 件として扱う）
  if (!cols.results.some((c) => c.name === 'client_id')) {
    await addColumn(db, 'ALTER TABLE sales ADD COLUMN client_id TEXT');
  }
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS sales_client_id ON sales (client_id)').run();
  // 初期商品の登録は最初の 1 回だけ。
  // 同時に何件もリクエストが来ても、印（products_seeded）を書き込めた 1 件だけが登録する。
  // 商品名には一意制約も付けているので、万一重なっても同じ名前の商品はできない。
  const seeded = await db.prepare("INSERT INTO settings (key, value) VALUES ('products_seeded', '1') ON CONFLICT(key) DO NOTHING").run();
  if (seeded.meta.changes === 1) {
    const pc = await db.prepare('SELECT COUNT(*) AS n FROM products').first();
    if (pc.n === 0) {
      await db.batch(DEFAULT_PRODUCTS.map((p, i) => db.prepare(
        'INSERT OR IGNORE INTO products (name, unit, sets, container, active, sort) VALUES (?, ?, ?, ?, 1, ?)',
      ).bind(p.name, p.unit, JSON.stringify(p.sets), p.container ? 1 : 0, i + 1)));
    }
  }
  schemaReady = true;
}

// ===== 商品・容器代 =====
function rowToProduct(r) {
  return { id: r.id, name: r.name, unit: r.unit, sets: JSON.parse(r.sets), container: !!r.container, active: !!r.active, sort: r.sort };
}

async function getProducts(db, { all = false } = {}) {
  const rows = (await db.prepare(`SELECT * FROM products ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all()).results;
  return rows.map(rowToProduct);
}

async function getRule(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'container_rule'").first();
  return row ? { ...DEFAULT_RULE, ...JSON.parse(row.value) } : { ...DEFAULT_RULE };
}

function intIn(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(`${label}は${min}〜${max}の整数で入力してください`, 400);
  return n;
}

async function saveRule(db, body) {
  const rule = {
    freeUpTo: intIn(body.freeUpTo, 0, 999, '無料になる数'),
    per: intIn(body.per, 1, 999, '何個ごとか'),
    fee: intIn(body.fee, 0, 10000, '容器代の金額'),
  };
  await db.prepare("INSERT INTO settings (key, value) VALUES ('container_rule', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(rule)).run();
  return rule;
}

const ruleText = (r) => `${r.freeUpTo}個まで無料・${r.per}個ごとに${r.fee}円`;
const productText = (p) => `${p.name}：` + p.sets.map((s) => `${s.qty}${p.unit}${s.price}円`).join('・') +
  (p.container ? '（容器代対象）' : '') + (p.active ? '' : '（販売停止）');
function productDiff(a, b) {
  const t = productText(a), u = productText(b);
  return t === u ? u : `${t} → ${u}`;
}

async function saveProduct(db, body) {
  const name = cleanName(body.name).slice(0, 20);
  if (!name) throw httpError('商品名を入力してください', 400);
  const unit = cleanName(body.unit).slice(0, 4) || '個';
  if (!Array.isArray(body.sets) || body.sets.length === 0) throw httpError('価格を1つ以上入力してください', 400);
  if (body.sets.length > 8) throw httpError('セットは8種類までです', 400);
  const sets = body.sets.map((x) => ({
    qty: intIn(x.qty, 1, 99, 'セットの数量'),
    price: intIn(x.price, 0, 100000, '価格'),
  })).sort((a, b) => a.qty - b.qty);
  if (new Set(sets.map((x) => x.qty)).size !== sets.length) throw httpError('同じ数量のセットが重複しています', 400);
  if (sets[0].qty !== 1) throw httpError(`1${unit}の価格は必ず入力してください（どの数でも組めるようにするため）`, 400);
  const container = body.container ? 1 : 0;
  const active = body.active === false ? 0 : 1;
  const dup = await db.prepare('SELECT id FROM products WHERE name = ? AND id != ?').bind(name, Number(body.id) || 0).first();
  if (dup) throw httpError(`「${name}」という商品はすでにあります`, 400);

  let before = null;
  if (body.id) {
    const row = await db.prepare('SELECT * FROM products WHERE id = ?').bind(Number(body.id)).first();
    if (!row) throw httpError('商品が見つかりません', 404);
    before = rowToProduct(row);
    await db.prepare('UPDATE products SET name = ?, unit = ?, sets = ?, container = ?, active = ? WHERE id = ?')
      .bind(name, unit, JSON.stringify(sets), container, active, before.id).run();
  } else {
    const { m } = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM products').first();
    await db.prepare('INSERT INTO products (name, unit, sets, container, active, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(name, unit, JSON.stringify(sets), container, active, m + 1).run();
  }
  return { before, after: { name, unit, sets, container: !!container, active: !!active } };
}

/** 会計の行に明細（items と説明文）を付ける */
async function attachItems(db, sales) {
  if (!sales.length) return sales;
  const ids = sales.map((x) => x.id);
  const items = (await db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
    .bind(...ids).all()).results;
  return sales.map((x) => {
    let its = items.filter((i) => i.sale_id === x.id);
    // 商品管理を入れる前の古い記録（団子のみ）
    if (!its.length && (x.s1 || x.s3 || x.s5)) {
      its = [[1, 150, x.s1], [3, 400, x.s3], [5, 500, x.s5]].filter((a) => a[2] > 0)
        .map(([q, pr, c]) => ({ name: '団子', unit: '本', set_qty: q, set_price: pr, count: c, product_id: 0 }));
    }
    return { ...x, items: its, desc: describeItems(its) };
  });
}

/** 列の追加（同時に別のリクエストが追加済みでもエラーにしない） */
async function addColumn(db, sql) {
  try { await db.prepare(sql).run(); } catch (e) {
    if (!/duplicate column/i.test(String(e.message))) throw e;
  }
}

async function audit(db, actor, role, action, detail) {
  await db.prepare('INSERT INTO audit (at, actor, role, action, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), actor, role, action, detail || '').run();
}

/** 売上記録の世代番号（全リセットのたびに 1 増える） */
async function getEpoch(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'sales_epoch'").first();
  return row ? Number(row.value) : 1;
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
      COALESCE(SUM(sticks), 0) AS units
    FROM sales WHERE cancelled = 0`).first();
  // 商品ごと・セットごとの集計（その時点の商品名で）
  const packs = (await db.prepare(`SELECT si.product_id, MAX(si.name) AS name, MAX(si.unit) AS unit, si.set_qty, si.set_price, SUM(si.count) AS count
      FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.cancelled = 0
      GROUP BY si.product_id, si.set_qty, si.set_price`).all()).results;
  const products = await getProducts(db);
  const rule = await getRule(db);
  // 現在の商品の並び順で、売れていない商品も 0 で表示する
  const byProduct = products.map((p) => ({ id: p.id, name: p.name, unit: p.unit, qty: 0, amount: 0, packs: [] }));
  for (const k of packs) {
    let g = byProduct.find((b) => b.id === k.product_id);   // 名前を変えても同じ商品として数える
    if (!g) { g = { id: k.product_id, name: k.name, unit: k.unit, qty: 0, amount: 0, packs: [] }; byProduct.push(g); }
    g.qty += k.set_qty * k.count;
    g.amount += k.set_price * k.count;
    g.packs.push({ qty: k.set_qty, price: k.set_price, count: k.count });
  }
  byProduct.forEach((g) => g.packs.sort((a, b) => a.qty - b.qty || a.price - b.price));
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
    units: t.units,
    orders: t.orders,
    byProduct,
    products,
    rule,
    byPayment,
    payments: PAYMENTS,
    updatedAt: new Date().toISOString(),
  };
}

async function recentAudit(db, limit) {
  return (await db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').bind(limit).all()).results;
}

/** 会計一覧（新しい順・ページ送り）。取消済みも含む */
async function salesPage(db, params) {
  const limit = Math.min(100, Math.max(1, Math.floor(Number(params.get('limit')) || 50)));
  const before = Math.floor(Number(params.get('before')) || 0);
  const rows = (before > 0
    ? await db.prepare('SELECT * FROM sales WHERE id < ? ORDER BY id DESC LIMIT ?').bind(before, limit + 1).all()
    : await db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT ?').bind(limit + 1).all()).results;
  const counts = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(cancelled), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN cancelled = 0 THEN amount ELSE 0 END), 0) AS amount FROM sales`).first();
  return { sales: await attachItems(db, rows.slice(0, limit)), hasMore: rows.length > limit, ...counts };
}

async function registerData(db, sess) {
  const recent = await db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT 5').all();
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM sales').first();
  return {
    ...(await summary(db)),
    recent: await attachItems(db, recent.results),
    salesCount: n,
    epoch: await getEpoch(db),
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
    allProducts: await getProducts(db, { all: true }),
    allSales: await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cancelled), 0) AS cancelled FROM sales').first(),
    me: { expiresAt: sess.expires_at },
  };
}

async function recordSale(db, body, staff) {
  if (!PAYMENTS.includes(body.payment)) throw httpError('支払方法が不正です', 400);
  const clientId = body.clientId == null ? null : String(body.clientId).slice(0, 64);
  if (clientId && !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw httpError('会計IDが不正です', 400);
  // 売上記録の全リセットより前に端末で打った会計は捨てる（リセットした記録を復活させない）
  if (body.epoch != null && Number(body.epoch) !== await getEpoch(db)) return { stale: true };
  // 同じ会計ID がすでにあれば何もしない（再送による二重登録の防止）
  if (clientId && await db.prepare('SELECT id FROM sales WHERE client_id = ?').bind(clientId).first()) return { duplicate: true };

  const snapshot = Array.isArray(body.lines) ? body.lines : null;   // 端末で計算した明細（オフライン対応版の画面が送る）
  const all = await getProducts(db, { all: true });
  const rule = await getRule(db);
  // 個数からお客さんに有利なセットをサーバー側で組み直す（画面側の計算は信用しない）
  const cart = {};
  let unknown = false;
  for (const [pid, q] of Object.entries(body.items || {})) {
    const n = Math.floor(Number(q) || 0);
    if (n <= 0) continue;
    if (n > MAX_QTY) throw httpError(`1つの商品は一度に${MAX_QTY}個までです`, 400);
    const p = all.find((x) => String(x.id) === String(pid));
    if (!p || (!p.active && !snapshot)) {
      if (!snapshot) throw httpError('販売していない商品が含まれています。画面を更新しました', 409);
      unknown = true;
    }
    cart[pid] = n;
  }
  let priced = null;
  if (!unknown) {
    try { priced = priceCart(all, rule, cart); } catch (e) { if (!snapshot) throw httpError(e.message, 400); }
  }
  if (priced && !priced.lines.length) throw httpError('商品が選択されていません', 400);

  // 端末で表示・会計した内容が、今の価格と違うとき
  //   - 従来の画面（明細なし）: 記録せず 409 で確認を求める
  //   - オフライン対応の画面（明細あり）: お客さんから受け取った金額で記録し、操作の記録に残す
  let lines, goods, units, auto, mismatch = false;
  const sameAsServer = priced && snapshot && sameLines(priced, snapshot);
  if (priced && (!snapshot || sameAsServer)) {
    if (!snapshot && body.expectedGoods != null && Number(body.expectedGoods) !== priced.goods) {
      throw httpError('価格が変更されています。画面を更新したので、金額を確認してもう一度記録してください', 409);
    }
    lines = priced.lines.map((l) => ({ productId: l.product.id, name: l.product.name, unit: l.product.unit, packs: l.packs }));
    goods = priced.goods; units = priced.units; auto = priced.fee;
  } else {
    lines = validateSnapshot(snapshot);
    goods = lines.reduce((a, l) => a + l.packs.reduce((b, k) => b + k.price * k.count, 0), 0);
    units = lines.reduce((a, l) => a + l.packs.reduce((b, k) => b + k.qty * k.count, 0), 0);
    auto = intIn(body.containerAuto ?? 0, 0, 100000, '容器代');
    mismatch = true;
  }

  // 容器代は手動修正も可（未指定なら自動計算）
  const container = body.container == null || body.container === ''
    ? auto
    : Math.max(0, Math.floor(Number(body.container) || 0));

  // 会計の時刻: 端末で会計した時刻（オフライン中の会計を正しい時刻で残す）。不自然な値ならサーバーの時刻
  const now = Date.now();
  const t = Date.parse(body.createdAt);
  const createdAt = Number.isFinite(t) && t <= now + 5 * 60000 && t >= now - 7 * 86400000 ? new Date(t).toISOString() : new Date(now).toISOString();

  const cid = clientId || 'srv-' + b64url(crypto.getRandomValues(new Uint8Array(12)));
  // 会計と明細を 1 つのトランザクションで書く（明細は client_id で会計を引く）
  const stmts = [db.prepare(`INSERT INTO sales
      (created_at, sticks, goods, container, container_auto, amount, payment, staff, client_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(createdAt, units, goods, container, auto, goods + container, body.payment, staff, cid)];
  for (const l of lines) {
    for (const k of l.packs) {
      stmts.push(db.prepare(`INSERT INTO sale_items (sale_id, product_id, name, unit, set_qty, set_price, count)
          VALUES ((SELECT id FROM sales WHERE client_id = ?), ?, ?, ?, ?, ?, ?)`).bind(cid, l.productId, l.name, l.unit, k.qty, k.price, k.count));
    }
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    // 同じ会計ID が同時に届いた（もう一方が先に記録済み）
    if (clientId && /UNIQUE/i.test(String(e.message))) return { duplicate: true };
    throw e;
  }
  if (mismatch) {
    await audit(db, staff, 'register', '今の価格と違う会計を記録',
      `${describeItems(lines.flatMap((l) => l.packs.map((k) => ({ name: l.name, unit: l.unit, set_qty: k.qty, set_price: k.price, count: k.count }))))} ${yen(goods + container)}（端末で会計した金額のまま）`);
  }
  return { duplicate: false };
}

function sameLines(priced, snapshot) {
  const norm = (ls) => JSON.stringify(ls.map((l) => [String(l.productId), l.packs.map((k) => [k.qty, k.price, k.count])])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return norm(priced.lines.map((l) => ({ productId: l.product.id, packs: l.packs }))) === norm(snapshot.map((l) => ({
    productId: l.productId, packs: (l.packs || []).map((k) => ({ qty: Number(k.qty), price: Number(k.price), count: Number(k.count) })),
  })));
}

/** 端末から送られた明細の形と値をチェック */
function validateSnapshot(snapshot) {
  if (!snapshot || !snapshot.length || snapshot.length > 20) throw httpError('会計の明細が不正です', 400);
  return snapshot.map((l) => {
    const name = cleanName(l.name).slice(0, 20);
    if (!name || !Array.isArray(l.packs) || !l.packs.length || l.packs.length > 8) throw httpError('会計の明細が不正です', 400);
    const packs = l.packs.map((k) => ({
      qty: intIn(k.qty, 1, 99, 'セットの数量'),
      price: intIn(k.price, 0, 100000, '価格'),
      count: intIn(k.count, 1, MAX_QTY, '個数'),
    }));
    return { productId: Math.max(0, Math.floor(Number(l.productId) || 0)), name, unit: cleanName(l.unit).slice(0, 4) || '個', packs };
  });
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
  const sales = await attachItems(db, (await db.prepare('SELECT * FROM sales WHERE cancelled = 0 ORDER BY id').all()).results);
  // 商品ごとの数量の列（今の商品の並び＋過去にだけある商品名）
  const names = (await getProducts(db, { all: true })).map((p) => p.name);
  for (const x of sales) for (const it of x.items) if (!names.includes(it.name)) names.push(it.name);
  const qtyOf = (x, name) => x.items.filter((i) => i.name === name).reduce((a, i) => a + i.set_qty * i.count, 0);
  const header = ['ID', '日時', ...names.map((n) => n + '(数量)'), '内容', '商品代', '容器代', '容器代(自動計算)', '合計', '支払方法', '担当者'];
  const lines = [header].concat(sales.map((r) => [
    r.id, toJst(r.created_at), ...names.map((n) => qtyOf(r, n)), r.desc, r.goods, r.container, r.container_auto, r.amount, r.payment, r.staff,
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
