/**
 * 模擬店（団子）売上ダッシュボード & 簡易レジ
 *
 *   ダッシュボード : https://script.google.com/macros/s/xxxx/exec
 *   レジ（管理画面）: https://script.google.com/macros/s/xxxx/exec?page=admin
 */

// ===== 設定 =====
const ADMIN_PASSWORD = 'dango';   // レジ画面のパスワード（好きなものに変更してください）
const DEFAULT_TARGET = 30000;     // 目標金額の初期値（レジ画面からも変更できます）
const SHOP_NAME = '混声合唱と学祭のための 団子';

// セット: 本数 -> 価格
const SETS = [
  { key: 's1', sticks: 1, price: 150 },
  { key: 's3', sticks: 3, price: 400 },
  { key: 's5', sticks: 5, price: 500 },
];
const PAYMENTS = ['現金', 'PayPay', 'd払い'];

const SHEET_NAME = '売上';
const HEADER = ['ID', '日時', '1本セット', '3本セット', '5本セット', '本数', '金額', '支払方法', '取消'];
const COL = { id: 0, time: 1, s1: 2, s3: 3, s5: 4, sticks: 5, amount: 6, payment: 7, cancel: 8 };
const CACHE_KEY = 'summary_v1';

// ===== 画面 =====
function doGet(e) {
  const isAdmin = e && e.parameter && e.parameter.page === 'admin';
  return HtmlService.createHtmlOutputFromFile(isAdmin ? 'admin' : 'dashboard')
    .setTitle(isAdmin ? '団子レジ' : '団子 売上ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

// ===== 公開API（ダッシュボード用・認証不要） =====
function getSummary() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);
  const summary = buildSummary_();
  cache.put(CACHE_KEY, JSON.stringify(summary), 10);
  return summary;
}

// ===== 管理API（パスワード必須） =====
function checkPassword(password) {
  return password === ADMIN_PASSWORD;
}

function getAdminData(password) {
  auth_(password);
  return Object.assign(buildSummary_(), { recent: recent_(15), appUrl: ScriptApp.getService().getUrl() });
}

/** order: { s1: 個数, s3: 個数, s5: 個数 }, payment: '現金' | 'PayPay' | 'd払い' */
function recordSale(password, order, payment) {
  auth_(password);
  if (PAYMENTS.indexOf(payment) < 0) throw new Error('支払方法が不正です');
  const counts = {};
  let sticks = 0, amount = 0;
  SETS.forEach(function (s) {
    const n = Math.max(0, Math.floor(Number(order && order[s.key]) || 0));
    counts[s.key] = n;
    sticks += n * s.sticks;
    amount += n * s.price;
  });
  if (amount <= 0) throw new Error('商品が選択されていません');

  withLock_(function () {
    const id = String(Date.now()) + Math.floor(Math.random() * 1000);
    sheet_().appendRow([id, new Date(), counts.s1, counts.s3, counts.s5, sticks, amount, payment, '']);
  });
  return getAdminData(password);
}

function cancelSale(password, id) {
  auth_(password);
  withLock_(function () {
    const sh = sheet_();
    const ids = sh.getRange(1, COL.id + 1, sh.getLastRow(), 1).getValues();
    for (let i = ids.length - 1; i >= 1; i--) {
      if (String(ids[i][0]) === String(id)) {
        const cell = sh.getRange(i + 1, COL.cancel + 1);
        cell.setValue(cell.getValue() ? '' : '取消'); // もう一度押すと取消を戻す
        return;
      }
    }
    throw new Error('対象の会計が見つかりません');
  });
  return getAdminData(password);
}

function setTarget(password, amount) {
  auth_(password);
  const n = Math.floor(Number(amount));
  if (!(n > 0)) throw new Error('目標金額が不正です');
  PropertiesService.getScriptProperties().setProperty('target', String(n));
  CacheService.getScriptCache().remove(CACHE_KEY);
  return getAdminData(password);
}

// ===== 内部処理 =====
function auth_(password) {
  if (password !== ADMIN_PASSWORD) throw new Error('パスワードが違います');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    fn();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
    CacheService.getScriptCache().remove(CACHE_KEY);
  }
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADER);
    sh.setFrozenRows(1);
    sh.getRange('B:B').setNumberFormat('yyyy/MM/dd HH:mm:ss');
  }
  return sh;
}

function rows_() {
  const values = sheet_().getDataRange().getValues();
  return values.slice(1).filter(function (r) { return r[COL.id] !== ''; });
}

function target_() {
  const v = PropertiesService.getScriptProperties().getProperty('target');
  return v ? Number(v) : DEFAULT_TARGET;
}

function buildSummary_() {
  const rows = rows_();
  const sets = { s1: 0, s3: 0, s5: 0 };
  const byPayment = {};
  PAYMENTS.forEach(function (p) { byPayment[p] = { amount: 0, count: 0 }; });
  let total = 0, sticks = 0, orders = 0;

  rows.forEach(function (r) {
    if (r[COL.cancel]) return;
    orders++;
    total += Number(r[COL.amount]) || 0;
    sticks += Number(r[COL.sticks]) || 0;
    SETS.forEach(function (s) { sets[s.key] += Number(r[COL[s.key]]) || 0; });
    const p = byPayment[r[COL.payment]];
    if (p) { p.amount += Number(r[COL.amount]) || 0; p.count++; }
  });

  const target = target_();
  return {
    shopName: SHOP_NAME,
    total: total,
    target: target,
    remaining: Math.max(0, target - total),
    rate: target > 0 ? total / target : 0,
    sticks: sticks,
    orders: orders,
    sets: sets,
    setDefs: SETS,
    byPayment: byPayment,
    payments: PAYMENTS,
    updatedAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm:ss'),
  };
}

function recent_(limit) {
  return rows_().slice(-limit).reverse().map(function (r) {
    return {
      id: String(r[COL.id]),
      time: r[COL.time] instanceof Date ? Utilities.formatDate(r[COL.time], 'Asia/Tokyo', 'HH:mm') : String(r[COL.time]),
      s1: Number(r[COL.s1]) || 0,
      s3: Number(r[COL.s3]) || 0,
      s5: Number(r[COL.s5]) || 0,
      amount: Number(r[COL.amount]) || 0,
      payment: r[COL.payment],
      cancelled: !!r[COL.cancel],
    };
  });
}
