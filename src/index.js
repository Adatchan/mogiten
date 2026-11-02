/**
 * 模擬店（団子）売上ダッシュボード & かんたんレジ — Cloudflare Workers + D1
 *
 *   /            ダッシュボード（public/index.html・認証不要・集計のみ）
 *   /admin       レジ（public/admin.html・レジ用パスワード＋担当者名）
 *   /master      管理画面（public/master.html・マスターパスワード）
 *   /kitchen     キッチンの注文キュー（public/kitchen.html・レジ用パスワード）
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

import { DEFAULT_RULE, DEFAULT_PRODUCTS, MAX_QTY, priceCart, describeItems, itemsFromLines, withFlavors } from '../public/pricing.js';

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
  const csvName = request.method === 'GET' && url.pathname.match(/^\/api\/(?:admin|master)\/([a-z_]+\.csv)$/);
  if (csvName && CSV_FILES[csvName[1]]) return csvResponse(db, csvName[1], url.searchParams);
  if (route === 'GET /api/admin/sales') return json(await salesPage(db, url.searchParams));
  // キッチンの注文キュー（今日の注文。変化がなければ rev だけ返す）
  if (route === 'GET /api/admin/kitchen') return json(await kitchenData(db, url.searchParams));
  // キッチンで「できた」にする／戻す（状態を指定するので何度送っても同じ）
  if (route === 'POST /api/admin/kitchen/done') {
    const body = await readJson(request);
    const id = Math.floor(Number(body.id) || 0);
    const row = await db.prepare('SELECT id, kitchen_done_at FROM sales WHERE id = ?').bind(id).first();
    if (!row) throw httpError('注文が見つかりません', 404);
    const want = !!body.done;
    if (!!row.kitchen_done_at !== want) {
      await db.batch([
        db.prepare('UPDATE sales SET kitchen_done_at = ? WHERE id = ?').bind(want ? new Date().toISOString() : null, id),
        bumpRev(db),
      ]);
    }
    return json({ ok: true, id, done: want });
  }
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
      await db.batch([db.prepare('UPDATE sales SET cancelled = ? WHERE id = ?').bind(want, row.id), bumpRev(db)]);
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
    await db.batch([db.prepare('UPDATE sales SET cancelled = 1 - cancelled WHERE id = ?').bind(id), bumpRev(db)]);
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
  const csvName = request.method === 'GET' && url.pathname.match(/^\/api\/(?:admin|master)\/([a-z_]+\.csv)$/);
  if (csvName && CSV_FILES[csvName[1]]) return csvResponse(db, csvName[1], url.searchParams);

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
      db.prepare('DELETE FROM sale_flavors'),
      db.prepare('DELETE FROM sales'),
      db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('sales', 'sale_items', 'sale_flavors')"),
      bumpRev(db),
      db.prepare("DELETE FROM audit WHERE action IN ('会計を取消', '取消を戻す', '今の価格と違う会計を記録')"),
      db.prepare("INSERT INTO settings (key, value) VALUES ('sales_epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(epoch + 1)),
    ]);
    await audit(db, 'マスター', role, '売上記録を全リセット',
      `会計 ${before.n} 件（うち取消 ${before.cancelled} 件・売上 ${yen(before.total)}）を削除`);
    return json(await masterData(db, sess));
  }
  // 営業終了／再開（営業終了中はレジで新しい会計を記録できない）
  if (route === 'POST /api/master/closed') {
    const body = await readJson(request);
    if (body.closed) {
      const at = new Date().toISOString();
      await db.prepare("INSERT INTO settings (key, value) VALUES ('sales_closed_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(at).run();
      await audit(db, 'マスター', role, '営業終了', 'レジの会計の記録を停止');
    } else {
      await db.prepare("DELETE FROM settings WHERE key = 'sales_closed_at'").run();
      await audit(db, 'マスター', role, '営業再開', 'レジの会計の記録を再開');
    }
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
    // 味ごとの数（キッチンの注文キューと味ごとの集計用。味のない商品は flavor = ''）
    db.prepare(`CREATE TABLE IF NOT EXISTS sale_flavors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      flavor TEXT NOT NULL DEFAULT '',
      qty INTEGER NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS sale_flavors_sale ON sale_flavors (sale_id)'),
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
  // キッチンで「できた」にした時刻（null = まだ）
  if (!cols.results.some((c) => c.name === 'kitchen_done_at')) await addColumn(db, 'ALTER TABLE sales ADD COLUMN kitchen_done_at TEXT');
  await db.prepare('CREATE INDEX IF NOT EXISTS sales_created ON sales (created_at)').run();
  // 「○○のセットに含める」相手の商品（本数を合わせてセットを組む）
  const pcols = await db.prepare('PRAGMA table_info(products)').all();
  if (!pcols.results.some((c) => c.name === 'bundle_with')) await addColumn(db, 'ALTER TABLE products ADD COLUMN bundle_with INTEGER');
  // 味の一覧（JSON の配列。空なら味を選ばない商品）
  if (!pcols.results.some((c) => c.name === 'flavors')) await addColumn(db, "ALTER TABLE products ADD COLUMN flavors TEXT NOT NULL DEFAULT '[]'");
  // 混ぜたセットの組み方（例: 5本セット×1）。混ぜたセットの明細だけに入る
  const icols = await db.prepare('PRAGMA table_info(sale_items)').all();
  if (!icols.results.some((c) => c.name === 'pack_label')) await addColumn(db, 'ALTER TABLE sale_items ADD COLUMN pack_label TEXT');
  // 初期商品の登録は最初の 1 回だけ。
  // 同時に何件もリクエストが来ても、印（products_seeded）を書き込めた 1 件だけが登録する。
  // 商品名には一意制約も付けているので、万一重なっても同じ名前の商品はできない。
  const seeded = await db.prepare("INSERT INTO settings (key, value) VALUES ('products_seeded', '1') ON CONFLICT(key) DO NOTHING").run();
  if (seeded.meta.changes === 1) {
    const pc = await db.prepare('SELECT COUNT(*) AS n FROM products').first();
    if (pc.n === 0) {
      await db.batch(DEFAULT_PRODUCTS.map((p, i) => db.prepare(
        'INSERT OR IGNORE INTO products (name, unit, sets, container, active, sort, flavors) VALUES (?, ?, ?, ?, 1, ?, ?)',
      ).bind(p.name, p.unit, JSON.stringify(p.sets), p.container ? 1 : 0, i + 1, JSON.stringify(p.flavors || []))));
    }
  }
  schemaReady = true;
}

// ===== 商品・容器代 =====
function rowToProduct(r) {
  let flavors = [];
  try { flavors = JSON.parse(r.flavors || '[]'); } catch {}
  return { id: r.id, name: r.name, unit: r.unit, sets: JSON.parse(r.sets), container: !!r.container, active: !!r.active, sort: r.sort, bundleWith: r.bundle_with || null,
    flavors: Array.isArray(flavors) ? flavors : [] };
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
    maxCount: intIn(body.maxCount ?? 0, 0, 999, '容器の数の上限'),
  };
  await db.prepare("INSERT INTO settings (key, value) VALUES ('container_rule', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(rule)).run();
  return rule;
}

const ruleText = (r) => `${r.freeUpTo}個まで無料・${r.per}個ごとに${r.fee}円` + (r.maxCount > 0 ? `・最大${r.maxCount}個（${r.maxCount * r.fee}円）まで` : '・上限なし');
const productText = (p) => `${p.name}：` + p.sets.map((s) => `${s.qty}${p.unit}${s.price}円`).join('・') +
  ((p.flavors || []).length ? `（味：${p.flavors.join('・')}）` : '') + (p.container ? '（容器代対象）' : '') + (p.bundleWith ? `（${p.bundleName || '別の商品'}のセットに含める）` : '') + (p.active ? '' : '（販売停止）');
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
  const flavors = parseFlavors(body.flavors);
  const dup = await db.prepare('SELECT id FROM products WHERE name = ? AND id != ?').bind(name, Number(body.id) || 0).first();
  if (dup) throw httpError(`「${name}」という商品はすでにあります`, 400);
  // 「○○のセットに含める」：相手は自分以外で、相手自身はほかの商品のセットに含めていないこと（1 段だけ）
  let bundleWith = Number(body.bundleWith) || null;
  if (bundleWith) {
    const self = Number(body.id) || 0;
    if (bundleWith === self) throw httpError('自分自身のセットには含められません', 400);
    const leader = await db.prepare('SELECT id, name, bundle_with FROM products WHERE id = ?').bind(bundleWith).first();
    if (!leader) throw httpError('セットに含める相手の商品が見つかりません', 400);
    const leaderSets = JSON.parse((await db.prepare('SELECT sets FROM products WHERE id = ?').bind(bundleWith).first()).sets);
    // 相手が「ほかの商品のセットに含める」になっていたら不可（ただしセット価格のない相手への無効な設定は無視）
    if (leader.bundle_with) {
      const lt = await db.prepare('SELECT sets FROM products WHERE id = ?').bind(leader.bundle_with).first();
      if (lt && JSON.parse(lt.sets).some((x) => x.qty > 1)) throw httpError(`「${leader.name}」はほかの商品のセットに含めているので、相手にできません`, 400);
      await db.prepare('UPDATE products SET bundle_with = NULL WHERE id = ?').bind(bundleWith).run();   // 無効な設定を片付ける
    }
    if (!leaderSets.some((x) => x.qty > 1)) {
      throw httpError(`「${leader.name}」にはセット価格（2${unit}以上の価格）がないので、合わせて組む相手にできません。セット価格のある商品の側を相手に選んでください`, 400);
    }
    if (self) {
      const followers = await db.prepare('SELECT name FROM products WHERE bundle_with = ?').bind(self).first();
      if (followers) throw httpError(`「${followers.name}」がこの商品のセットに含まれているので、この商品をほかのセットには含められません`, 400);
    }
  }

  let before = null;
  if (body.id) {
    const row = await db.prepare('SELECT * FROM products WHERE id = ?').bind(Number(body.id)).first();
    if (!row) throw httpError('商品が見つかりません', 404);
    before = rowToProduct(row);
    await db.prepare('UPDATE products SET name = ?, unit = ?, sets = ?, container = ?, active = ?, bundle_with = ?, flavors = ? WHERE id = ?')
      .bind(name, unit, JSON.stringify(sets), container, active, bundleWith, JSON.stringify(flavors), before.id).run();
  } else {
    const { m } = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM products').first();
    await db.prepare('INSERT INTO products (name, unit, sets, container, active, sort, bundle_with, flavors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(name, unit, JSON.stringify(sets), container, active, m + 1, bundleWith, JSON.stringify(flavors)).run();
  }
  const leaderName = bundleWith ? (await db.prepare('SELECT name FROM products WHERE id = ?').bind(bundleWith).first()).name : null;
  if (before && before.bundleWith) before.bundleName = (await db.prepare('SELECT name FROM products WHERE id = ?').bind(before.bundleWith).first() || {}).name;
  return { before, after: { name, unit, sets, container: !!container, active: !!active, bundleWith, bundleName: leaderName, flavors } };
}

const MAX_FLAVORS = 12;
/** 味の一覧（配列、または「、」「,」・改行区切りの文字列）を整える。重複は 1 つに */
function parseFlavors(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[,、，\n]/);
  const out = [];
  for (const x of list) {
    const f = cleanName(x).slice(0, 12);
    if (f && !out.includes(f)) out.push(f);
  }
  if (out.length > MAX_FLAVORS) throw httpError(`味は${MAX_FLAVORS}種類までです`, 400);
  return out;
}

/** 会計の行に明細（items と説明文）を付ける */
async function attachItems(db, sales) {
  if (!sales.length) return sales;
  const ids = sales.map((x) => x.id);
  // D1 は 1 回の問い合わせに渡せる値が 100 個までなので、50 件ずつに分けて読む
  const items = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`)
      .bind(...chunk).all()).results;
    items.push(...rows);
  }
  const flavors = await flavorsOf(db, ids);
  return sales.map((x) => {
    let its = items.filter((i) => i.sale_id === x.id);
    // 商品管理を入れる前の古い記録（団子のみ）
    if (!its.length && (x.s1 || x.s3 || x.s5)) {
      its = [[1, 150, x.s1], [3, 400, x.s3], [5, 500, x.s5]].filter((a) => a[2] > 0)
        .map(([q, pr, c]) => ({ name: '団子', unit: '本', set_qty: q, set_price: pr, count: c, product_id: 0 }));
    }
    const fl = flavors.filter((f) => f.sale_id === x.id);
    return { ...x, items: its, flavors: fl, desc: withFlavors(describeItems(its), fl) };
  });
}

/** 会計 ID の一覧から味ごとの数を読む（50 件ずつ） */
async function flavorsOf(db, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await db.prepare(`SELECT * FROM sale_flavors WHERE sale_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`)
      .bind(...chunk).all()).results;
    out.push(...rows);
  }
  return out;
}

/** キッチンの注文キュー用の版番号（会計・取消・「できた」のたびに 1 増える）。db.batch に入れて使う */
function bumpRev(db) {
  return db.prepare(`INSERT INTO settings (key, value) VALUES ('kitchen_rev', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`);
}

async function getRev(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'kitchen_rev'").first();
  return row ? Number(row.value) : 0;
}

/**
 * キッチンの注文キュー：今日（日本時間）の注文を、サーバーに届いた順に。
 * 端末が持っている rev と日付が今と同じなら、注文は返さない（数秒ごとに読まれるので軽くする）。
 */
async function kitchenData(db, params) {
  const day = jstDay();
  const rev = await getRev(db);
  const closed = await getClosed(db);
  if (params.get('rev') === String(rev) && params.get('day') === day.date) return { rev, day: day.date, same: true, closed };
  const sales = (await db.prepare(`SELECT id, created_at, cancelled, kitchen_done_at, staff FROM sales
      WHERE created_at >= ? AND created_at < ? ORDER BY id`).bind(day.start, day.end).all()).results;
  const fl = (await db.prepare(`SELECT sf.sale_id, sf.product_id, sf.name, sf.unit, sf.flavor, sf.qty FROM sale_flavors sf
      JOIN sales s ON s.id = sf.sale_id WHERE s.created_at >= ? AND s.created_at < ? ORDER BY sf.id`).bind(day.start, day.end).all()).results;
  // 味の記録がない古い会計は、明細（sale_items）から商品ごとの数を出す
  const withFl = new Set(fl.map((f) => f.sale_id));
  const old = sales.filter((x) => !withFl.has(x.id));
  let items = [];
  if (old.length) {
    items = (await db.prepare(`SELECT si.sale_id, si.product_id, si.name, si.unit, si.set_qty * si.count AS qty FROM sale_items si
        JOIN sales s ON s.id = si.sale_id WHERE s.created_at >= ? AND s.created_at < ? ORDER BY si.id`).bind(day.start, day.end).all()).results;
  }
  const products = await getProducts(db, { all: true });
  const orders = sales.map((x) => {
    let lines = fl.filter((f) => f.sale_id === x.id);
    if (!lines.length) {
      const by = new Map();
      for (const it of items) {
        if (it.sale_id !== x.id) continue;
        const g = by.get(it.product_id) || { product_id: it.product_id, name: it.name, unit: it.unit, flavor: '', qty: 0 };
        g.qty += it.qty;
        by.set(it.product_id, g);
      }
      lines = [...by.values()];
    }
    return {
      id: x.id, createdAt: x.created_at, cancelled: !!x.cancelled, doneAt: x.kitchen_done_at || null, staff: x.staff,
      lines: lines.map((l) => ({ productId: l.product_id, name: l.name, unit: l.unit, flavor: l.flavor, qty: l.qty })),
    };
  });
  return {
    rev, day: day.date, closed, orders,
    // 味の並び順（管理画面で決めた順）
    products: products.map((p) => ({ id: p.id, name: p.name, unit: p.unit, flavors: p.flavors })),
  };
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
/** 営業終了の状態（管理画面で設定）。null なら営業中 */
async function getClosed(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'sales_closed_at'").first();
  return row && row.value ? { at: row.value } : null;
}

async function getEpoch(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'sales_epoch'").first();
  return row ? Number(row.value) : 1;
}

async function getTarget(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'target'").first();
  return row ? Number(row.value) : DEFAULT_TARGET;
}

// 営業時間（日本時間）。1時間ごとの売上はこの範囲で集計する
const OPEN_HOUR = 9;
const CLOSE_HOUR = 19;

/** 今日（日本時間）の日付と、その範囲（UTC の ISO 文字列） */
function jstDay() {
  const JST = 9 * 3600000;
  const nowJst = new Date(Date.now() + JST);
  const y = nowJst.getUTCFullYear(), m = nowJst.getUTCMonth(), d = nowJst.getUTCDate();
  const start = new Date(Date.UTC(y, m, d) - JST);
  return {
    date: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    start: start.toISOString(),
    end: new Date(start.getTime() + 86400000).toISOString(),
  };
}

/** 今日（日本時間）の 1 時間ごとの売上（取消を除く）。営業時間外の会計はまとめて outside に入れる */
async function hourlySales(db) {
  const JST = 9 * 3600000;
  const nowJst = new Date(Date.now() + JST);
  const y = nowJst.getUTCFullYear(), m = nowJst.getUTCMonth(), d = nowJst.getUTCDate();
  const start = new Date(Date.UTC(y, m, d) - JST);
  const end = new Date(start.getTime() + 86400000);
  const rows = (await db.prepare('SELECT created_at, amount FROM sales WHERE cancelled = 0 AND created_at >= ? AND created_at < ?')
    .bind(start.toISOString(), end.toISOString()).all()).results;
  const buckets = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) buckets.push({ hour: h, amount: 0, orders: 0 });
  const outside = { amount: 0, orders: 0 };
  for (const r of rows) {
    const h = new Date(Date.parse(r.created_at) + JST).getUTCHours();
    const b = buckets.find((x) => x.hour === h) || outside;
    b.amount += r.amount;
    b.orders += 1;
  }
  return {
    date: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    open: OPEN_HOUR, close: CLOSE_HOUR,
    nowHour: nowJst.getUTCHours(),
    buckets, outside,
  };
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
  const packs = (await db.prepare(`SELECT si.product_id, MAX(si.name) AS name, MAX(si.unit) AS unit, si.set_qty, si.set_price, SUM(si.count) AS count,
        (si.pack_label IS NOT NULL) AS mixed
      FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.cancelled = 0
      GROUP BY si.product_id, si.set_qty, si.set_price, (si.pack_label IS NOT NULL)`).all()).results;
  const products = await getProducts(db);
  const rule = await getRule(db);
  // 現在の商品の並び順で、売れていない商品も 0 で表示する
  const byProduct = products.map((p) => ({ id: p.id, name: p.name, unit: p.unit, qty: 0, amount: 0, packs: [], mixedQty: 0 }));
  for (const k of packs) {
    let g = byProduct.find((b) => b.id === k.product_id);   // 名前を変えても同じ商品として数える
    if (!g) { g = { id: k.product_id, name: k.name, unit: k.unit, qty: 0, amount: 0, packs: [], mixedQty: 0 }; byProduct.push(g); }
    g.qty += k.set_qty * k.count;
    g.amount += k.set_price * k.count;
    if (k.mixed) g.mixedQty += k.set_qty * k.count;   // ほかの商品と混ぜたセットの分（セットごとの個数には数えない）
    else g.packs.push({ qty: k.set_qty, price: k.set_price, count: k.count });
  }
  byProduct.forEach((g) => g.packs.sort((a, b) => a.qty - b.qty || a.price - b.price));
  // 味ごとの数（今の味の並び順。味の指定なし（''）は最後）
  const fl = (await db.prepare(`SELECT sf.product_id, sf.flavor, SUM(sf.qty) AS qty
      FROM sale_flavors sf JOIN sales s ON s.id = sf.sale_id WHERE s.cancelled = 0
      GROUP BY sf.product_id, sf.flavor`).all()).results;
  for (const g of byProduct) {
    const cur = products.find((p) => p.id === g.id);
    const order = cur ? cur.flavors : [];
    const rows = fl.filter((f) => f.product_id === g.id);
    if (!order.length && !rows.some((r) => r.flavor)) { g.flavors = []; continue; }
    const list = order.map((f) => ({ flavor: f, qty: 0 }));
    for (const r of rows) {
      const x = list.find((y) => y.flavor === r.flavor);
      if (x) x.qty += r.qty; else list.push({ flavor: r.flavor, qty: r.qty });
    }
    list.sort((a, b) => (a.flavor === '' ? 1 : 0) - (b.flavor === '' ? 1 : 0));
    g.flavors = list;
  }
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
    avgPerOrder: t.orders > 0 ? Math.round(t.total / t.orders) : 0,   // 客単価（取消を除く）
    closed: await getClosed(db),   // 営業終了中なら { at }
    hourly: await hourlySales(db),
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
  // 営業終了後に打った会計は受け付けない（終了前に端末で打って、あとから届いた未送信の会計は受け付ける）
  const closed = await getClosed(db);
  if (closed) {
    const t = Date.parse(body.createdAt);
    if (!Number.isFinite(t) || t >= Date.parse(closed.at)) throw httpError('営業は終了しました。会計は記録できません', 423);
  }
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
    // レジの画面と同じく「販売中の商品＋この会計に入っている商品」で組む（販売停止の相手とはまとめない）
    try { priced = priceCart(all.filter((p) => p.active || cart[p.id]), rule, cart); } catch (e) { if (!snapshot) throw httpError(e.message, 400); }
  }
  if (priced && !priced.lines.length) throw httpError('商品が選択されていません', 400);

  // 味ごとの数（{ 商品ID: { 味: 数 } }）。合計が商品の数と合わないものは受け付けない。
  // 味の一覧はあとで変わることがあるので、届いた味の名前のまま記録する。味がない商品は flavor = ''
  const flavorRows = [];
  const sentFlavors = body.flavors && typeof body.flavors === 'object' ? body.flavors : {};
  const snapMembers = (snapshot || []).flatMap((l) => (Array.isArray(l.members) && l.members.length ? l.members : [l]));
  for (const [pid, n] of Object.entries(cart)) {
    const p = all.find((x) => String(x.id) === String(pid));
    const sm = snapMembers.find((m) => String(m.productId) === String(pid)) || {};
    const name = p ? p.name : cleanName(sm.name).slice(0, 20) || '商品';
    const unit = p ? p.unit : cleanName(sm.unit).slice(0, 4) || '個';
    const productId = p ? p.id : Math.max(0, Math.floor(Number(pid) || 0));
    const f = sentFlavors[pid];
    if (f && typeof f === 'object' && Object.keys(f).length) {
      const entries = Object.entries(f);
      if (entries.length > 30) throw httpError('味の指定が不正です', 400);
      let sum = 0;
      for (const [flavor, q] of entries) {
        const qn = Math.floor(Number(q) || 0);
        if (qn <= 0) continue;
        const fname = cleanName(flavor).slice(0, 12);
        if (!fname) throw httpError('味の指定が不正です', 400);
        sum += qn;
        flavorRows.push({ productId, name, unit, flavor: fname, qty: qn });
      }
      if (sum !== n) throw httpError(`${name}の味ごとの数（${sum}）と合計（${n}）が合いません`, 400);
    } else {
      flavorRows.push({ productId, name, unit, flavor: '', qty: n });
    }
  }

  // 端末で表示・会計した内容が、今の価格と違うとき
  //   - 従来の画面（明細なし）: 記録せず 409 で確認を求める
  //   - オフライン対応の画面（明細あり）: お客さんから受け取った金額で記録し、操作の記録に残す
  let lines, goods, units, auto, mismatch = false;
  const sameAsServer = priced && snapshot && sameLines(priced, snapshot);
  if (priced && (!snapshot || sameAsServer)) {
    if (!snapshot && body.expectedGoods != null && Number(body.expectedGoods) !== priced.goods) {
      throw httpError('価格が変更されています。画面を更新したので、金額を確認してもう一度記録してください', 409);
    }
    lines = priced.lines;
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
  const items = itemsFromLines(lines);
  for (const it of items) {
    stmts.push(db.prepare(`INSERT INTO sale_items (sale_id, product_id, name, unit, set_qty, set_price, count, pack_label)
        VALUES ((SELECT id FROM sales WHERE client_id = ?), ?, ?, ?, ?, ?, ?, ?)`)
      .bind(cid, it.product_id, it.name, it.unit, it.set_qty, it.set_price, it.count, it.pack_label));
  }
  for (const f of flavorRows) {
    stmts.push(db.prepare(`INSERT INTO sale_flavors (sale_id, product_id, name, unit, flavor, qty)
        VALUES ((SELECT id FROM sales WHERE client_id = ?), ?, ?, ?, ?, ?)`)
      .bind(cid, f.productId, f.name, f.unit, f.flavor, f.qty));
  }
  stmts.push(bumpRev(db));
  try {
    await db.batch(stmts);
  } catch (e) {
    // 同じ会計ID が同時に届いた（もう一方が先に記録済み）
    if (clientId && /UNIQUE/i.test(String(e.message))) return { duplicate: true };
    throw e;
  }
  if (mismatch) {
    await audit(db, staff, 'register', '今の価格と違う会計を記録',
      `${withFlavors(describeItems(items), flavorRows)} ${yen(goods + container)}（端末で会計した金額のまま）`);
  }
  return { duplicate: false };
}

function sameLines(priced, snapshot) {
  // セットの組み方と、商品ごとの数（混ぜたセットの内訳）が同じか
  const norm = (ls) => JSON.stringify(ls.map((l) => [
    String(l.productId),
    l.packs.map((k) => [Number(k.qty), Number(k.price), Number(k.count)]),
    (l.members || []).map((m) => [String(m.productId), Number(m.qty)]).sort(),
  ]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return norm(priced.lines.map((l) => ({ productId: l.product.id, packs: l.packs, members: l.members.map((m) => ({ productId: m.product.id, qty: m.qty })) })))
    === norm(snapshot.map((l) => ({ productId: l.productId, packs: l.packs || [], members: l.members || [{ productId: l.productId, qty: (l.packs || []).reduce((a, k) => a + k.qty * k.count, 0) }] })));
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
    const product = { id: Math.max(0, Math.floor(Number(l.productId) || 0)), name, unit: cleanName(l.unit).slice(0, 4) || '個' };
    const total = packs.reduce((a, k) => a + k.qty * k.count, 0);
    // 混ぜたセットの内訳（商品ごとの数）。合計がセットの数と合わなければ不正
    let members = [{ product, qty: total }];
    if (Array.isArray(l.members) && l.members.length) {
      if (l.members.length > 8) throw httpError('会計の明細が不正です', 400);
      members = l.members.map((m) => ({
        product: { id: Math.max(0, Math.floor(Number(m.productId) || 0)), name: cleanName(m.name).slice(0, 20) || name, unit: cleanName(m.unit).slice(0, 4) || product.unit },
        qty: intIn(m.qty, 1, MAX_QTY, '個数'),
      }));
      if (members.reduce((a, m) => a + m.qty, 0) !== total) throw httpError('会計の明細が不正です', 400);
    }
    return { product, packs, members };
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

/** 日本時間の ISO 8601（例: 2026-11-02T11:48:26+09:00） */
function isoJst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 19) + '+09:00';
}

// ===== CSV（機械判読に配慮した形式。定義は docs/csv-spec.md） =====
//   sales.csv       会計（1 行 = 1 会計）
//   sale_items.csv  明細（1 行 = 1 会計 × 1 商品 × 1 味。縦持ち）
//   sale_packs.csv  セットの内訳（1 行 = 1 会計 × 1 商品 × 1 セットの種類）
// 共通: 1 行目が項目名（英数字の物理名）、2 行目からデータ。UTF-8（BOM 付き。?bom=0 で BOM なし）、改行 CRLF。
//       金額は円の整数、日時は ISO 8601（+09:00）。取り消した会計は含めない。
const CSV_FILES = {
  'sales.csv': salesCsvRows,
  'sale_items.csv': saleItemsCsvRows,
  'sale_packs.csv': salePacksCsvRows,
};

async function csvResponse(db, name, params) {
  const sales = await attachItems(db, (await db.prepare('SELECT * FROM sales WHERE cancelled = 0 ORDER BY id').all()).results);
  const rows = CSV_FILES[name](sales);
  const body = rows.map((cols) => cols.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const stamp = isoJst(new Date().toISOString()).slice(0, 16).replace(/[-:T]/g, '');
  const bom = params.get('bom') === '0' ? '' : '﻿';   // Excel で文字化けしないよう既定は BOM 付き
  return new Response(bom + body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8; header=present',
      'content-disposition': `attachment; filename="mogiten_${name.replace('.csv', '')}_${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

/** 1 つの値を CSV のセルに（RFC 4180。カンマ・ダブルクォート・改行を含むときだけ囲む） */
function csvCell(c) {
  if (c == null) return '';
  let s = String(c);
  // 文字列が = + - @ で始まると Excel が数式として実行するので、先頭に ' を付ける（数値は対象外）
  if (typeof c === 'string' && /^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const businessDate = (iso) => isoJst(iso).slice(0, 10);

function salesCsvRows(sales) {
  const header = ['sale_id', 'sold_at', 'business_date', 'payment_method', 'item_quantity',
    'goods_amount_yen', 'container_fee_yen', 'container_fee_auto_yen', 'total_amount_yen', 'staff_name', 'kitchen_done_at'];
  return [header].concat(sales.map((r) => [
    r.id, isoJst(r.created_at), businessDate(r.created_at), r.payment, r.sticks,
    r.goods, r.container, r.container_auto, r.amount, r.staff, r.kitchen_done_at ? isoJst(r.kitchen_done_at) : null,
  ]));
}

function saleItemsCsvRows(sales) {
  const header = ['sale_id', 'sold_at', 'business_date', 'product_id', 'product_name', 'flavor', 'quantity', 'unit_name'];
  const rows = [header];
  for (const r of sales) {
    let lines = r.flavors.map((f) => ({ product_id: f.product_id, name: f.name, unit: f.unit, flavor: f.flavor, qty: f.qty }));
    if (!lines.length) {
      // 味の記録がない古い会計：セットの明細から商品ごとの数を出す（味は空）
      const by = new Map();
      for (const it of r.items) {
        const g = by.get(it.product_id + '\u0000' + it.name) || { product_id: it.product_id, name: it.name, unit: it.unit, flavor: '', qty: 0 };
        g.qty += it.set_qty * it.count;
        by.set(it.product_id + '\u0000' + it.name, g);
      }
      lines = [...by.values()];
    }
    for (const l of lines) rows.push([r.id, isoJst(r.created_at), businessDate(r.created_at), l.product_id || null, l.name, l.flavor || null, l.qty, l.unit]);
  }
  return rows;
}

function salePacksCsvRows(sales) {
  const header = ['sale_id', 'sold_at', 'business_date', 'product_id', 'product_name', 'pack_size', 'pack_price_yen', 'pack_count', 'amount_yen', 'unit_name', 'is_mixed_pack', 'mixed_pack_label'];
  const rows = [header];
  for (const r of sales) {
    for (const it of r.items) {
      rows.push([r.id, isoJst(r.created_at), businessDate(r.created_at), it.product_id || null, it.name, it.set_qty, it.set_price, it.count,
        it.set_price * it.count, it.unit, it.pack_label ? 1 : 0, it.pack_label || null]);
    }
  }
  return rows;
}
