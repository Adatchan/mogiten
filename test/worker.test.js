/**
 * サーバー（src/index.js）のテスト：本物の Worker を Miniflare で動かし、一時的な D1 を使う。
 *   - 移行：催し（プロジェクト）を入れる前の本番と同じ形のデータが、正しく「26岡山大学祭」にまとまるか
 *   - 催し：複製・切り替え・会計番号・リセット・削除
 *   - 会計の記録：サーバー側の料金計算、二重記録の防止、容器代・支払方法の設定
 *   npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, tempDir, cleanup } from './helpers.js';

const iso = (s) => new Date(s).toISOString();
const nowIso = () => new Date().toISOString();
let seq = 0;
const cid = () => `test-${Date.now().toString(36)}-${(seq++).toString(36)}-xxxx`;

/**
 * 催しを入れる前（2026年の学祭のとき）の本番と同じ形のテーブルとデータを作る。
 * Worker がまだ一度もリクエストを受けていない（＝移行前の）状態で呼ぶ。
 */
async function seedLegacy(w) {
  const stmts = [
    `CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, s1 INTEGER NOT NULL DEFAULT 0, s3 INTEGER NOT NULL DEFAULT 0,
      s5 INTEGER NOT NULL DEFAULT 0, sticks INTEGER NOT NULL, goods INTEGER NOT NULL, container INTEGER NOT NULL, container_auto INTEGER NOT NULL,
      amount INTEGER NOT NULL, payment TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, staff TEXT NOT NULL DEFAULT '', client_id TEXT, kitchen_done_at TEXT)`,
    `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '本', sets TEXT NOT NULL,
      container INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, bundle_with INTEGER, flavors TEXT NOT NULL DEFAULT '[]')`,
    `CREATE TABLE sale_items (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, product_id INTEGER NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
      set_qty INTEGER NOT NULL, set_price INTEGER NOT NULL, count INTEGER NOT NULL, pack_label TEXT)`,
    `CREATE TABLE sale_flavors (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, product_id INTEGER NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
      flavor TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL)`,
    `CREATE UNIQUE INDEX products_name ON products (name)`,
    `CREATE UNIQUE INDEX sales_client_id ON sales (client_id)`,
    `INSERT INTO settings (key, value) VALUES ('target', '92563'), ('container_rule', '{"freeUpTo":4,"per":4,"fee":10,"maxCount":1}'),
      ('sales_closed_at', '2026-11-02T04:16:51.641Z'), ('sales_epoch', '3'), ('kitchen_rev', '13'), ('products_seeded', '1')`,
    `INSERT INTO products (id, name, unit, sets, container, active, sort, bundle_with, flavors) VALUES
      (1, '団子', '本', '[{"qty":1,"price":150},{"qty":3,"price":400},{"qty":5,"price":500}]', 1, 1, 1, NULL, '["みたらし","あんこ"]'),
      (2, '焼きマシュマロ', '本', '[{"qty":1,"price":150}]', 0, 1, 2, 1, '[]')`,
    // #1 団子4本（みたらし3・あんこ1）・現金・キッチンでできた
    `INSERT INTO sales (id, created_at, sticks, goods, container, container_auto, amount, payment, staff, client_id, kitchen_done_at)
      VALUES (1, '${iso('2026-11-01T01:00:00Z')}', 4, 550, 10, 10, 560, '現金', '学祭太郎', 'legacy-0001', '${iso('2026-11-01T01:05:00Z')}')`,
    `INSERT INTO sale_items (sale_id, product_id, name, unit, set_qty, set_price, count, pack_label) VALUES (1, 1, '団子', '本', 3, 400, 1, NULL), (1, 1, '団子', '本', 1, 150, 1, NULL)`,
    `INSERT INTO sale_flavors (sale_id, product_id, name, unit, flavor, qty) VALUES (1, 1, '団子', '本', 'みたらし', 3), (1, 1, '団子', '本', 'あんこ', 1)`,
    // #2 団子3本＋焼きマシュマロ2本の混ぜたセット・PayPay
    `INSERT INTO sales (id, created_at, sticks, goods, container, container_auto, amount, payment, staff, client_id)
      VALUES (2, '${iso('2026-11-01T02:00:00Z')}', 5, 500, 10, 10, 510, 'PayPay', '学祭太郎', 'legacy-0002')`,
    `INSERT INTO sale_items (sale_id, product_id, name, unit, set_qty, set_price, count, pack_label) VALUES
      (2, 1, '団子', '本', 3, 300, 1, '5本セット×1'), (2, 2, '焼きマシュマロ', '本', 2, 200, 1, '5本セット×1')`,
    `INSERT INTO sale_flavors (sale_id, product_id, name, unit, flavor, qty) VALUES (2, 1, '団子', '本', 'あんこ', 3), (2, 2, '焼きマシュマロ', '本', '', 2)`,
    // #3 取り消した会計
    `INSERT INTO sales (id, created_at, sticks, goods, container, container_auto, amount, payment, cancelled, staff, client_id)
      VALUES (3, '${iso('2026-11-02T03:00:00Z')}', 1, 150, 0, 0, 150, 'd払い', 1, '学祭太郎', 'legacy-0003')`,
    `INSERT INTO sale_items (sale_id, product_id, name, unit, set_qty, set_price, count, pack_label) VALUES (3, 1, '団子', '本', 1, 150, 1, NULL)`,
    // #4 商品管理を入れる前のいちばん古い形（明細なし・s3 だけ）
    `INSERT INTO sales (id, created_at, s1, s3, s5, sticks, goods, container, container_auto, amount, payment)
      VALUES (4, '${iso('2026-11-02T04:00:00Z')}', 0, 1, 0, 3, 400, 10, 10, 410, '現金')`,
  ];
  for (const sql of stmts) await w.db.prepare(sql).run();
}
const LEGACY = { orders: 3, total: 560 + 510 + 410, cancelled: 1 };

describe('移行：催しを入れる前のデータ', () => {
  let dir, w;
  before(async () => {
    dir = tempDir();
    w = await startWorker(dir);
    await seedLegacy(w);
  });
  after(async () => { await w?.dispose(); cleanup(dir); });

  test('最初のリクエストで「26岡山大学祭」ができ、これまでの設定を引き継ぐ', async () => {
    const r = await w.api('/api/summary');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [p] = await w.query('SELECT * FROM projects');
    assert.equal(p.id, 1);
    assert.equal(p.name, '26岡山大学祭');
    assert.equal(p.shop_name, '混声合唱と学祭のための 団子');
    assert.equal(p.start_date, '2026-11-01');   // 最初の会計の日（日本時間）
    assert.equal(p.end_date, '2026-11-02');     // 最後の会計の日
    assert.equal(p.open_hour, 9);
    assert.equal(p.close_hour, 19);
    assert.equal(p.target, 92563);
    assert.deepEqual(JSON.parse(p.container_rule), { freeUpTo: 4, per: 4, fee: 10, maxCount: 1 });
    assert.equal(p.closed_at, '2026-11-02T04:16:51.641Z');
    assert.equal(p.epoch, 3);
    assert.equal(p.kitchen_rev, 13);
    const [active] = await w.query("SELECT value FROM settings WHERE key = 'active_project'");
    assert.equal(active.value, '1');
  });

  test('会計と商品はすべて催し #1 に入り、会計番号はこれまでの番号のまま', async () => {
    const sales = await w.query('SELECT id, project_id, order_no FROM sales ORDER BY id');
    assert.equal(sales.length, 4);
    for (const s of sales) {
      assert.equal(s.project_id, 1);
      assert.equal(s.order_no, s.id);
    }
    const products = await w.query('SELECT id, project_id FROM products');
    assert.deepEqual(products.map((p) => p.project_id), [1, 1]);
  });

  test('集計は移行前と同じ（取消を除く）', async () => {
    const d = (await w.api('/api/summary')).body;
    assert.equal(d.project.name, '26岡山大学祭');
    assert.equal(d.total, LEGACY.total);
    assert.equal(d.orders, LEGACY.orders);
    assert.equal(d.target, 92563);
    assert.ok(d.closed);
    assert.deepEqual(d.rule, { enabled: true, freeUpTo: 4, per: 4, fee: 10, maxCount: 1 });   // enabled は「取る」として補う
    assert.deepEqual(d.payMethods, ['現金', 'PayPay', 'd払い']);
    const dango = d.byProduct.find((g) => g.name === '団子');
    assert.deepEqual(dango.flavors, [{ flavor: 'みたらし', qty: 3 }, { flavor: 'あんこ', qty: 1 + 3 }]);   // #1 と #2（取消の #3 は味の記録なし）
  });

  test('商品名の重複チェックが催しごとになる（古いインデックスは消える）', async () => {
    const idx = (await w.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'products'")).map((x) => x.name);
    assert.ok(!idx.includes('products_name'), idx.join(','));
    assert.ok(idx.includes('products_project_name'), idx.join(','));
  });

  test('何度起動し直しても同じ結果（催しが増えたり値が変わったりしない）', async () => {
    const before = await w.query('SELECT * FROM projects');
    const salesBefore = await w.query('SELECT id, project_id, order_no FROM sales ORDER BY id');
    await w.dispose();
    w = await startWorker(dir);   // 同じ D1 で起動し直す（移行がもう一度走る）
    await w.api('/api/summary');
    await w.dispose();
    w = await startWorker(dir);
    await w.api('/api/summary');
    assert.deepEqual(await w.query('SELECT * FROM projects'), before);
    assert.deepEqual(await w.query('SELECT id, project_id, order_no FROM sales ORDER BY id'), salesBefore);
  });

  test('移行した会計が CSV に出る（会計番号・味・混ぜたセット・いちばん古い形の会計）', async () => {
    await w.loginRegister();
    const csv = (await w.api('/api/admin/sales.csv', { role: 'register' })).body;
    const rows = csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.match(rows[0], /^sale_id,project_id,order_no,/);
    assert.equal(rows.length, 1 + LEGACY.orders);   // 取消は含めない
    const items = (await w.api('/api/admin/sale_items.csv', { role: 'register' })).body;
    assert.match(items, /,1,団子,みたらし,3,本/);
    assert.match(items, /,2,焼きマシュマロ,,2,本/);
    const ja = (await w.api('/api/admin/sales_ja.csv', { role: 'register' })).body;
    assert.match(ja, /\r\n4,2026\/11\/02,13:00:00,現金,,/);   // #4 いちばん古い形（担当者なし）
  });

  test('移行後の会計は続きの番号（#5）で催し #1 に記録される', async () => {
    await w.loginMaster();
    const re = await w.api('/api/master/closed', { body: { closed: false }, role: 'master' });
    assert.equal(re.status, 200);
    const r = await w.api('/api/admin/sales', { role: 'register', body: { lite: true, clientId: cid(), createdAt: nowIso(), items: { 1: 1 }, flavors: { 1: { みたらし: 1 } }, payment: '現金' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [s] = await w.query('SELECT project_id, order_no, amount FROM sales ORDER BY id DESC LIMIT 1');
    assert.deepEqual(s, { project_id: 1, order_no: 5, amount: 150 });
  });

  test('移行前の世代（epoch）の未送信の会計は捨てる／今の世代なら受け付ける', async () => {
    const stale = await w.api('/api/admin/sales', { role: 'register', body: { lite: true, epoch: 2, clientId: cid(), createdAt: nowIso(), items: { 1: 1 }, payment: '現金' } });
    assert.equal(stale.status, 200);
    const ok = await w.api('/api/admin/sales', { role: 'register', body: { lite: true, epoch: 3, projectId: 1, clientId: cid(), createdAt: nowIso(), items: { 1: 1 }, payment: '現金' } });
    assert.equal(ok.status, 200);
    const [{ n }] = await w.query('SELECT COUNT(*) AS n FROM sales');
    assert.equal(n, 6);   // 4（移行前）＋ #5 ＋ 今の世代の 1 件
  });

  test('ダッシュボード：ほかの日の 1 時間ごとの売上（取消を除く・日本時間で区切る）と、選べる日', async () => {
    const hour = (d, h) => d.buckets.find((b) => b.hour === h);
    const d1 = (await w.api('/api/hourly?date=2026-11-01')).body;
    assert.equal(d1.date, '2026-11-01');
    assert.equal(d1.today, false);
    assert.equal(d1.nowHour, null);                       // 今日でなければ「集計中」の時間帯はない
    assert.deepEqual([d1.open, d1.close], [9, 19]);
    assert.deepEqual(hour(d1, 10), { hour: 10, amount: 560, orders: 1 });   // 01:00Z = 10時
    assert.deepEqual(hour(d1, 11), { hour: 11, amount: 510, orders: 1 });
    const d2 = (await w.api('/api/hourly?date=2026-11-02')).body;
    assert.equal(hour(d2, 12).orders, 0);                 // 12時の会計は取消済み
    assert.deepEqual(hour(d2, 13), { hour: 13, amount: 410, orders: 1 });
    assert.equal((await w.api('/api/hourly?date=2026-10-31')).body.buckets.every((b) => b.orders === 0), true);

    for (const bad of ['', '2026-11', '2026-02-30', 'x', '2026-11-01T00:00']) {
      assert.equal((await w.api('/api/hourly?date=' + encodeURIComponent(bad))).status, 400, bad);
    }

    const s = (await w.api('/api/summary')).body;
    const today = s.hourly.date;
    assert.equal(s.hourly.today, true);
    assert.equal(typeof s.hourly.nowHour, 'number');
    assert.deepEqual(s.hourlyDays.slice(0, 2), ['2026-11-01', '2026-11-02']);   // 催しの期間・会計のある日（古い順）
    assert.equal(s.hourlyDays.at(-1), today);                                  // 今日はいつも入る
    assert.equal(new Set(s.hourlyDays).size, s.hourlyDays.length);
  });
});

describe('新しく作った環境', () => {
  let dir, w;
  before(async () => { dir = tempDir(); w = await startWorker(dir); });
  after(async () => { await w?.dispose(); cleanup(dir); });

  test('空の「最初の催し」が 1 つでき、商品は入らない（団子の初期商品はない）', async () => {
    const d = (await w.api('/api/summary')).body;
    assert.equal(d.project.name, '最初の催し');
    assert.equal(d.products.length, 0);
    assert.equal(d.total, 0);
    const projects = await w.query('SELECT * FROM projects');
    assert.equal(projects.length, 1);
  });
});

describe('催し（プロジェクト）', () => {
  let dir, w;
  before(async () => {
    dir = tempDir();
    w = await startWorker(dir);
    await seedLegacy(w);
    await w.api('/api/summary');
    await w.loginMaster();
    await w.loginRegister();
    await w.api('/api/master/closed', { body: { closed: false }, role: 'master' });
  });
  after(async () => { await w?.dispose(); cleanup(dir); });

  const master = (path, body, project) => w.api('/api/master/' + path, { body, role: 'master', headers: project ? { 'X-Project': String(project) } : {} });
  const sale = (body) => w.api('/api/admin/sales', { role: 'register', body: { lite: true, clientId: cid(), createdAt: nowIso(), payment: '現金', ...body } });

  test('入力のチェック', async () => {
    assert.equal((await master('projects', { name: '', startDate: '2027-11-01', endDate: '2027-11-01' })).status, 400);
    assert.equal((await master('projects', { name: 'x', startDate: '2027-11-03', endDate: '2027-11-01' })).status, 400);
    assert.equal((await master('projects', { name: 'x', startDate: '2027-11-01', endDate: '2027-11-01', openHour: 10, closeHour: 10 })).status, 400);
    assert.equal((await master('projects', { name: 'x', startDate: '2027-13-01', endDate: '2027-13-01' })).status, 400);
  });

  let p2;
  test('前の催しから複製：商品・味・「セットに含める」の相手・容器代のルール・目標・支払方法', async () => {
    await master('payments', { payments: ['現金', 'PayPay', '交通系IC'] }, 1);
    const r = await master('projects', { name: '27岡山大学祭', startDate: '2027-11-01', endDate: '2027-11-03', openHour: 10, closeHour: 17,
      copyFrom: 1, copy: { products: true, rule: true, target: true, payments: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    p2 = r.body.created;
    const d = (await master('data', undefined, p2)).body;
    assert.equal(d.projectSettings.name, '27岡山大学祭');
    assert.equal(d.target, 92563);
    assert.deepEqual(d.rule, { enabled: true, freeUpTo: 4, per: 4, fee: 10, maxCount: 1 });
    assert.deepEqual(d.payMethods, ['現金', 'PayPay', '交通系IC']);
    const [dango, mallow] = d.allProducts;
    assert.notEqual(dango.id, 1);                     // 新しい商品
    assert.deepEqual(dango.flavors, ['みたらし', 'あんこ']);
    assert.equal(mallow.bundleWith, dango.id);         // 相手は新しい催しの団子に付け替わる
    assert.equal(d.total, 0);                          // 会計は複製しない
  });

  test('複製しないで作ると、商品は空・容器代なし（指定がなければ）・支払方法は初期値', async () => {
    const r = await master('projects', { name: '空の催し', startDate: '2027-04-01', endDate: '2027-04-01' });
    const d = (await master('data', undefined, r.body.created)).body;
    assert.equal(d.allProducts.length, 0);
    assert.deepEqual(d.payMethods, ['現金', 'PayPay', 'd払い']);
    const off = await master('projects', { name: '容器なし', startDate: '2027-04-01', endDate: '2027-04-01', containerEnabled: false });
    assert.equal((await master('data', undefined, off.body.created)).body.rule.enabled, false);
  });

  test('「レジで使う」を切り替えると、レジ・ダッシュボードはその催しになり、会計番号は #1 から', async () => {
    await master(`projects/${p2}/activate`, {});
    const reg = (await w.api('/api/admin/data', { role: 'register' })).body;
    assert.equal(reg.project.id, p2);
    const pid = reg.products[0].id;
    const r = await sale({ projectId: p2, items: { [pid]: 3 }, flavors: { [pid]: { あんこ: 3 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [s] = await w.query('SELECT project_id, order_no, goods, container FROM sales ORDER BY id DESC LIMIT 1');
    assert.deepEqual(s, { project_id: p2, order_no: 1, goods: 400, container: 0 });   // 容器代は 4 個まで無料のルール
    assert.equal((await w.api('/api/summary')).body.project.id, p2);
  });

  test('切り替える前にオフラインで打った会計は、あとで届いても打ったときの催しに記録', async () => {
    const r = await sale({ projectId: 1, epoch: 3, items: { 1: 5 }, flavors: { 1: { みたらし: 5 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [s] = await w.query('SELECT project_id, order_no, goods FROM sales ORDER BY id DESC LIMIT 1');
    assert.equal(s.project_id, 1);
    assert.equal(s.goods, 500);
    assert.ok(s.order_no > 4);
  });

  test('リセットはその催しの会計だけ。古い世代の取消は捨てる', async () => {
    const before1 = (await w.query('SELECT COUNT(*) AS n FROM sales WHERE project_id = 1'))[0].n;
    const bad = await master('reset-sales', { confirm: 'リセット', password: 'wrong' }, p2);
    assert.equal(bad.status, 401);
    const r = await master('reset-sales', { confirm: 'リセット', password: 'master-pass-1234' }, p2);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await w.query('SELECT COUNT(*) AS n FROM sales WHERE project_id = ?', p2))[0].n, 0);
    assert.equal((await w.query('SELECT COUNT(*) AS n FROM sales WHERE project_id = 1'))[0].n, before1);
    const [p] = await w.query('SELECT epoch FROM projects WHERE id = ?', p2);
    assert.equal(p.epoch, 2);
    const stale = await w.api('/api/admin/sales/set-cancel', { role: 'register', body: { projectId: p2, epoch: 1, clientId: 'nothing-here-0001', cancelled: true } });
    assert.equal(stale.body.stale, true);
  });

  test('削除：レジで使用中は不可、会計があれば催し名とパスワードが必要、消したあとに明細が残らない', async () => {
    assert.equal((await master(`projects/${p2}/delete`, {})).status, 400);   // レジで使用中
    await master('projects/1/activate', {});
    // p2 に会計を 1 件作ってから消す
    await master(`projects/${p2}/activate`, {});
    const pid = (await w.api('/api/admin/data', { role: 'register' })).body.products[0].id;
    await sale({ projectId: p2, epoch: 2, items: { [pid]: 1 }, flavors: { [pid]: { みたらし: 1 } } });
    await master('projects/1/activate', {});
    assert.equal((await master(`projects/${p2}/delete`, {})).status, 400);                                      // 名前なし
    assert.equal((await master(`projects/${p2}/delete`, { confirm: '27岡山大学祭', password: 'wrong' })).status, 401);
    const r = await master(`projects/${p2}/delete`, { confirm: '27岡山大学祭', password: 'master-pass-1234' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!r.body.projects.some((p) => p.id === p2));
    const left = await w.query(`SELECT
        (SELECT COUNT(*) FROM sales WHERE project_id = ?1) AS sales,
        (SELECT COUNT(*) FROM products WHERE project_id = ?1) AS products,
        (SELECT COUNT(*) FROM sale_items WHERE sale_id NOT IN (SELECT id FROM sales)) AS items,
        (SELECT COUNT(*) FROM sale_flavors WHERE sale_id NOT IN (SELECT id FROM sales)) AS flavors`, p2);
    assert.deepEqual(left[0], { sales: 0, products: 0, items: 0, flavors: 0 });
    assert.ok((await w.query('SELECT COUNT(*) AS n FROM sales WHERE project_id = 1'))[0].n > 0);   // ほかの催しは残る
  });
});

describe('会計の記録（サーバー側の計算と設定）', () => {
  let dir, w, P;
  before(async () => {
    dir = tempDir();
    w = await startWorker(dir);
    await seedLegacy(w);
    await w.api('/api/summary');
    await w.loginMaster();
    await w.loginRegister();
    await w.api('/api/master/closed', { body: { closed: false }, role: 'master' });
    P = 1;
  });
  after(async () => { await w?.dispose(); cleanup(dir); });
  const master = (path, body) => w.api('/api/master/' + path, { body, role: 'master', headers: { 'X-Project': String(P) } });
  const sale = (body) => w.api('/api/admin/sales', { role: 'register', body: { lite: true, clientId: cid(), createdAt: nowIso(), payment: '現金', ...body } });
  const last = async () => (await w.query('SELECT * FROM sales ORDER BY id DESC LIMIT 1'))[0];

  test('サーバーでセットを組み直す（画面の計算は信用しない）', async () => {
    const r = await sale({ items: { 1: 7 }, flavors: { 1: { みたらし: 7 } } });
    assert.equal(r.status, 200);
    const s = await last();
    assert.equal(s.goods, 800);       // 5本セット＋1本×2
    assert.equal(s.container, 10);    // 7本 > 4本 → 容器 1 個（上限 1 個）
    assert.equal(s.amount, 810);
  });

  test('同じ会計 ID は 2 回送っても 1 件', async () => {
    const id = cid();
    await sale({ clientId: id, items: { 1: 1 }, flavors: { 1: { あんこ: 1 } } });
    await sale({ clientId: id, items: { 1: 1 }, flavors: { 1: { あんこ: 1 } } });
    assert.equal((await w.query('SELECT COUNT(*) AS n FROM sales WHERE client_id = ?', id))[0].n, 1);
  });

  test('味ごとの数と合計が合わない会計は受け付けない', async () => {
    const r = await sale({ items: { 1: 3 }, flavors: { 1: { みたらし: 2 } } });
    assert.equal(r.status, 400);
  });

  test('価格が変わる前に端末で打った会計は、端末の金額で記録して操作の記録に残す', async () => {
    const lines = [{ productId: 1, name: '団子', unit: '本', packs: [{ qty: 1, price: 120, count: 2 }] }];
    const r = await sale({ items: { 1: 2 }, lines, containerAuto: 0, flavors: { 1: { みたらし: 2 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await last()).goods, 240);
    const [a] = await w.query('SELECT action FROM audit ORDER BY id DESC LIMIT 1');
    assert.equal(a.action, '今の価格と違う会計を記録');
  });

  test('容器代を取らない催しでは、手で入れた容器代も 0 円', async () => {
    await master('container-rule', { enabled: false, freeUpTo: 4, per: 4, fee: 10, maxCount: 1 });
    await sale({ items: { 1: 7 }, flavors: { 1: { みたらし: 7 } }, container: 20 });
    const s = await last();
    assert.equal(s.container, 0);
    assert.equal(s.amount, 800);
    await master('container-rule', { enabled: true, freeUpTo: 4, per: 4, fee: 10, maxCount: 1 });
  });

  test('支払方法：選んでいない支払方法は、古い画面からは受け付けず、明細つき（オフライン対応）の画面からは記録して残す', async () => {
    const bad = await master('payments', { payments: [] });
    assert.equal(bad.status, 400);
    await master('payments', { payments: ['PayPay', 'Airペイ'] });
    const old = await sale({ items: { 1: 1 }, flavors: { 1: { みたらし: 1 } }, payment: '現金' });
    assert.equal(old.status, 409);
    const lines = [{ productId: 1, name: '団子', unit: '本', packs: [{ qty: 1, price: 150, count: 1 }] }];
    const queued = await sale({ items: { 1: 1 }, lines, flavors: { 1: { みたらし: 1 } }, payment: '現金' });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    assert.equal((await last()).payment, '現金');
    const air = await sale({ items: { 1: 1 }, flavors: { 1: { みたらし: 1 } }, payment: 'Airペイ' });
    assert.equal(air.status, 200);
    const d = (await w.api('/api/summary')).body;
    assert.deepEqual(d.payMethods, ['PayPay', 'Airペイ']);
    assert.ok(d.payments.includes('現金'));   // 記録にある支払方法は集計に残る
  });

  test('営業終了後に打った会計は受け付けない', async () => {
    await master('closed', { closed: true });
    const r = await sale({ items: { 1: 1 }, flavors: { 1: { みたらし: 1 } }, payment: 'PayPay' });
    assert.equal(r.status, 423);
  });
});
