/**
 * 模擬店（団子）売上ダッシュボード & かんたんレジ — Cloudflare Workers + D1
 *
 *   /            ダッシュボード（public/index.html・認証不要）
 *   /admin       レジ（public/admin.html・簡易パスワード）
 *   /api/...     この Worker が処理する API
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      await ensureSchema(env.DB);
      const route = request.method + ' ' + url.pathname;

      // ---- 公開 API ----
      if (route === 'GET /api/summary') return json(await summary(env.DB));
      if (route === 'GET /api/sales.csv') return csv(await env.DB.prepare('SELECT * FROM sales ORDER BY id').all());

      // ---- 管理 API（パスワード必須） ----
      if (url.pathname.startsWith('/api/admin/')) {
        if (!env.ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD が設定されていません' }, 500);
        if (request.headers.get('X-Password') !== env.ADMIN_PASSWORD) return json({ error: 'パスワードが違います' }, 401);

        if (route === 'GET /api/admin/data') return json(await adminData(env.DB));
        if (route === 'POST /api/admin/sales') return json(await recordSale(env.DB, await request.json()));
        if (route === 'POST /api/admin/target') return json(await setTarget(env.DB, await request.json()));
        const m = url.pathname.match(/^\/api\/admin\/sales\/(\d+)\/toggle-cancel$/);
        if (request.method === 'POST' && m) {
          await env.DB.prepare('UPDATE sales SET cancelled = 1 - cancelled WHERE id = ?').bind(Number(m[1])).run();
          return json(await adminData(env.DB));
        }
      }
      return json({ error: 'Not Found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },
};

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
      cancelled INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
  ]);
  schemaReady = true;
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

async function adminData(db) {
  const recent = await db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT 15').all();
  return { ...(await summary(db)), recent: recent.results };
}

async function recordSale(db, body) {
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
      (created_at, s1, s3, s5, sticks, goods, container, container_auto, amount, payment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(new Date().toISOString(), counts.s1, counts.s3, counts.s5, sticks, goods, container, auto, goods + container, body.payment)
    .run();
  return adminData(db);
}

async function setTarget(db, body) {
  const n = Math.floor(Number(body.target));
  if (!(n > 0)) throw httpError('目標金額が不正です', 400);
  await db.prepare("INSERT INTO settings (key, value) VALUES ('target', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(String(n)).run();
  return adminData(db);
}

// ===== レスポンス =====
function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function toJst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function csv({ results }) {
  const header = ['ID', '日時', '1本セット', '3本セット', '5本セット', '本数', '商品代', '容器代', '容器代(自動計算)', '合計', '支払方法', '取消'];
  const lines = [header].concat(results.map((r) => [
    r.id, toJst(r.created_at), r.s1, r.s3, r.s5, r.sticks, r.goods, r.container, r.container_auto, r.amount, r.payment, r.cancelled ? '取消' : '',
  ]));
  const body = lines.map((cols) => cols.map((c) => {
    const s = String(c);
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
