/**
 * 料金計算（public/pricing.js）のテスト。レジの画面とサーバーの両方が使う計算なので、
 * 金額が変わってしまう変更をここで止める。
 *   npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bestBundle, priceCart, upsell, itemsFromLines, describeItems, describeTickets, packLabel, packsText,
  PAYMENT_PRESETS, DEFAULT_PAYMENTS, isCashPayment, paymentColor,
} from '../public/pricing.js';

// 一般は 1枚1,000円・ペア（2枚）1,800円、学生は 1枚500円で「一般のセットに含める」、高校生以下は 0円
const ippan = { id: 1, name: '一般', unit: '枚', sets: [{ qty: 1, price: 1000 }, { qty: 2, price: 1800 }], active: true, bundleWith: null };
const gakusei = { id: 2, name: '学生', unit: '枚', sets: [{ qty: 1, price: 500 }], active: true, bundleWith: null };
const free = { id: 3, name: '高校生以下', unit: '枚', sets: [{ qty: 1, price: 0 }], active: true, bundleWith: null };
const products = [ippan, gakusei, free];

describe('セットの組み方（bestBundle）', () => {
  test('一番安い組み合わせ', () => {
    assert.deepEqual(bestBundle(ippan.sets, 3), { cost: 2800, packs: [{ qty: 2, price: 1800, count: 1 }, { qty: 1, price: 1000, count: 1 }] });
    assert.equal(bestBundle(ippan.sets, 4).cost, 3600);
  });
  test('同じ金額なら、大きいセットを使う（セットの数が少ない）ほう', () => {
    const sets = [{ qty: 1, price: 100 }, { qty: 2, price: 200 }];
    assert.deepEqual(bestBundle(sets, 2).packs, [{ qty: 2, price: 200, count: 1 }]);
  });
  test('1 枚の価格がなく組めない枚数は null', () => {
    assert.equal(bestBundle([{ qty: 2, price: 1800 }], 3), null);
  });
});

describe('お会計の計算（priceCart）', () => {
  test('券種ごとに計算して足す', () => {
    const r = priceCart(products, { 1: 3, 2: 2, 3: 1 });
    assert.equal(r.goods, 2800 + 1000 + 0);
    assert.equal(r.total, r.goods);
    assert.equal(r.units, 6);
    assert.equal(r.lines.length, 3);
  });
  test('0円の券種も枚数に数える', () => {
    const r = priceCart(products, { 3: 2 });
    assert.equal(r.total, 0);
    assert.equal(r.units, 2);
  });
  test('「セットに含める」券種は相手と枚数を合わせて組む（一般1＋学生1 = ペア 1,800円）', () => {
    const list = [ippan, { ...gakusei, bundleWith: 1 }];
    const r = priceCart(list, { 1: 1, 2: 1 });
    assert.equal(r.lines.length, 1);
    assert.equal(r.goods, 1800);
  });
  test('相手にセット価格がない「セットに含める」は無視して単独で組む', () => {
    const list = [gakusei, { ...free, bundleWith: 2 }];
    assert.equal(priceCart(list, { 2: 1, 3: 1 }).lines.length, 2);
  });
  test('枚数が 0 や不正な値の券種は入れない', () => {
    const r = priceCart(products, { 1: 0, 2: 'x', 3: -1 });
    assert.equal(r.lines.length, 0);
    assert.equal(r.total, 0);
  });
});

describe('お得の提案（upsell）', () => {
  test('一般1枚 → 2枚にすると 1枚あたりが安くなるが、合計は高いので提案しない', () => {
    assert.equal(upsell(products, { 1: 1 }, 1), null);
  });
  test('足したほうが安くなるときだけ提案', () => {
    const p = [{ ...ippan, sets: [{ qty: 1, price: 1000 }, { qty: 3, price: 1500 }] }];
    assert.deepEqual(upsell(p, { 1: 2 }, 1), { qty: 3, total: 1500, save: 500 });
  });
  test('入っていない券種には提案しない', () => {
    assert.equal(upsell(products, {}, 1), null);
  });
});

describe('明細（itemsFromLines / describeItems）', () => {
  test('1 つの券種はセットごとに 1 行', () => {
    const items = itemsFromLines(priceCart(products, { 1: 3 }).lines);
    assert.deepEqual(items.map((x) => [x.set_qty, x.set_price, x.count]), [[2, 1800, 1], [1, 1000, 1]]);
  });
  test('混ぜたセットは枚数の割合で金額を分け、合計はセットの金額と一致', () => {
    const list = [ippan, { ...gakusei, bundleWith: 1 }];
    const items = itemsFromLines(priceCart(list, { 1: 1, 2: 1 }).lines);
    assert.equal(items.length, 2);
    assert.equal(items.reduce((a, x) => a + x.set_price * x.count, 0), 1800);
    assert.ok(items.every((x) => x.pack_label === '2枚セット×1'));
  });
  test('いろいろな会計で、明細の合計 = 合計金額', () => {
    const list = [ippan, { ...gakusei, bundleWith: 1 }, free];
    for (const cart of [{ 1: 1 }, { 1: 5, 2: 2 }, { 2: 3 }, { 1: 2, 2: 1, 3: 4 }]) {
      const r = priceCart(list, cart);
      assert.equal(itemsFromLines(r.lines).reduce((a, x) => a + x.set_price * x.count, 0), r.total, JSON.stringify(cart));
    }
  });
  test('describeItems / describeTickets / packLabel', () => {
    assert.equal(describeItems(itemsFromLines(priceCart(products, { 1: 3, 2: 1 }).lines)), '一般3枚（2枚セット×1＋1枚×1）・学生1枚');
    assert.equal(describeTickets([{ name: '一般', unit: '枚', qty: 2 }, { name: '学生', qty: 1 }, { name: '招待', qty: 0 }]), '一般2枚・学生1枚');
    assert.equal(packLabel({ qty: 1 }, '枚'), '1枚');
    assert.equal(packsText([{ qty: 2, count: 1 }, { qty: 1, count: 2 }], '枚'), '2枚セット×1＋1枚×2');
  });
});

describe('支払方法', () => {
  test('お預かり・おつりを入れるのは「現金」だけ', () => {
    assert.ok(isCashPayment('現金'));
    assert.ok(!isCashPayment('PayPay'));
  });
  test('新しい公演の初期値は現金だけ', () => {
    assert.deepEqual(DEFAULT_PAYMENTS, ['現金']);
  });
  test('候補の名前は重ならず、色はその色。追加した支払方法の色は名前ごとにいつも同じ', () => {
    assert.equal(new Set(PAYMENT_PRESETS.map((p) => p.name)).size, PAYMENT_PRESETS.length);
    assert.equal(paymentColor('現金'), '#5b8c3a');
    assert.equal(paymentColor('Airペイ'), paymentColor('Airペイ'));
  });
});
