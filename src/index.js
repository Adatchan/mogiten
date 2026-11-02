/**
 * 岡大グリー模擬店システム — 売上ダッシュボード・レジ・キッチン・管理画面（Cloudflare Workers + D1）
 *
 * 催し（プロジェクト）ごとに、商品・価格・目標・営業時間と会計を分けて管理する。
 * レジ・キッチン・ダッシュボードは、管理画面で「レジで使う」にした催しを使う。
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

import { DEFAULT_RULE, DEFAULT_PAYMENTS, MAX_PAYMENTS, MAX_QTY, priceCart, describeItems, itemsFromLines, withFlavors } from '../public/pricing.js';

const DEFAULT_TARGET = 30000;


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

      if (route === 'GET /api/summary') return json(await summary(env.DB, await getActiveProject(env.DB)));
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
  if (csvName && CSV_FILES[csvName[1]]) return csvResponse(db, await getActiveProject(db), csvName[1], url.searchParams);
  if (route === 'GET /api/admin/sales') return json(await salesPage(db, await getActiveProject(db), url.searchParams));
  // キッチンの注文キュー（レジで使っている催しの今日の注文。変化がなければ rev だけ返す）
  if (route === 'GET /api/admin/kitchen') return json(await kitchenData(db, await getActiveProject(db), url.searchParams));
  // キッチンで「できた」にする／戻す（状態を指定するので何度送っても同じ）
  if (route === 'POST /api/admin/kitchen/done') {
    const body = await readJson(request);
    const id = Math.floor(Number(body.id) || 0);
    const row = await db.prepare('SELECT id, project_id, kitchen_done_at FROM sales WHERE id = ?').bind(id).first();
    if (!row) throw httpError('注文が見つかりません', 404);
    const want = !!body.done;
    if (!!row.kitchen_done_at !== want) {
      await db.batch([
        db.prepare('UPDATE sales SET kitchen_done_at = ? WHERE id = ?').bind(want ? new Date().toISOString() : null, id),
        bumpRev(db, row.project_id),
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
    const P = body.projectId != null ? await getProject(db, body.projectId) : await getActiveProject(db);
    if (P && body.epoch != null && Number(body.epoch) !== P.epoch) return json({ ok: true, stale: true });
    const row = body.clientId
      ? await db.prepare('SELECT * FROM sales WHERE client_id = ?').bind(String(body.clientId)).first()
      : await db.prepare('SELECT * FROM sales WHERE id = ?').bind(Number(body.id) || 0).first();
    if (!row) throw httpError('会計が見つかりません', 404);
    const want = body.cancelled ? 1 : 0;
    if (row.cancelled !== want) {
      await db.batch([db.prepare('UPDATE sales SET cancelled = ? WHERE id = ?').bind(want, row.id), bumpRev(db, row.project_id)]);
      await audit(db, sess.staff, role, want ? '会計を取消' : '取消を戻す',
        `${await projectLabel(db, row.project_id)}#${row.order_no ?? row.id} ${yen(row.amount)} ${row.payment}（担当 ${row.staff || '—'}）` + (body.offline ? '・オフライン操作' : ''));
    }
    return json({ ok: true, id: row.id, cancelled: want });
  }
  const m = url.pathname.match(/^\/api\/admin\/sales\/(\d+)\/toggle-cancel$/);
  if (request.method === 'POST' && m) {
    const id = Number(m[1]);
    const row = await db.prepare('SELECT * FROM sales WHERE id = ?').bind(id).first();
    if (!row) throw httpError('会計が見つかりません', 404);
    await db.batch([db.prepare('UPDATE sales SET cancelled = 1 - cancelled WHERE id = ?').bind(id), bumpRev(db, row.project_id)]);
    await audit(db, sess.staff, role, row.cancelled ? '取消を戻す' : '会計を取消', `${await projectLabel(db, row.project_id)}#${row.order_no ?? id} ${yen(row.amount)} ${row.payment}（担当 ${row.staff || '—'}）`);
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
    return json(await projectsData(db), 200, { 'Set-Cookie': sess.cookie });
  }
  if (route === 'POST /api/master/logout') return logout(request, db, role);

  const sess = await requireSession(request, db, role);

  // ----- 催しの一覧・作成・変更（催しを選ぶ前の画面） -----
  if (route === 'GET /api/master/projects') return json(await projectsData(db));
  if (route === 'POST /api/master/projects') {
    const body = await readJson(request);
    const made = await createProject(db, body);
    const what = made.src ? `（「${made.src.name}」から複製：${[made.copy.products && `商品 ${made.copied} 件`, made.copy.rule && '容器代のルール', made.copy.target && '目標金額', made.copy.payments && '支払方法'].filter(Boolean).join('・') || 'なし'}）` : '';
    await audit(db, 'マスター', role, '催しを作成', made.name + (made.containerEnabled ? '' : '（容器代なし）') + what);
    if (body.activate) await setActiveProject(db, made.id);
    return json({ ...(await projectsData(db)), created: made.id });
  }
  const pj = url.pathname.match(/^\/api\/master\/projects\/(\d+)(?:\/(activate|delete))?$/);
  if (request.method === 'POST' && pj) {
    const P = await getProject(db, pj[1]);
    if (!P) throw httpError('催しが見つかりません', 404);
    if (pj[2] === 'activate') {
      await setActiveProject(db, P.id);
      await audit(db, 'マスター', role, 'レジで使う催しを変更', P.name);
    } else if (pj[2] === 'delete') {
      // 催しの削除：その催しの会計（明細・味）と商品もすべて消す。レジで使っている催しは消せない。
      // 会計の記録があるときは、確認のため催し名とマスターパスワードの入力が必要
      if (P.id === await activeProjectId(db)) throw httpError('レジで使っている催しは削除できません。先にほかの催しをレジで使うようにしてください', 400);
      const body = await readJson(request).catch(() => ({}));
      const st = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN cancelled = 0 THEN amount ELSE 0 END), 0) AS total
          FROM sales WHERE project_id = ?`).bind(P.id).first();
      if (st.n > 0) {
        if (String(body.confirm || '').trim() !== P.name) throw httpError('確認のため、催し名を正しく入力してください', 400);
        await login(request, env, role, body.password, 'マスターパスワードが違います');
      }
      const pc = await db.prepare('SELECT COUNT(*) AS n FROM products WHERE project_id = ?').bind(P.id).first();
      await db.batch([
        db.prepare('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE project_id = ?)').bind(P.id),
        db.prepare('DELETE FROM sale_flavors WHERE sale_id IN (SELECT id FROM sales WHERE project_id = ?)').bind(P.id),
        db.prepare('DELETE FROM sales WHERE project_id = ?').bind(P.id),
        db.prepare('DELETE FROM products WHERE project_id = ?').bind(P.id),
        db.prepare('DELETE FROM projects WHERE id = ?').bind(P.id),
      ]);
      await audit(db, 'マスター', role, '催しを削除', `${P.name}（会計 ${st.n} 件・売上 ${yen(st.total)}・商品 ${pc.n} 件を削除）`);
      return json(await projectsData(db));
    } else {
      // 催しの設定（催し名・模擬店名・期間・営業時間）の変更
      const f = readProjectFields(await readJson(request), P);
      await db.prepare('UPDATE projects SET name = ?, shop_name = ?, start_date = ?, end_date = ?, open_hour = ?, close_hour = ? WHERE id = ?')
        .bind(f.name, f.shopName, f.startDate, f.endDate, f.openHour, f.closeHour, P.id).run();
      await audit(db, 'マスター', role, '催しの設定を変更', `［${f.name}］${f.startDate}〜${f.endDate}・${f.openHour}:00〜${f.closeHour}:00` + (f.shopName ? `・${f.shopName}` : ''));
    }
    return json(await masterData(db, sess, await getProject(db, P.id)));
  }

  // ----- ここから下は、選んだ催し（?project= / X-Project）についての操作 -----
  const P = await projectFromRequest(db, request, url);
  const tag = `［${P.name}］`;
  const reload = async () => json(await masterData(db, sess, await getProject(db, P.id)));

  if (route === 'GET /api/master/data') return json(await masterData(db, sess, P));
  const csvName = request.method === 'GET' && url.pathname.match(/^\/api\/(?:admin|master)\/([a-z_]+\.csv)$/);
  if (csvName && CSV_FILES[csvName[1]]) return csvResponse(db, P, csvName[1], url.searchParams);

  if (route === 'POST /api/master/target') {
    const n = await setTarget(db, P, await readJson(request));
    await audit(db, 'マスター', role, '目標金額を変更', `${tag}${yen(P.target)} → ${yen(n)}`);
    return reload();
  }
  if (route === 'POST /api/master/products') {
    const body = await readJson(request);
    const { before, after } = await saveProduct(db, P, body);
    await audit(db, 'マスター', role, before ? '商品を変更' : '商品を追加', tag + (before ? productDiff(before, after) : productText(after)));
    return reload();
  }
  // 支払方法（この催しのレジに出す支払方法）
  if (route === 'POST /api/master/payments') {
    const next = parsePayments((await readJson(request)).payments);
    await db.prepare('UPDATE projects SET payments = ? WHERE id = ?').bind(JSON.stringify(next), P.id).run();
    await audit(db, 'マスター', role, '支払方法を変更', `${tag}${P.payments.join('・')} → ${next.join('・')}`);
    return reload();
  }
  if (route === 'POST /api/master/container-rule') {
    const after = await saveRule(db, P, await readJson(request));
    await audit(db, 'マスター', role, '容器代のルールを変更', `${tag}${ruleText(P.rule)} → ${ruleText(after)}`);
    return reload();
  }
  const pm = url.pathname.match(/^\/api\/master\/products\/(\d+)\/(move|delete)$/);
  if (request.method === 'POST' && pm) {
    const id = Number(pm[1]);
    const prod = await db.prepare('SELECT * FROM products WHERE id = ? AND project_id = ?').bind(id, P.id).first();
    if (!prod) throw httpError('商品が見つかりません', 404);
    if (pm[2] === 'delete') {
      const used = await db.prepare('SELECT COUNT(*) AS n FROM sale_items WHERE product_id = ?').bind(id).first();
      if (used.n > 0) throw httpError('販売の記録がある商品は削除できません。「販売中」を外して販売停止にしてください', 400);
      await db.batch([
        db.prepare('UPDATE products SET bundle_with = NULL WHERE bundle_with = ?').bind(id),   // この商品のセットに含めていた商品は単独に
        db.prepare('DELETE FROM products WHERE id = ?').bind(id),
      ]);
      await audit(db, 'マスター', role, '商品を削除', tag + prod.name);
    } else {
      const dir = Number((await readJson(request)).dir) < 0 ? -1 : 1;
      const list = (await db.prepare('SELECT id FROM products WHERE project_id = ? ORDER BY sort, id').bind(P.id).all()).results.map((x) => x.id);
      const i = list.indexOf(id), j = i + dir;
      if (j >= 0 && j < list.length) {
        [list[i], list[j]] = [list[j], list[i]];
        await db.batch(list.map((pid, k) => db.prepare('UPDATE products SET sort = ? WHERE id = ?').bind(k + 1, pid)));
      }
    }
    return reload();
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
    return reload();
  }
  if (route === 'POST /api/master/master-password') {
    const body = await readJson(request);
    await login(request, env, role, body.current, '現在のマスターパスワードが違います');
    await setPassword(db, 'master', body.next);
    // 他の端末のマスターログインは無効にする
    await revokeWhere(db, "role = 'master' AND id != ?", sess.id);
    await audit(db, 'マスター', role, 'マスターパスワードを変更', '他の端末のマスターログインを解除');
    return reload();
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
    return reload();
  }
  // 売上記録の全リセット（テスト用・この催しの会計だけ）。確認の文字とマスターパスワードの再入力が必要
  if (route === 'POST /api/master/reset-sales') {
    const body = await readJson(request);
    if (String(body.confirm || '').trim() !== 'リセット') throw httpError('確認のため「リセット」と入力してください', 400);
    await login(request, env, role, body.password, 'マスターパスワードが違います');
    const before = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN cancelled = 0 THEN amount ELSE 0 END), 0) AS total,
        COALESCE(SUM(cancelled), 0) AS cancelled FROM sales WHERE project_id = ?`).bind(P.id).first();
    await db.batch([
      db.prepare('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE project_id = ?)').bind(P.id),
      db.prepare('DELETE FROM sale_flavors WHERE sale_id IN (SELECT id FROM sales WHERE project_id = ?)').bind(P.id),
      db.prepare('DELETE FROM sales WHERE project_id = ?').bind(P.id),   // 会計番号（order_no）は次から #1 に戻る
      // 世代を進めて、リセット前にレジ端末で打った未送信の会計を受け付けないようにする
      db.prepare('UPDATE projects SET epoch = epoch + 1, kitchen_rev = kitchen_rev + 1 WHERE id = ?').bind(P.id),
    ]);
    await audit(db, 'マスター', role, '売上記録を全リセット',
      `${tag}会計 ${before.n} 件（うち取消 ${before.cancelled} 件・売上 ${yen(before.total)}）を削除`);
    return reload();
  }
  // 営業終了／再開（営業終了中はレジで新しい会計を記録できない）
  if (route === 'POST /api/master/closed') {
    const body = await readJson(request);
    await db.prepare('UPDATE projects SET closed_at = ? WHERE id = ?').bind(body.closed ? new Date().toISOString() : null, P.id).run();
    await audit(db, 'マスター', role, body.closed ? '営業終了' : '営業再開', tag + (body.closed ? 'レジの会計の記録を停止' : 'レジの会計の記録を再開'));
    return reload();
  }
  if (route === 'POST /api/master/unlock') {
    const res = await db.prepare('DELETE FROM login_failures').run();
    await audit(db, 'マスター', role, 'ログイン制限を解除', `失敗記録 ${res.meta.changes || 0} 件を消去`);
    return reload();
  }
  const m = url.pathname.match(/^\/api\/master\/sessions\/(\d+)\/revoke$/);
  if (request.method === 'POST' && m) {
    const id = Number(m[1]);
    if (id === sess.id) throw httpError('自分自身は締め出せません。ログアウトを使ってください', 400);
    const row = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
    if (!row) throw httpError('端末が見つかりません', 404);
    await revokeWhere(db, 'id = ?', id);
    await audit(db, 'マスター', role, '締め出し', `${ROLES[row.role].label}：${row.staff}（${row.device}）`);
    return reload();
  }
  return json({ error: 'Not Found' }, 404);
}

/** 催しの一覧の画面に渡すデータ */
async function projectsData(db) {
  return { projects: await projectList(db), active: await activeProjectId(db), today: jstDay().date };
}

async function setActiveProject(db, id) {
  await db.prepare("INSERT INTO settings (key, value) VALUES ('active_project', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(id)).run();
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
    // 催し（プロジェクト）。会計・商品は催しごと。設定（目標・容器代・営業時間など）も催しごとに持つ
    db.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      shop_name TEXT NOT NULL DEFAULT '',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      open_hour INTEGER NOT NULL DEFAULT 9,
      close_hour INTEGER NOT NULL DEFAULT 19,
      target INTEGER NOT NULL DEFAULT 30000,
      container_rule TEXT,
      closed_at TEXT,
      epoch INTEGER NOT NULL DEFAULT 1,
      kitchen_rev INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`),
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
  // 催しごとに分ける列（後から追加）。会計番号 order_no は催しごとに #1 から
  if (!cols.results.some((c) => c.name === 'project_id')) await addColumn(db, 'ALTER TABLE sales ADD COLUMN project_id INTEGER');
  if (!cols.results.some((c) => c.name === 'order_no')) await addColumn(db, 'ALTER TABLE sales ADD COLUMN order_no INTEGER');
  if (!pcols.results.some((c) => c.name === 'project_id')) await addColumn(db, 'ALTER TABLE products ADD COLUMN project_id INTEGER');
  // 催しごとの支払方法（JSON の配列。null ならこれまでの 現金・PayPay・d払い）
  const prcols = await db.prepare('PRAGMA table_info(projects)').all();
  if (!prcols.results.some((c) => c.name === 'payments')) await addColumn(db, 'ALTER TABLE projects ADD COLUMN payments TEXT');
  await migrateToProjects(db);
  await db.batch([
    db.prepare('CREATE INDEX IF NOT EXISTS sales_project ON sales (project_id, id)'),
    // 商品名の重複チェックは催しごと（前の催しから同じ名前の商品を複製できるように）
    db.prepare('DROP INDEX IF EXISTS products_name'),
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS products_project_name ON products (project_id, name)'),
  ]);
  schemaReady = true;
}

/**
 * 催し（プロジェクト）を入れる前のデータを、最初の催しにまとめる。
 * 何度実行しても同じ結果になる（すでに移したものは触らない）。
 *   - 催しがまだ 1 つもなければ、催し #1 を作る。会計か商品があれば名前は LEGACY_PROJECT_NAME（本番の既存データ）
 *   - 目標・容器代のルール・営業終了・リセットの世代・キッチンの版は、これまでの settings から引き継ぐ
 *   - 催しの決まっていない会計・商品を催し #1 に入れ、会計番号（order_no）はこれまでの番号（id）のまま
 */
async function migrateToProjects(db) {
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM projects').first();
  if (n === 0) {
    const legacy = await db.prepare('SELECT MIN(created_at) AS a, MAX(created_at) AS b, COUNT(*) AS n FROM sales').first();
    const pc = await db.prepare('SELECT COUNT(*) AS n FROM products').first();
    const st = {};
    for (const r of (await db.prepare("SELECT key, value FROM settings WHERE key IN ('target', 'container_rule', 'sales_closed_at', 'sales_epoch', 'kitchen_rev')").all()).results) st[r.key] = r.value;
    const hasData = legacy.n > 0 || pc.n > 0;
    const today = jstDay().date;
    const start = legacy.a ? jstDate(legacy.a) : today;
    const end = legacy.b ? jstDate(legacy.b) : start;
    await db.prepare(`INSERT INTO projects (id, name, shop_name, start_date, end_date, open_hour, close_hour, target, container_rule, closed_at, epoch, kitchen_rev, created_at)
        SELECT 1, ?, ?, ?, ?, 9, 19, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM projects)`)
      .bind(hasData ? LEGACY_PROJECT_NAME : '最初の催し', hasData ? LEGACY_SHOP_NAME : '', start, end,
        Number(st.target) || DEFAULT_TARGET, st.container_rule || null, st.sales_closed_at || null,
        Number(st.sales_epoch) || 1, Number(st.kitchen_rev) || 0, new Date().toISOString()).run();
  }
  await db.batch([
    db.prepare('UPDATE sales SET project_id = 1 WHERE project_id IS NULL'),
    db.prepare('UPDATE sales SET order_no = id WHERE order_no IS NULL'),
    db.prepare('UPDATE products SET project_id = 1 WHERE project_id IS NULL'),
    db.prepare("INSERT INTO settings (key, value) VALUES ('active_project', (SELECT MIN(id) FROM projects)) ON CONFLICT(key) DO NOTHING"),
  ]);
}

// ===== 催し（プロジェクト） =====
const LEGACY_PROJECT_NAME = '26岡山大学祭';            // 催しを入れる前からある本番のデータの催し名
const LEGACY_SHOP_NAME = '混声合唱と学祭のための 団子';   // 同じく模擬店の名前（ダッシュボードに表示）

function rowToProject(r) {
  let rule = {};
  try { rule = JSON.parse(r.container_rule || '{}') || {}; } catch {}
  let payments = null;
  try { payments = JSON.parse(r.payments || 'null'); } catch {}
  if (!Array.isArray(payments) || !payments.length) payments = [...DEFAULT_PAYMENTS];
  return {
    id: r.id, name: r.name, shopName: r.shop_name || '', startDate: r.start_date, endDate: r.end_date,
    openHour: r.open_hour, closeHour: r.close_hour, target: r.target, rule: { ...DEFAULT_RULE, ...rule },
    closedAt: r.closed_at || null, epoch: r.epoch, rev: r.kitchen_rev, createdAt: r.created_at, payments,
  };
}

async function getProject(db, id) {
  const row = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(Math.floor(Number(id)) || 0).first();
  return row ? rowToProject(row) : null;
}

async function activeProjectId(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'active_project'").first();
  return row ? Number(row.value) : 1;
}

/** レジ・キッチン・ダッシュボードで使う催し（管理画面で「レジで使う」にした催し） */
async function getActiveProject(db) {
  const p = await getProject(db, await activeProjectId(db));
  if (p) return p;
  const first = await db.prepare('SELECT * FROM projects ORDER BY id LIMIT 1').first();
  if (!first) throw httpError('催しがありません。管理画面で作ってください', 503);
  return rowToProject(first);
}

/** 管理画面の操作の対象の催し（?project= または X-Project。なければレジで使っている催し） */
async function projectFromRequest(db, request, url) {
  const id = url.searchParams.get('project') || request.headers.get('X-Project');
  if (!id) return getActiveProject(db);
  const p = await getProject(db, id);
  if (!p) throw httpError('催しが見つかりません', 404);
  return p;
}

/** 操作の記録に付ける催しの名前（例: ［26岡山大学祭］） */
async function projectLabel(db, id) {
  const p = await getProject(db, id);
  return p ? `［${p.name}］` : '';
}

/** 画面に渡す催しの情報 */
const projectInfo = (P) => ({ id: P.id, name: P.name, shopName: P.shopName, startDate: P.startDate, endDate: P.endDate, openHour: P.openHour, closeHour: P.closeHour, payments: P.payments });

/** 支払方法の一覧を整える（1〜MAX_PAYMENTS 種類・重複なし・1 つ 20 文字まで） */
function parsePayments(v) {
  if (!Array.isArray(v)) throw httpError('支払方法が不正です', 400);
  const out = [];
  for (const x of v) {
    const n = cleanName(x).slice(0, 20);
    if (n && !out.includes(n)) out.push(n);
  }
  if (!out.length) throw httpError('支払方法を1つ以上選んでください', 400);
  if (out.length > MAX_PAYMENTS) throw httpError(`支払方法は${MAX_PAYMENTS}種類までです`, 400);
  return out;
}

/** 催しの入力（名前・模擬店名・期間・営業時間・目標）をチェックして整える */
function readProjectFields(body, base = {}) {
  const name = cleanName(body.name ?? base.name).slice(0, 40);
  if (!name) throw httpError('催し名を入力してください', 400);
  const shopName = cleanName(body.shopName ?? base.shopName ?? '').slice(0, 40);
  const date = (v, label) => {
    const s = String(v || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) throw httpError(`${label}を入力してください`, 400);
    return s;
  };
  const startDate = date(body.startDate ?? base.startDate, '開始日');
  const endDate = date(body.endDate ?? base.endDate, '終了日');
  if (endDate < startDate) throw httpError('終了日は開始日と同じか、それより後にしてください', 400);
  const openHour = intIn(body.openHour ?? base.openHour ?? 9, 0, 23, '営業開始の時刻');
  const closeHour = intIn(body.closeHour ?? base.closeHour ?? 19, 1, 24, '営業終了の時刻');
  if (closeHour <= openHour) throw httpError('営業終了の時刻は、開始より後にしてください', 400);
  const target = intIn(body.target ?? base.target ?? DEFAULT_TARGET, 1, 100000000, '目標金額');
  return { name, shopName, startDate, endDate, openHour, closeHour, target };
}

/** 催しの一覧（会計の件数・売上つき） */
async function projectList(db) {
  const rows = (await db.prepare(`SELECT p.*, 
      (SELECT COUNT(*) FROM sales s WHERE s.project_id = p.id AND s.cancelled = 0) AS orders,
      (SELECT COALESCE(SUM(amount), 0) FROM sales s WHERE s.project_id = p.id AND s.cancelled = 0) AS total,
      (SELECT COUNT(*) FROM products x WHERE x.project_id = p.id) AS products
    FROM projects p ORDER BY p.start_date DESC, p.id DESC`).all()).results;
  const active = await activeProjectId(db);
  return rows.map((r) => ({ ...projectInfo(rowToProject(r)), containerEnabled: rowToProject(r).rule.enabled !== false, target: r.target, orders: r.orders, total: r.total, products: r.products, active: r.id === active }));
}

/**
 * 催しを作る。copyFrom があれば、その催しから選んだ設定（商品・価格・味・セット / 容器代のルール / 目標金額）を複製する。
 * 会計（売上）は複製しない。
 */
async function createProject(db, body) {
  const f = readProjectFields(body);
  const copy = body.copy || {};
  const src = body.copyFrom ? await getProject(db, body.copyFrom) : null;
  if (body.copyFrom && !src) throw httpError('複製元の催しが見つかりません', 400);
  if (src && copy.target && body.target == null) f.target = src.target;
  // 容器代のルール：複製するなら複製元のルール、しないなら初期値。取る／取らないは入力（なければ複製元に合わせる）
  const baseRule = src && copy.rule ? src.rule : { ...DEFAULT_RULE };
  const containerEnabled = body.containerEnabled != null ? !!body.containerEnabled : baseRule.enabled !== false;
  const rule = JSON.stringify({ ...baseRule, enabled: containerEnabled });
  // 支払方法：複製するなら複製元と同じ、入力があればそれ、なければ 現金・PayPay・d払い
  const payments = src && copy.payments ? src.payments : body.payments ? parsePayments(body.payments) : [...DEFAULT_PAYMENTS];
  const res = await db.prepare(`INSERT INTO projects (name, shop_name, start_date, end_date, open_hour, close_hour, target, container_rule, payments, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(f.name, f.shopName, f.startDate, f.endDate, f.openHour, f.closeHour, f.target, rule, JSON.stringify(payments), new Date().toISOString()).run();
  const id = res.meta.last_row_id;
  let copied = 0;
  if (src && copy.products) {
    const rows = (await db.prepare('SELECT * FROM products WHERE project_id = ? ORDER BY sort, id').bind(src.id).all()).results;
    // 商品を 1 つずつ複製して、新しい ID を控える（「○○のセットに含める」の相手を新しい ID に付け替えるため）
    const map = new Map();
    for (const r of rows) {
      const ins = await db.prepare(`INSERT INTO products (project_id, name, unit, sets, container, active, sort, flavors, bundle_with)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`).bind(id, r.name, r.unit, r.sets, r.container, r.active, r.sort, r.flavors || '[]').run();
      map.set(r.id, ins.meta.last_row_id);
    }
    const links = rows.filter((r) => r.bundle_with && map.has(r.bundle_with));
    if (links.length) await db.batch(links.map((r) => db.prepare('UPDATE products SET bundle_with = ? WHERE id = ?').bind(map.get(r.bundle_with), map.get(r.id))));
    copied = rows.length;
  }
  return { id, name: f.name, src, copied, copy, containerEnabled };
}

// ===== 商品・容器代 =====
function rowToProduct(r) {
  let flavors = [];
  try { flavors = JSON.parse(r.flavors || '[]'); } catch {}
  return { id: r.id, name: r.name, unit: r.unit, sets: JSON.parse(r.sets), container: !!r.container, active: !!r.active, sort: r.sort, bundleWith: r.bundle_with || null,
    flavors: Array.isArray(flavors) ? flavors : [] };
}

/** 催しの商品（並び順）。all = false なら販売中だけ */
async function getProducts(db, projectId, { all = false } = {}) {
  const rows = (await db.prepare(`SELECT * FROM products WHERE project_id = ? ${all ? '' : 'AND active = 1'} ORDER BY sort, id`).bind(projectId).all()).results;
  return rows.map(rowToProduct);
}


function intIn(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(`${label}は${min}〜${max}の整数で入力してください`, 400);
  return n;
}

async function saveRule(db, P, body) {
  const rule = {
    enabled: body.enabled !== false,   // false = この催しでは容器代を取らない
    freeUpTo: intIn(body.freeUpTo, 0, 999, '無料になる数'),
    per: intIn(body.per, 1, 999, '何個ごとか'),
    fee: intIn(body.fee, 0, 10000, '容器代の金額'),
    maxCount: intIn(body.maxCount ?? 0, 0, 999, '容器の数の上限'),
  };
  await db.prepare('UPDATE projects SET container_rule = ? WHERE id = ?').bind(JSON.stringify(rule), P.id).run();
  return rule;
}

const ruleText = (r) => (r.enabled === false ? '容器代なし' : '') || `${r.freeUpTo}個まで無料・${r.per}個ごとに${r.fee}円` + (r.maxCount > 0 ? `・最大${r.maxCount}個（${r.maxCount * r.fee}円）まで` : '・上限なし');
const productText = (p) => `${p.name}：` + p.sets.map((s) => `${s.qty}${p.unit}${s.price}円`).join('・') +
  ((p.flavors || []).length ? `（味：${p.flavors.join('・')}）` : '') + (p.container ? '（容器代対象）' : '') + (p.bundleWith ? `（${p.bundleName || '別の商品'}のセットに含める）` : '') + (p.active ? '' : '（販売停止）');
function productDiff(a, b) {
  const t = productText(a), u = productText(b);
  return t === u ? u : `${t} → ${u}`;
}

async function saveProduct(db, P, body) {
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
  const dup = await db.prepare('SELECT id FROM products WHERE project_id = ? AND name = ? AND id != ?').bind(P.id, name, Number(body.id) || 0).first();
  if (dup) throw httpError(`「${name}」という商品はすでにあります`, 400);
  // 「○○のセットに含める」：相手は自分以外で、相手自身はほかの商品のセットに含めていないこと（1 段だけ）
  let bundleWith = Number(body.bundleWith) || null;
  if (bundleWith) {
    const self = Number(body.id) || 0;
    if (bundleWith === self) throw httpError('自分自身のセットには含められません', 400);
    const leader = await db.prepare('SELECT id, name, bundle_with FROM products WHERE id = ? AND project_id = ?').bind(bundleWith, P.id).first();
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
    const row = await db.prepare('SELECT * FROM products WHERE id = ? AND project_id = ?').bind(Number(body.id), P.id).first();
    if (!row) throw httpError('商品が見つかりません', 404);
    before = rowToProduct(row);
    await db.prepare('UPDATE products SET name = ?, unit = ?, sets = ?, container = ?, active = ?, bundle_with = ?, flavors = ? WHERE id = ?')
      .bind(name, unit, JSON.stringify(sets), container, active, bundleWith, JSON.stringify(flavors), before.id).run();
  } else {
    const { m } = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM products WHERE project_id = ?').bind(P.id).first();
    await db.prepare('INSERT INTO products (project_id, name, unit, sets, container, active, sort, bundle_with, flavors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(P.id, name, unit, JSON.stringify(sets), container, active, m + 1, bundleWith, JSON.stringify(flavors)).run();
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
    // 商品管理を入れる前の古い記録（最初の催しの、1 種類の商品だけの頃）
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
function bumpRev(db, projectId) {
  return db.prepare('UPDATE projects SET kitchen_rev = kitchen_rev + 1 WHERE id = ?').bind(projectId);
}


/**
 * キッチンの注文キュー：今日（日本時間）の注文を、サーバーに届いた順に。
 * 端末が持っている rev と日付が今と同じなら、注文は返さない（数秒ごとに読まれるので軽くする）。
 */
async function kitchenData(db, P, params) {
  const day = jstDay();
  const rev = P.rev;
  const closed = closedOf(P);
  // 変化なし：同じ催し・同じ版・同じ日
  if (params.get('project') === String(P.id) && params.get('rev') === String(rev) && params.get('day') === day.date) return { rev, day: day.date, same: true, closed };
  const sales = (await db.prepare(`SELECT id, order_no, created_at, cancelled, kitchen_done_at, staff FROM sales
      WHERE project_id = ? AND created_at >= ? AND created_at < ? ORDER BY id`).bind(P.id, day.start, day.end).all()).results;
  const fl = (await db.prepare(`SELECT sf.sale_id, sf.product_id, sf.name, sf.unit, sf.flavor, sf.qty FROM sale_flavors sf
      JOIN sales s ON s.id = sf.sale_id WHERE s.project_id = ? AND s.created_at >= ? AND s.created_at < ? ORDER BY sf.id`).bind(P.id, day.start, day.end).all()).results;
  // 味の記録がない古い会計は、明細（sale_items）から商品ごとの数を出す
  const withFl = new Set(fl.map((f) => f.sale_id));
  const old = sales.filter((x) => !withFl.has(x.id));
  let items = [];
  if (old.length) {
    items = (await db.prepare(`SELECT si.sale_id, si.product_id, si.name, si.unit, si.set_qty * si.count AS qty FROM sale_items si
        JOIN sales s ON s.id = si.sale_id WHERE s.project_id = ? AND s.created_at >= ? AND s.created_at < ? ORDER BY si.id`).bind(P.id, day.start, day.end).all()).results;
  }
  const products = await getProducts(db, P.id, { all: true });
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
      id: x.id, no: x.order_no ?? x.id, createdAt: x.created_at, cancelled: !!x.cancelled, doneAt: x.kitchen_done_at || null, staff: x.staff,
      lines: lines.map((l) => ({ productId: l.product_id, name: l.name, unit: l.unit, flavor: l.flavor, qty: l.qty })),
    };
  });
  return {
    rev, day: day.date, closed, orders, project: projectInfo(P),
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

/** 営業終了の状態（管理画面で設定）。null なら営業中 */
const closedOf = (P) => (P.closedAt ? { at: P.closedAt } : null);




/** 今日（日本時間）の日付と、その範囲（UTC の ISO 文字列） */
/** ISO の日時を日本時間の日付（YYYY-MM-DD）に */
function jstDate(iso) {
  return new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);
}

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
async function hourlySales(db, P) {
  const JST = 9 * 3600000;
  const nowJst = new Date(Date.now() + JST);
  const y = nowJst.getUTCFullYear(), m = nowJst.getUTCMonth(), d = nowJst.getUTCDate();
  const start = new Date(Date.UTC(y, m, d) - JST);
  const end = new Date(start.getTime() + 86400000);
  const rows = (await db.prepare('SELECT created_at, amount FROM sales WHERE project_id = ? AND cancelled = 0 AND created_at >= ? AND created_at < ?')
    .bind(P.id, start.toISOString(), end.toISOString()).all()).results;
  const buckets = [];
  for (let h = P.openHour; h < P.closeHour; h++) buckets.push({ hour: h, amount: 0, orders: 0 });
  const outside = { amount: 0, orders: 0 };
  for (const r of rows) {
    const h = new Date(Date.parse(r.created_at) + JST).getUTCHours();
    const b = buckets.find((x) => x.hour === h) || outside;
    b.amount += r.amount;
    b.orders += 1;
  }
  return {
    date: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    open: P.openHour, close: P.closeHour,
    nowHour: nowJst.getUTCHours(),
    buckets, outside,
  };
}

/** 催しの集計（ダッシュボード・レジ・管理画面で共通） */
async function summary(db, P) {
  const t = await db.prepare(`SELECT
      COUNT(*) AS orders,
      COALESCE(SUM(amount), 0) AS total,
      COALESCE(SUM(goods), 0) AS goods,
      COALESCE(SUM(container), 0) AS container,
      COALESCE(SUM(sticks), 0) AS units
    FROM sales WHERE project_id = ? AND cancelled = 0`).bind(P.id).first();
  // 商品ごと・セットごとの集計（その時点の商品名で）
  const packs = (await db.prepare(`SELECT si.product_id, MAX(si.name) AS name, MAX(si.unit) AS unit, si.set_qty, si.set_price, SUM(si.count) AS count,
        (si.pack_label IS NOT NULL) AS mixed
      FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.project_id = ? AND s.cancelled = 0
      GROUP BY si.product_id, si.set_qty, si.set_price, (si.pack_label IS NOT NULL)`).bind(P.id).all()).results;
  const products = await getProducts(db, P.id);
  const rule = P.rule;
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
      FROM sale_flavors sf JOIN sales s ON s.id = sf.sale_id WHERE s.project_id = ? AND s.cancelled = 0
      GROUP BY sf.product_id, sf.flavor`).bind(P.id).all()).results;
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
    FROM sales WHERE project_id = ? AND cancelled = 0 GROUP BY payment`).bind(P.id).all();

  // 支払方法ごと：今の催しで使う支払方法（0 件でも）＋ 記録にだけある支払方法（途中で外したものなど）
  const byPayment = {};
  const payments = [...P.payments];
  P.payments.forEach((p) => (byPayment[p] = { amount: 0, count: 0 }));
  pays.results.forEach((r) => {
    if (!payments.includes(r.payment)) payments.push(r.payment);
    byPayment[r.payment] = { amount: r.amount, count: r.count };
  });

  const target = P.target;
  return {
    project: projectInfo(P),
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
    payments,                    // 集計の並び（記録にだけある支払方法も含む）
    payMethods: P.payments,      // レジのボタンに出す支払方法
    avgPerOrder: t.orders > 0 ? Math.round(t.total / t.orders) : 0,   // 客単価（取消を除く）
    closed: closedOf(P),   // 営業終了中なら { at }
    hourly: await hourlySales(db, P),
    updatedAt: new Date().toISOString(),
  };
}

async function recentAudit(db, limit) {
  return (await db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').bind(limit).all()).results;
}

/** 会計一覧（新しい順・ページ送り）。取消済みも含む */
async function salesPage(db, P, params) {
  const limit = Math.min(100, Math.max(1, Math.floor(Number(params.get('limit')) || 50)));
  const before = Math.floor(Number(params.get('before')) || 0);
  const rows = (before > 0
    ? await db.prepare('SELECT * FROM sales WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?').bind(P.id, before, limit + 1).all()
    : await db.prepare('SELECT * FROM sales WHERE project_id = ? ORDER BY id DESC LIMIT ?').bind(P.id, limit + 1).all()).results;
  const counts = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(cancelled), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN cancelled = 0 THEN amount ELSE 0 END), 0) AS amount FROM sales WHERE project_id = ?`).bind(P.id).first();
  return { project: projectInfo(P), sales: await attachItems(db, rows.slice(0, limit)), hasMore: rows.length > limit, ...counts };
}

async function registerData(db, sess) {
  const P = await getActiveProject(db);
  const recent = await db.prepare('SELECT * FROM sales WHERE project_id = ? ORDER BY id DESC LIMIT 5').bind(P.id).all();
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM sales WHERE project_id = ?').bind(P.id).first();
  return {
    ...(await summary(db, P)),
    recent: await attachItems(db, recent.results),
    salesCount: n,
    epoch: P.epoch,
    audit: await recentAudit(db, 30),
    me: { staff: sess.staff, expiresAt: sess.expires_at },
  };
}

async function masterData(db, sess, P) {
  const sessions = await db.prepare(`SELECT id, role, staff, device, created_at, last_seen, expires_at FROM sessions
      WHERE revoked = 0 AND expires_at > ? ORDER BY role, last_seen DESC`).bind(new Date().toISOString()).all();
  const pw = await db.prepare("SELECT key FROM settings WHERE key IN ('register_pw_hash', 'master_pw_hash')").all();
  const changed = pw.results.map((r) => r.key);
  const locks = await db.prepare(`SELECT role, COUNT(*) AS n FROM login_failures WHERE at > ? GROUP BY ip, role HAVING n >= ?`)
    .bind(new Date(Date.now() - LOCK_MINUTES * 60000).toISOString(), MAX_FAILS).all();
  return {
    ...(await summary(db, P)),
    projects: await projectList(db),
    projectSettings: { ...projectInfo(P), target: P.target, active: P.id === await activeProjectId(db) },
    sessions: sessions.results.map((s) => ({ ...s, current: s.id === sess.id })),
    audit: await recentAudit(db, 200),
    passwords: {
      registerChanged: changed.includes('register_pw_hash'),
      masterChanged: changed.includes('master_pw_hash'),
    },
    locked: locks.results.map((l) => ROLES[l.role].label),
    allProducts: await getProducts(db, P.id, { all: true }),
    allSales: await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cancelled), 0) AS cancelled FROM sales WHERE project_id = ?').bind(P.id).first(),
    me: { expiresAt: sess.expires_at },
  };
}

async function recordSale(db, body, staff) {
  // 会計した時点の催し（オフラインで打った会計は、そのあと催しが切り替わっても元の催しに記録する）
  const P = body.projectId != null ? await getProject(db, body.projectId) : await getActiveProject(db);
  if (!P) throw httpError('この会計の催しが見つかりません（管理画面で削除された可能性があります）', 409);
  // 支払方法：その催しの支払方法のどれか。オフラインで打ったあとに管理画面で外された支払方法は、
  // お客さんからはもう受け取っているので記録し、操作の記録に残す（明細つきの今のレジの画面から届いたときだけ）
  const payment = cleanName(body.payment).slice(0, 20);
  if (!payment) throw httpError('支払方法が不正です', 400);
  const paymentOff = !P.payments.includes(payment);
  if (paymentOff && !Array.isArray(body.lines)) throw httpError('この催しでは使わない支払方法です。画面を更新してください', 409);
  // 営業終了後に打った会計は受け付けない（終了前に端末で打って、あとから届いた未送信の会計は受け付ける）
  const closed = closedOf(P);
  if (closed) {
    const t = Date.parse(body.createdAt);
    if (!Number.isFinite(t) || t >= Date.parse(closed.at)) throw httpError('営業は終了しました。会計は記録できません', 423);
  }
  const clientId = body.clientId == null ? null : String(body.clientId).slice(0, 64);
  if (clientId && !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw httpError('会計IDが不正です', 400);
  // 売上記録の全リセットより前に端末で打った会計は捨てる（リセットした記録を復活させない）
  if (body.epoch != null && Number(body.epoch) !== P.epoch) return { stale: true };
  // 同じ会計ID がすでにあれば何もしない（再送による二重登録の防止）
  if (clientId && await db.prepare('SELECT id FROM sales WHERE client_id = ?').bind(clientId).first()) return { duplicate: true };

  const snapshot = Array.isArray(body.lines) ? body.lines : null;   // 端末で計算した明細（オフライン対応版の画面が送る）
  const all = await getProducts(db, P.id, { all: true });
  const rule = P.rule;
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

  // 容器代は手動修正も可（未指定なら自動計算）。容器代を取らない催しでは 0（端末の金額で記録する会計を除く）
  const container = P.rule.enabled === false && !mismatch ? 0
    : body.container == null || body.container === ''
      ? auto
      : Math.max(0, Math.floor(Number(body.container) || 0));

  // 会計の時刻: 端末で会計した時刻（オフライン中の会計を正しい時刻で残す）。不自然な値ならサーバーの時刻
  const now = Date.now();
  const t = Date.parse(body.createdAt);
  const createdAt = Number.isFinite(t) && t <= now + 5 * 60000 && t >= now - 7 * 86400000 ? new Date(t).toISOString() : new Date(now).toISOString();

  const cid = clientId || 'srv-' + b64url(crypto.getRandomValues(new Uint8Array(12)));
  // 会計と明細を 1 つのトランザクションで書く（明細は client_id で会計を引く）
  // 会計番号（order_no）は催しごとに 1 から。1 つの INSERT の中で決めるので、同時に届いても重ならない
  const stmts = [db.prepare(`INSERT INTO sales
      (project_id, order_no, created_at, sticks, goods, container, container_auto, amount, payment, staff, client_id)
      VALUES (?, (SELECT COALESCE(MAX(order_no), 0) + 1 FROM sales WHERE project_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(P.id, P.id, createdAt, units, goods, container, auto, goods + container, payment, staff, cid)];
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
  stmts.push(bumpRev(db, P.id));
  try {
    await db.batch(stmts);
  } catch (e) {
    // 同じ会計ID が同時に届いた（もう一方が先に記録済み）
    if (clientId && /UNIQUE/i.test(String(e.message))) return { duplicate: true };
    throw e;
  }
  if (paymentOff) {
    await audit(db, staff, 'register', '今は使っていない支払方法で記録', `［${P.name}］${payment} ${yen(goods + container)}（端末で会計した支払方法のまま）`);
  }
  if (mismatch) {
    await audit(db, staff, 'register', '今の価格と違う会計を記録',
      `［${P.name}］${withFlavors(describeItems(items), flavorRows)} ${yen(goods + container)}（端末で会計した金額のまま）`);
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

async function setTarget(db, P, body) {
  const n = Math.floor(Number(body.target));
  if (!(n > 0)) throw httpError('目標金額が不正です', 400);
  await db.prepare('UPDATE projects SET target = ? WHERE id = ?').bind(n, P.id).run();
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
//   sales_ja.csv    手集計用（Excel 向け。日本語の項目名、味ごとの本数を列に。定義は docs/csv-tally-spec.md）
// 共通: 1 行目が項目名（英数字の物理名）、2 行目からデータ。UTF-8（BOM 付き。?bom=0 で BOM なし）、改行 CRLF。
//       金額は円の整数、日時は ISO 8601（+09:00）。取り消した会計は含めない。
const CSV_FILES = {
  'sales.csv': salesCsvRows,
  'sale_items.csv': saleItemsCsvRows,
  'sale_packs.csv': salePacksCsvRows,
  'sales_ja.csv': salesJaCsvRows,
};

async function csvResponse(db, P, name, params) {
  const sales = await attachItems(db, (await db.prepare('SELECT * FROM sales WHERE project_id = ? AND cancelled = 0 ORDER BY id').bind(P.id).all()).results);
  const rows = CSV_FILES[name](sales, { products: await getProducts(db, P.id, { all: true }), project: P });
  const body = rows.map((cols) => cols.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const stamp = isoJst(new Date().toISOString()).slice(0, 16).replace(/[-:T]/g, '');
  const bom = params.get('bom') === '0' ? '' : '﻿';   // Excel で文字化けしないよう既定は BOM 付き
  return new Response(bom + body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8; header=present',
      // ファイル名に催しの番号を入れる（例: mogiten_p1_sales_202611021930.csv）
      'content-disposition': `attachment; filename="mogiten_p${P.id}_${name.replace('.csv', '')}_${stamp}.csv"`,
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

function salesCsvRows(sales, { project }) {
  const header = ['sale_id', 'project_id', 'order_no', 'sold_at', 'business_date', 'payment_method', 'item_quantity',
    'goods_amount_yen', 'container_fee_charged_yen', 'container_fee_auto_yen', 'total_amount_yen', 'staff_name', 'kitchen_done_at'];
  return [header].concat(sales.map((r) => [
    r.id, project.id, r.order_no, isoJst(r.created_at), businessDate(r.created_at), r.payment, r.sticks,
    r.goods, r.container, r.container_auto, r.amount, r.staff, r.kitchen_done_at ? isoJst(r.kitchen_done_at) : null,
  ]));
}

/** 会計の商品・味ごとの数（[{ product_id, name, unit, flavor, qty }]） */
function saleLines(r) {
  const lines = r.flavors.map((f) => ({ product_id: f.product_id, name: f.name, unit: f.unit, flavor: f.flavor, qty: f.qty }));
  if (lines.length) return lines;
  // 味の記録がない古い会計：セットの明細から商品ごとの数を出す（味は空）
  const by = new Map();
  for (const it of r.items) {
    const g = by.get(it.product_id + '\u0000' + it.name) || { product_id: it.product_id, name: it.name, unit: it.unit, flavor: '', qty: 0 };
    g.qty += it.set_qty * it.count;
    by.set(it.product_id + '\u0000' + it.name, g);
  }
  return [...by.values()];
}

function saleItemsCsvRows(sales) {
  const header = ['sale_id', 'sold_at', 'business_date', 'product_id', 'product_name', 'flavor', 'quantity', 'unit_name'];
  const rows = [header];
  for (const r of sales) {
    for (const l of saleLines(r)) rows.push([r.id, isoJst(r.created_at), businessDate(r.created_at), l.product_id || null, l.name, l.flavor || null, l.qty, l.unit]);
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

/**
 * 手集計用（Excel 向け）：1 行 = 1 会計。日本語の項目名、商品・味ごとの本数を 1 列ずつ（横持ち）。
 * 要件と項目の定義は docs/csv-tally-spec.md
 */
function salesJaCsvRows(sales, { products }) {
  const linesOf = new Map(sales.map((r) => [r.id, saleLines(r)]));
  // 商品のまとまり（商品 ID ごと。ID のない古い記録は名前ごと）
  const keyOf = (l) => (l.product_id ? 'id:' + l.product_id : 'name:' + l.name);
  const groups = new Map();
  const groupFor = (key, name, unit, flavors) => {
    if (!groups.has(key)) groups.set(key, { name, unit, flavors: [...flavors], hasBlank: false, hasFlavor: flavors.length > 0, used: false });
    return groups.get(key);
  };
  // 今の商品の並び順・味の並び順（販売停止で売れていない商品は出さない）
  for (const p of products) groupFor('id:' + p.id, p.name, p.unit, p.flavors || []).active = p.active;
  for (const ls of linesOf.values()) {
    for (const l of ls) {
      const g = groupFor(keyOf(l), l.name, l.unit, []);
      g.used = true;
      if (l.flavor) { g.hasFlavor = true; if (!g.flavors.includes(l.flavor)) g.flavors.push(l.flavor); } else g.hasBlank = true;
    }
  }
  const shown = [...groups.entries()].filter(([, g]) => g.used || g.active);
  // 列の定義: { title, get(会計の lines) }
  const cols = [];
  for (const [key, g] of shown) {
    const mine = (ls) => ls.filter((l) => keyOf(l) === key);
    const sum = (ls) => ls.reduce((a, l) => a + l.qty, 0);
    if (g.hasFlavor) {
      for (const f of g.flavors) cols.push({ title: `${g.name} ${f}(${g.unit})`, get: (ls) => sum(mine(ls).filter((l) => l.flavor === f)) });
      if (g.hasBlank) cols.push({ title: `${g.name} 味の指定なし(${g.unit})`, get: (ls) => sum(mine(ls).filter((l) => !l.flavor)) });
      cols.push({ title: `${g.name} 計(${g.unit})`, get: (ls) => sum(mine(ls)) });
    } else {
      cols.push({ title: `${g.name}(${g.unit})`, get: (ls) => sum(mine(ls)) });
    }
  }
  const units = new Set(shown.map(([, g]) => g.unit));
  const unitAll = units.size === 1 ? [...units][0] : '点';
  const header = ['会計番号', '日付', '時刻', '支払方法', '担当者', ...cols.map((c) => c.title),
    `販売数(${unitAll})`, '商品代(円)', '容器代(円)', '容器代の自動計算(円)', '容器代の手直し', '合計(円)', 'キッチンでできた時刻', '内容（参考）'];
  return [header].concat(sales.map((r) => {
    const ls = linesOf.get(r.id);
    const t = isoJst(r.created_at);
    return [r.order_no ?? r.id, t.slice(0, 10).replace(/-/g, '/'), t.slice(11, 19), r.payment, r.staff, ...cols.map((c) => c.get(ls)),
      r.sticks, r.goods, r.container, r.container_auto, r.container !== r.container_auto ? 'あり' : 'なし', r.amount,
      r.kitchen_done_at ? isoJst(r.kitchen_done_at).slice(11, 19) : null, r.desc];
  }));
}
