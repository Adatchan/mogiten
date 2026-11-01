/**
 * 料金計算（レジ画面とサーバーで共通）
 *
 * 商品（product）の形:
 *   { id, name, unit: '本', sets: [{ qty: 1, price: 150 }, { qty: 3, price: 400 }, ...],
 *     container: true/false（容器代の対象か）, active: true/false,
 *     bundleWith: null または 商品ID（その商品のセットに含めて、本数を合わせてセットを組む） }
 *
 * 容器代のルール（rule）:
 *   { freeUpTo: 2, per: 4, fee: 10, maxCount: 1 }
 *   → 容器代の対象の合計が freeUpTo 以下なら 0円、それより多ければ per 個ごとに 1 個（fee 円）。
 *     容器の数は maxCount 個まで（0 = 上限なし）
 *     （初期値: 1〜2本 0円 / 3本以上は何本でも 1 個 10円）
 */

export const DEFAULT_RULE = { freeUpTo: 2, per: 4, fee: 10, maxCount: 1 };

export const DEFAULT_PRODUCTS = [
  { name: '団子', unit: '本', sets: [{ qty: 1, price: 150 }, { qty: 3, price: 400 }, { qty: 5, price: 500 }], container: true },
  { name: '焼きマシュマロ', unit: '本', sets: [{ qty: 1, price: 150 }], container: false },
];

export const MAX_QTY = 200;   // 1会計・1商品あたりの上限

export function containerFee(rule, n) {
  if (!(n > 0) || n <= rule.freeUpTo) return 0;
  let count = Math.ceil(n / rule.per);
  if (rule.maxCount > 0) count = Math.min(count, rule.maxCount);   // 容器の数の上限
  return count * rule.fee;
}

/**
 * qty 個ちょうどで一番安くなるセットの組み合わせ（お客さんに有利な組み方）。
 * 同じ金額なら、セットの数が少ない（大きいセットを使う）ほうを選ぶ。
 * 戻り値: { cost, packs: [{ qty, price, count }]（大きいセットから順） }
 */
export function bestBundle(sets, qty) {
  const best = [{ cost: 0, n: 0, counts: sets.map(() => 0) }];
  for (let i = 1; i <= qty; i++) {
    let b = null;
    sets.forEach((s, k) => {
      const prev = best[i - s.qty];
      if (!prev) return;
      const cand = { cost: prev.cost + s.price, n: prev.n + 1, k, prev };
      if (!b || cand.cost < b.cost || (cand.cost === b.cost && cand.n < b.n)) b = cand;
    });
    if (!b) { best[i] = null; continue; }   // 作れない個数（1個単位のセットがないとき）
    const counts = b.prev.counts.slice();
    counts[b.k]++;
    best[i] = { cost: b.cost, n: b.n, counts };
  }
  const r = best[qty];
  if (!r) return null;
  return {
    cost: r.cost,
    packs: sets.map((s, k) => ({ qty: s.qty, price: s.price, count: r.counts[k] }))
      .filter((p) => p.count > 0)
      .sort((a, b) => b.qty - a.qty),
  };
}

/** 「○○のセットに含める」の相手（リストにあるときだけ。なければ単独で売る） */
function leaderOf(products, p) {
  if (!p.bundleWith) return null;
  const l = products.find((x) => String(x.id) === String(p.bundleWith) && x !== p && !x.bundleWith);
  return l || null;
}

/**
 * カート（{ 商品ID: 個数 }）の金額を計算する。
 * 「○○のセットに含める」商品は、相手の商品と本数を合わせて、相手のセットで組む。
 * 戻り値: { lines: [{ product, qty, packs, subtotal, members: [{ product, qty }] }], goods, containerUnits, fee, total, units }
 *   product はセットを決める商品（グループの代表）、qty はグループ全体の数、members は商品ごとの内訳
 */
export function priceCart(products, rule, cart) {
  const lines = [];
  let goods = 0, containerUnits = 0, units = 0;
  const qtyOf = (p) => Math.max(0, Math.floor(Number(cart[p.id]) || 0));
  for (const p of products) {
    if (leaderOf(products, p)) continue;   // 相手の商品の行でまとめて計算する
    const group = [p, ...products.filter((x) => leaderOf(products, x) === p)];
    const members = group.map((x) => ({ product: x, qty: qtyOf(x) })).filter((m) => m.qty > 0);
    const qty = members.reduce((a, m) => a + m.qty, 0);
    if (qty <= 0) continue;
    const b = bestBundle(p.sets, qty);
    if (!b) throw new Error(`${p.name}は${qty}${p.unit}では組めません`);
    lines.push({ product: p, qty, packs: b.packs, subtotal: b.cost, members });
    goods += b.cost;
    units += qty;
    for (const m of members) if (m.product.container) containerUnits += m.qty;
  }
  const fee = containerFee(rule, containerUnits);
  return { lines, goods, containerUnits, fee, total: goods + fee, units };
}

/**
 * ある商品をあと何個か足すと、会計全体（容器代込み）が同じか安くなるときの提案。
 * 戻り値: null または { qty: 提案する個数, total, save }
 */
export function upsell(products, rule, cart, productId, maxAdd = 4) {
  const now = Math.floor(Number(cart[productId]) || 0);
  if (!now) return null;
  const totalWith = (q) => {
    try { return priceCart(products, rule, { ...cart, [productId]: q }).total; } catch { return Infinity; }
  };
  const base = totalWith(now);
  let best = null;
  for (let q = now + 1; q <= Math.min(MAX_QTY, now + maxAdd); q++) {
    const t = totalWith(q);
    if (t <= base && (!best || t < best.total)) best = { qty: q, total: t, save: base - t };
  }
  return best;
}

/** セットの書き方（例: 「5本セット」「1本」） */
export function packLabel(p, unit) {
  return p.qty === 1 ? `1${unit}` : `${p.qty}${unit}セット`;
}

/** セットの組み方の書き方（例: 「5本セット×1＋1本×1」） */
export function packsText(packs, unit) {
  return packs.map((k) => packLabel(k, unit) + '×' + k.count).join('＋');
}

/**
 * 計算結果の行（priceCart の lines、または同じ形の明細）を、記録用の明細（sale_items の行）にする。
 * 混ぜたセットは、セットの金額を本数の割合で商品ごとに分け、pack_label にセットの組み方を残す。
 */
export function itemsFromLines(lines) {
  const rows = [];
  for (const l of lines) {
    const members = l.members && l.members.length ? l.members : [{ product: l.product, qty: l.qty }];
    if (members.length === 1) {
      // 商品が 1 種類だけ：その商品のセットとして記録（相手のセットで組んでいても）
      const m = members[0].product;
      for (const k of l.packs) rows.push({ product_id: m.id, name: m.name, unit: m.unit, set_qty: k.qty, set_price: k.price, count: k.count, pack_label: null });
      continue;
    }
    const total = l.packs.reduce((a, k) => a + k.price * k.count, 0);
    const n = members.reduce((a, m) => a + m.qty, 0);
    const label = packsText(l.packs, l.product.unit);
    let rest = total;
    members.forEach((m, i) => {
      const amt = i === members.length - 1 ? rest : Math.round(total * m.qty / n);
      rest -= amt;
      rows.push({ product_id: m.product.id, name: m.product.name, unit: m.product.unit, set_qty: m.qty, set_price: amt, count: 1, pack_label: label });
    });
  }
  return rows;
}

/** 会計の明細を短い文字列に（例: 「団子5本（5本セット×1）・焼きマシュマロ2本」「団子3本・焼きマシュマロ2本（5本セット×1）」） */
export function describeItems(items) {
  // items: [{ name, unit, set_qty, set_price, count, pack_label }]（sale_items の行）
  const parts = [];
  // 混ぜたセット（pack_label あり）は、同じ組み方の行をまとめて 1 つに
  const mixed = new Map();
  for (const it of items) {
    if (!it.pack_label) continue;
    if (!mixed.has(it.pack_label)) mixed.set(it.pack_label, []);
    mixed.get(it.pack_label).push(it);
  }
  for (const [label, its] of mixed) parts.push(its.map((it) => `${it.name}${it.set_qty * it.count}${it.unit}`).join('・') + `（${label}）`);
  const by = new Map();
  for (const it of items) {
    if (it.pack_label) continue;
    if (!by.has(it.name)) by.set(it.name, { unit: it.unit, qty: 0, packs: [] });
    const g = by.get(it.name);
    g.qty += it.set_qty * it.count;
    g.packs.push(it);
  }
  return [...by.entries()].map(([name, g]) => {
    const setPacks = g.packs.filter((p) => p.set_qty > 1);
    const detail = setPacks.length
      ? '（' + g.packs.sort((a, b) => b.set_qty - a.set_qty).map((p) => packLabel({ qty: p.set_qty }, g.unit) + '×' + p.count).join('＋') + '）'
      : '';
    return `${name}${g.qty}${g.unit}${detail}`;
  }).concat(parts).join('・');
}
