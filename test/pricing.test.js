/**
 * 料金計算（public/pricing.js）のテスト。レジの画面とサーバーの両方が使う計算なので、
 * 金額が変わってしまう変更をここで止める。
 *   npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RULE, containerFee, bestBundle, priceCart, upsell, itemsFromLines, describeItems,
  describeFlavors, withFlavors, packLabel, packsText, PAYMENT_PRESETS, DEFAULT_PAYMENTS, isCashPayment, paymentColor,
} from '../public/pricing.js';

// 26岡山大学祭と同じ形の商品（団子は 1本150円・3本400円・5本500円、焼きマシュマロは団子のセットに含める）
const dango = { id: 1, name: '団子', unit: '本', sets: [{ qty: 1, price: 150 }, { qty: 3, price: 400 }, { qty: 5, price: 500 }], container: true, active: true, bundleWith: null, flavors: ['みたらし', 'あんこ'] };
const mallow = { id: 2, name: '焼きマシュマロ', unit: '本', sets: [{ qty: 1, price: 150 }], container: false, active: true, bundleWith: 1, flavors: [] };
const products = [dango, mallow];
const rule = { ...DEFAULT_RULE };   // 2個まで無料・4個ごとに10円・最大1個

describe('容器代（containerFee）', () => {
  test('無料の数までは 0 円、それより多いと容器 1 個分', () => {
    assert.equal(containerFee(rule, 0), 0);
    assert.equal(containerFee(rule, 1), 0);
    assert.equal(containerFee(rule, 2), 0);
    assert.equal(containerFee(rule, 3), 10);
    assert.equal(containerFee(rule, 4), 10);
  });
  test('容器の数の上限（maxCount）で頭打ち', () => {
    assert.equal(containerFee(rule, 9), 10);   // 3 個分になるが最大 1 個
  });
  test('上限なし（maxCount = 0）なら per 個ごとに増える', () => {
    const r = { ...rule, maxCount: 0 };
    assert.equal(containerFee(r, 4), 10);
    assert.equal(containerFee(r, 5), 20);
    assert.equal(containerFee(r, 9), 30);
  });
  test('容器代を取らない催し（enabled = false）はいつも 0 円', () => {
    const r = { ...rule, enabled: false };
    for (const n of [0, 1, 3, 9, 100]) assert.equal(containerFee(r, n), 0);
  });
  test('enabled がない古いルールは「取る」として扱う', () => {
    const { enabled, ...old } = rule;
    assert.equal(containerFee(old, 3), 10);
  });
});

describe('セットの組み方（bestBundle）', () => {
  test('一番安い組み合わせ', () => {
    assert.deepEqual(bestBundle(dango.sets, 4), { cost: 550, packs: [{ qty: 3, price: 400, count: 1 }, { qty: 1, price: 150, count: 1 }] });
    assert.deepEqual(bestBundle(dango.sets, 7), { cost: 800, packs: [{ qty: 5, price: 500, count: 1 }, { qty: 1, price: 150, count: 2 }] });
    assert.equal(bestBundle(dango.sets, 10).cost, 1000);
    assert.equal(bestBundle(dango.sets, 6).cost, 650);   // 5+1（650）が 3+3（800）より安い
  });
  test('同じ金額なら、大きいセットを使う（セットの数が少ない）ほう', () => {
    const sets = [{ qty: 1, price: 100 }, { qty: 2, price: 200 }];
    assert.deepEqual(bestBundle(sets, 2).packs, [{ qty: 2, price: 200, count: 1 }]);
  });
  test('1 個の価格がなく組めない数は null', () => {
    assert.equal(bestBundle([{ qty: 3, price: 300 }], 4), null);
  });
});

describe('お会計の計算（priceCart）', () => {
  test('団子4本 = 3本セット＋1本 550円、容器代 10円、合計 560円', () => {
    const r = priceCart(products, rule, { 1: 4 });
    assert.equal(r.goods, 550);
    assert.equal(r.fee, 10);
    assert.equal(r.total, 560);
    assert.equal(r.units, 4);
  });
  test('団子2本は容器代なし', () => {
    const r = priceCart(products, rule, { 1: 2 });
    assert.equal(r.total, 300);
    assert.equal(r.fee, 0);
  });
  test('焼きマシュマロは団子と合わせてセット（団子3本＋マシュマロ2本 = 5本セット 500円）', () => {
    const r = priceCart(products, rule, { 1: 3, 2: 2 });
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].product.id, 1);
    assert.equal(r.goods, 500);
    assert.equal(r.containerUnits, 3);   // 容器代は団子の本数だけで数える
    assert.equal(r.total, 510);
  });
  test('焼きマシュマロだけでも、団子のセット価格で組む（3本 = 3本セット 400円）。容器代は対象外', () => {
    const r = priceCart(products, rule, { 2: 3 });
    assert.equal(r.goods, 400);
    assert.equal(r.fee, 0);
    assert.equal(describeItems(itemsFromLines(r.lines)), '焼きマシュマロ3本（3本セット×1）');
  });
  test('相手にセット価格がない「セットに含める」は無視して単独で組む', () => {
    const single = { id: 3, name: 'ジュース', unit: '本', sets: [{ qty: 1, price: 100 }], container: false, active: true, bundleWith: null };
    const follower = { ...mallow, bundleWith: 3 };
    const r = priceCart([single, follower], rule, { 3: 1, 2: 2 });
    assert.equal(r.lines.length, 2);
    assert.equal(r.goods, 100 + 300);
  });
  test('容器代を取らない催しでは合計 = 商品代', () => {
    const r = priceCart(products, { ...rule, enabled: false }, { 1: 7 });
    assert.equal(r.fee, 0);
    assert.equal(r.total, r.goods);
  });
  test('数が 0 や不正な値の商品は入れない', () => {
    const r = priceCart(products, rule, { 1: 0, 2: 'x' });
    assert.equal(r.lines.length, 0);
    assert.equal(r.total, 0);
  });
});

describe('足すとお得の提案（upsell）', () => {
  test('団子4本 → 5本にすると 50円お得', () => {
    assert.deepEqual(upsell(products, rule, { 1: 4 }, 1), { qty: 5, total: 510, save: 50 });
  });
  test('すでに一番お得なら提案しない', () => {
    assert.equal(upsell(products, rule, { 1: 5 }, 1), null);
    assert.equal(upsell(products, rule, { 1: 1 }, 1), null);
  });
  test('入っていない商品には提案しない', () => {
    assert.equal(upsell(products, rule, {}, 1), null);
  });
});

describe('記録用の明細（itemsFromLines）', () => {
  test('1 種類の商品はセットごとに 1 行', () => {
    const items = itemsFromLines(priceCart(products, rule, { 1: 7 }).lines);
    assert.deepEqual(items.map((i) => [i.set_qty, i.set_price, i.count, i.pack_label]), [[5, 500, 1, null], [1, 150, 2, null]]);
  });
  test('混ぜたセットは本数の割合で金額を分け、合計はセットの金額と一致', () => {
    const items = itemsFromLines(priceCart(products, rule, { 1: 3, 2: 2 }).lines);
    assert.deepEqual(items.map((i) => [i.name, i.set_qty, i.set_price, i.count, i.pack_label]),
      [['団子', 3, 300, 1, '5本セット×1'], ['焼きマシュマロ', 2, 200, 1, '5本セット×1']]);
  });
  test('割り切れないときも合計は 1 円もずれない（端数は最後の商品に）', () => {
    const a = { id: 10, name: 'A', unit: '本', sets: [{ qty: 1, price: 150 }, { qty: 3, price: 400 }], container: false, active: true };
    const b = { id: 11, name: 'B', unit: '本', sets: [{ qty: 1, price: 150 }], container: false, active: true, bundleWith: 10 };
    const c = { id: 12, name: 'C', unit: '本', sets: [{ qty: 1, price: 150 }], container: false, active: true, bundleWith: 10 };
    const r = priceCart([a, b, c], rule, { 10: 1, 11: 1, 12: 1 });
    const items = itemsFromLines(r.lines);
    assert.equal(items.reduce((s, i) => s + i.set_price * i.count, 0), r.goods);
    assert.deepEqual(items.map((i) => i.set_price), [133, 133, 134]);
  });
  test('いろいろな会計で、明細の合計 = 商品代', () => {
    for (let d = 0; d <= 12; d++) {
      for (let m = 0; m <= 6; m++) {
        if (!d && !m) continue;
        const r = priceCart(products, rule, { 1: d, 2: m });
        const sum = itemsFromLines(r.lines).reduce((s, i) => s + i.set_price * i.count, 0);
        assert.equal(sum, r.goods, `団子${d}本・マシュマロ${m}本`);
      }
    }
  });
});

describe('明細の文字列', () => {
  test('describeItems', () => {
    assert.equal(describeItems(itemsFromLines(priceCart(products, rule, { 1: 4 }).lines)), '団子4本（3本セット×1＋1本×1）');
    assert.equal(describeItems(itemsFromLines(priceCart(products, rule, { 1: 3, 2: 2 }).lines)), '団子3本・焼きマシュマロ2本（5本セット×1）');
    assert.equal(describeItems(itemsFromLines(priceCart(products, rule, { 2: 2 }).lines)), '焼きマシュマロ2本');
  });
  test('describeFlavors / withFlavors', () => {
    const rows = [{ name: '団子', flavor: 'みたらし', qty: 2 }, { name: '団子', flavor: 'あんこ', qty: 1 }, { name: '焼きマシュマロ', flavor: '', qty: 2 }];
    assert.equal(describeFlavors(rows), 'みたらし2・あんこ1');
    assert.equal(withFlavors('団子3本', rows), '団子3本〔みたらし2・あんこ1〕');
    assert.equal(withFlavors('焼きマシュマロ2本', [{ name: '焼きマシュマロ', flavor: '', qty: 2 }]), '焼きマシュマロ2本');
    assert.equal(describeFlavors([...rows, { name: 'クレープ', flavor: 'チョコ', qty: 1 }]), '団子 みたらし2・あんこ1／クレープ チョコ1');
  });
  test('packLabel / packsText', () => {
    assert.equal(packLabel({ qty: 1 }, '本'), '1本');
    assert.equal(packLabel({ qty: 5 }, '本'), '5本セット');
    assert.equal(packsText([{ qty: 5, count: 1 }, { qty: 1, count: 2 }], '本'), '5本セット×1＋1本×2');
  });
});

describe('支払方法', () => {
  test('お預かり・おつりを入れるのは「現金」だけ', () => {
    assert.equal(isCashPayment('現金'), true);
    for (const n of ['PayPay', 'd払い', '交通系IC', 'Airペイ']) assert.equal(isCashPayment(n), false);
  });
  test('これまでの催しの支払方法は 現金・PayPay・d払い', () => {
    assert.deepEqual(DEFAULT_PAYMENTS, ['現金', 'PayPay', 'd払い']);
  });
  test('候補の名前は重ならず、色はその色', () => {
    const names = PAYMENT_PRESETS.map((p) => p.name);
    assert.equal(new Set(names).size, names.length);
    for (const p of PAYMENT_PRESETS) assert.equal(paymentColor(p.name), p.color);
  });
  test('追加した支払方法の色は、名前ごとにいつも同じ', () => {
    assert.match(paymentColor('Airペイ'), /^#[0-9a-f]{6}$/);
    assert.equal(paymentColor('Airペイ'), paymentColor('Airペイ'));
  });
});
