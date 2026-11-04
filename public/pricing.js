/**
 * 料金計算（レジ画面とサーバーで共通）。券種は公演ごとに管理画面で登録する（初期の券種はない）
 *
 * 券種（product）の形:
 *   { id, name, unit: '枚', sets: [{ qty: 1, price: 1000 }, { qty: 2, price: 1800 }, ...],
 *     active: true/false（レジで販売中か）,
 *     bundleWith: null または 券種ID（その券種のセット価格に含めて、枚数を合わせてセットを組む） }
 *
 * sets は「数量ごとの価格」。1枚の価格は必須で、2枚以上の価格（例: ペア券 2枚 1,800円）を登録すると、
 * 枚数を入れるだけでお客さんに一番有利な組み方を自動で選ぶ。
 */

export const MAX_QTY = 200;   // 1会計・1券種あたりの上限

/**
 * 支払方法の候補（管理画面で公演ごとに選ぶ。候補にないものも名前を入れて追加できる）。
 * 「現金」だけはレジでお預かり金額とおつりを入れる。color はレジのボタンの色（現金は app.css の --mg-pay-cash と同じ。ほかは各社の色）
 */
export const PAYMENT_PRESETS = [
  { name: '現金', color: '#5b8c3a' },
  { name: 'PayPay', color: '#e60012' },
  { name: 'd払い', color: '#cc0033' },
  { name: '楽天ペイ', color: '#bf0000' },
  { name: 'au PAY', color: '#eb5505' },
  { name: 'メルペイ', color: '#e3242b' },
  { name: '交通系IC', color: '#2f6db5' },
  { name: 'クレジットカード', color: '#3d4a8a' },
];
export const DEFAULT_PAYMENTS = ['現金'];   // 新しい公演の初期値（当日券は現金だけのことが多い）
export const MAX_PAYMENTS = 8;
export const isCashPayment = (name) => name === '現金';

/** 支払方法のボタンの色（候補はその色、追加したものは名前から決まる色） */
export function paymentColor(name) {
  const p = PAYMENT_PRESETS.find((x) => x.name === name);
  if (p) return p.color;
  const palette = ['#2a78d6', '#7a52b3', '#1f8a8a', '#8a5a3b', '#b5566e', '#4d6b2f'];
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return palette[h % palette.length];
}

/**
 * qty 枚ちょうどで一番安くなるセットの組み合わせ（お客さんに有利な組み方）。
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
    if (!b) { best[i] = null; continue; }   // 作れない枚数（1枚単位の価格がないとき）
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

/** セット価格（2枚以上の価格）がある券種か */
export const hasSetPrice = (p) => (p.sets || []).some((s) => s.qty > 1);

/**
 * 「○○のセットに含める」の相手（リストにあるときだけ）。
 * 相手にセット価格がない（1枚の価格しかない）場合は、まとめても意味がないので単独で売る。
 */
function leaderOf(products, p) {
  if (!p.bundleWith) return null;
  const l = products.find((x) => String(x.id) === String(p.bundleWith) && x !== p && !x.bundleWith && hasSetPrice(x));
  return l || null;
}

/**
 * カート（{ 券種ID: 枚数 }）の金額を計算する。
 * 「○○のセットに含める」券種は、相手の券種と枚数を合わせて、相手のセットで組む。
 * 戻り値: { lines: [{ product, qty, packs, subtotal, members: [{ product, qty }] }], goods, total, units }
 *   product はセットを決める券種（グループの代表）、qty はグループ全体の枚数、members は券種ごとの内訳
 */
export function priceCart(products, cart) {
  const lines = [];
  let goods = 0, units = 0;
  const qtyOf = (p) => Math.max(0, Math.floor(Number(cart[p.id]) || 0));
  for (const p of products) {
    if (leaderOf(products, p)) continue;   // 相手の券種の行でまとめて計算する
    const group = [p, ...products.filter((x) => leaderOf(products, x) === p)];
    const members = group.map((x) => ({ product: x, qty: qtyOf(x) })).filter((m) => m.qty > 0);
    const qty = members.reduce((a, m) => a + m.qty, 0);
    if (qty <= 0) continue;
    const b = bestBundle(p.sets, qty);
    if (!b) throw new Error(`${p.name}は${qty}${p.unit}では組めません`);
    lines.push({ product: p, qty, packs: b.packs, subtotal: b.cost, members });
    goods += b.cost;
    units += qty;
  }
  return { lines, goods, total: goods, units };
}

/**
 * ある券種をあと何枚か足すと、会計全体が同じか安くなるときの提案（例: 1枚1,000円・2枚1,800円で 1枚 → 2枚）。
 * 戻り値: null または { qty: 提案する枚数, total, save }
 */
export function upsell(products, cart, productId, maxAdd = 4) {
  const now = Math.floor(Number(cart[productId]) || 0);
  if (!now) return null;
  const totalWith = (q) => {
    try { return priceCart(products, { ...cart, [productId]: q }).total; } catch { return Infinity; }
  };
  const base = totalWith(now);
  let best = null;
  for (let q = now + 1; q <= Math.min(MAX_QTY, now + maxAdd); q++) {
    const t = totalWith(q);
    if (t <= base && (!best || t < best.total)) best = { qty: q, total: t, save: base - t };
  }
  return best;
}

/** セットの書き方（例: 「2枚セット」「1枚」） */
export function packLabel(p, unit) {
  return p.qty === 1 ? `1${unit}` : `${p.qty}${unit}セット`;
}

/** セットの組み方の書き方（例: 「2枚セット×1＋1枚×1」） */
export function packsText(packs, unit) {
  return packs.map((k) => packLabel(k, unit) + '×' + k.count).join('＋');
}

/**
 * 計算結果の行（priceCart の lines、または同じ形の明細）を、記録用の明細（sale_items の行）にする。
 * 混ぜたセットは、セットの金額を枚数の割合で券種ごとに分け、pack_label にセットの組み方を残す。
 */
export function itemsFromLines(lines) {
  const rows = [];
  for (const l of lines) {
    const members = l.members && l.members.length ? l.members : [{ product: l.product, qty: l.qty }];
    if (members.length === 1) {
      // 券種が 1 つだけ：その券種のセットとして記録（相手のセットで組んでいても）
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

/** 会計の明細を短い文字列に（例: 「一般2枚（2枚セット×1）・学生1枚」「一般1枚・学生1枚（2枚セット×1）」） */
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

/** 取り置きの券種の書き方（例: 「一般2枚・学生1枚」）。tickets: [{ name, unit, qty }] */
export function describeTickets(tickets) {
  return (tickets || []).filter((t) => t.qty > 0).map((t) => `${t.name}${t.qty}${t.unit || '枚'}`).join('・');
}
