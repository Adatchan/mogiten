# mogiten — 団子の売上ダッシュボード & かんたんレジ

学祭の模擬店「混声合唱と学祭のための 団子」用の売上ダッシュボードです。
**Cloudflare Workers + D1**（無料プラン）で動きます。

| 画面 | URL | 認証 |
|---|---|---|
| ダッシュボード | `https://mogiten.<あなたのサブドメイン>.workers.dev/` | 不要（誰でも見られる） |
| レジ（管理画面） | `https://mogiten.<あなたのサブドメイン>.workers.dev/admin` | 簡易パスワード（端末に記憶） |

## できること

**ダッシュボード**（20秒ごとに自動更新）
- 現在の売上（団子代と容器代の内訳つき）、目標金額、達成率のバー
- 目標まであといくらか（達成後は超過額）
- 売れた本数の合計と、セットごとの個数（1本 / 3本 / 5本）
- 支払方法ごとの内訳（現金 / PayPay / d払い）
- **売上明細の CSV ダウンロード**（Excel でも文字化けしません）

**レジ**
- 「1本 150円」「3本 400円」「5本 500円」ボタンでお会計に追加（＋/− で個数を調整）
- **容器代を自動で計算して合計に加算**（1会計の合計本数で判定）

  | 本数 | 容器代 |
  |---|---|
  | 1〜2本 | なし |
  | 3〜4本 | 10円 |
  | 5〜8本 | 20円 |
  | 9〜12本 | 30円 |
  | 以降4本ごとに | ＋10円 |

- 容器代は −/＋ で手動修正もできます（「手動」と表示され、「自動に戻す」で自動計算に戻せます）
- 現金のときはお預かり金額を入れるとおつりを表示
- 「現金」「PayPay」「d払い」ボタンで、その支払方法として記録
- 最近の会計の一覧から「取消」できます（「戻す」で元に戻せます）
- 目標金額の変更

## 構成

```
public/index.html   ダッシュボード
public/admin.html   レジ
src/index.js        API（Cloudflare Worker）
wrangler.toml       Cloudflare の設定
```

データは Cloudflare D1（SQLite）に保存されます。テーブルは初回アクセス時に自動で作成されます。

## セットアップ（初回のみ・15分くらい）

必要なもの: Cloudflare アカウント（無料）、Node.js 18 以上が入った PC

```bash
# 1. このリポジトリを取得して依存をインストール
git clone https://github.com/adatchan/mogiten.git
cd mogiten
npm install

# 2. Cloudflare にログイン（ブラウザが開きます）
npx wrangler login

# 3. データベースを作成
npx wrangler d1 create mogiten
#    → 表示された database_id を wrangler.toml の「ここに database_id を貼る」に貼り付けて保存

# 4. デプロイ
npx wrangler deploy
#    → https://mogiten.xxxx.workers.dev が表示されます（これがダッシュボードの URL）

# 5. レジのパスワードを設定（入力を求められるので好きなパスワードを入力）
npx wrangler secret put ADMIN_PASSWORD
```

あとは、
- ダッシュボードの URL を QR コードにして店頭に貼る
- 安達の端末で `/admin` を開いてパスワードを入れる（その端末に記憶されます）

で準備完了です。

### コードを修正したとき

```bash
npx wrangler deploy
```

URL は変わりません。

### 当日の前にテストデータを消す

```bash
npx wrangler d1 execute mogiten --remote --command "DELETE FROM sales"
```

## ローカルで試す

```bash
echo "ADMIN_PASSWORD=dango" > .dev.vars
npm run dev
# http://localhost:8787/ と http://localhost:8787/admin
```

## メモ

- 価格や容器代のルールを変えるときは、`src/index.js` と `public/admin.html` の `SETS` / `containerFee` を両方書き換えてください。
- 売上はお客さんから受け取った金額（団子代＋容器代）で計算しています。目標との比較もこの金額です。
- セキュリティは簡易です。パスワードは端末のブラウザに平文で保存されます。ダッシュボードと CSV は URL を知っている人なら誰でも見られます。
