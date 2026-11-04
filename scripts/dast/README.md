# DAST (OWASP ZAP)

`why:` PR 段階で潰しきれない実行時の脆弱性 (反射型 XSS / SSRF / Open Redirect /
Cognito 認証ゲート抜け / Stripe Webhook 署名検証バイパス 等) を AWS test 環境で
能動スキャンして検出する。

## 推奨実行順

1. **C: API Scan** ([zap-api-scan.sh](zap-api-scan.sh) + [openapi.yaml](openapi.yaml))
   - `src/app/api/**/route.ts` から手起こしした OpenAPI を ZAP に渡し、各エンドポイント
     を網羅的に Active Scan
   - 所要 10〜30 分
2. **B: Full Scan** ([zap-full-scan.sh](zap-full-scan.sh))
   - Spider クロール + Active Scan で UI / RSC / 静的アセットも含め全体スキャン
   - 所要 30〜120 分
   - Baseline (受動スキャン項目) は Full Scan に内包されるため A は省略

## 前提

- Docker が起動していること (`zaproxy/zap-stable` イメージを pull する)
- 対象は AWS test 環境 (`https://test.okamomedia.tokyo/`)
- AWS [Permitted Services](https://aws.amazon.com/security/penetration-testing/) に CloudFront / Lambda が含まれるため事前申請不要

## 認証付きでスキャンする手順

`/admin/**` などログイン必須のエンドポイントを攻撃対象にしたい場合は session JWT cookie を渡す:

1. ブラウザで対象サイトの `/admin` にログイン (Cognito Hosted UI 経由)
2. DevTools → Application → Cookies → `session` の値をコピー
3. シェルに環境変数として export:

   ```bash
   export SESSION_JWT="eyJhbGciOi..."
   ```

4. スクリプト実行 (Replacer で全リクエストの `Cookie` ヘッダに強制注入される):

   ```bash
   ./scripts/dast/zap-api-scan.sh
   ./scripts/dast/zap-full-scan.sh
   ```

`SESSION_JWT` 未指定で実行した場合は未ログイン状態のスキャンとなり、
管理系エンドポイントは 401/403 が返るのみで脆弱性検出はできない。

## 既知の制約: 本文付き POST/PUT はアプリまで届かない (OAC の署名検証)

**why:** CloudFront OAC + Lambda Function URL (`AWS_IAM`) 構成では、リクエストに
`x-amz-content-sha256` ヘッダが必要で、その値が**実 body の SHA-256 と一致しないと
CloudFront がアプリ到達前に 403 を返す**。

```
{"message":"The request signature we calculated does not match the signature you provided. ..."}
```

ZAP はこのヘッダを付けない (付けられない) ため、**本文付きの POST / PUT はアプリに
到達せず、OAC が返した 403 に対して Active Scan を実行している**。つまり
XSS / インジェクション系のうち「POST body を攻撃対象にするテスト」は実質未実施で、
この領域の保証は「認可が正しく 401/403 を返す」ところまでになる。

### 実測 (2026/11/04)

| 送信内容 | 結果 |
| --- | --- |
| `POST /api/admin/gemini-config` body 付き・ヘッダ無し | OAC が 403 (署名不一致) |
| 同上 + `x-amz-content-sha256: UNSIGNED-PAYLOAD` | OAC が 403 (不一致のまま) |
| 同上 + body の正しい SHA-256 | **アプリまで到達**し、認可で 403 (`管理者権限がありません`) |
| body 無し (`GET` / `DELETE` クエリ) | アプリまで到達 |

なお画面からの mutation は `src/lib/fetch.ts` の `fetchWithSigning()` が body の
SHA-256 を付けるため到達する (画像アップロードは OAC の都合で FormData ではなく
JSON + Base64: `src/lib/image-upload.ts`)。

### 塞ぎ方 (未実装)

1. **ZAP の httpsender スクリプト** (Graal.js) でリクエスト body の SHA-256 を計算し、
   `x-amz-content-sha256` に設定してから送出する
2. **ローカル署名プロキシ**を ZAP とオリジンの間に置き、`TARGET_URL` をプロキシに
   向ける (プロキシ側でハッシュ付与 + 転送)

実装する際の注意:

- ZAP の Replacer ではハッシュを**計算できない**ため、上記いずれかが必要
- ペイロードを書き換える Active Scan では、**書き換え後の body でハッシュを計算する**
  順序にしないと結局 403 になる
- この制約は「認可の検証」には影響しない (未認証時の 401/403 は GET/DELETE でも確認
  できる)。判断履歴は [docs/20260503_dast-zap-initial-scan.md](../../docs/20260503_dast-zap-initial-scan.md)
  の「未認証アクセス検証」を参照

## レポート出力先

`zap-reports/` (リポジトリルート、`.gitignore` 済み)

- `api-scan-report.html` / `api-scan-report.json`
- `full-scan-report.html` / `full-scan-report.json`

ブラウザで HTML を開き、High / Medium 警告を確認 → 修正 → 再スキャンの流れ。

## False Positive の triage

ZAP は仕組み上、SQL DB を使っていなくても Boolean-based SQLi 警告を誤検出するなど
False Positive が混じる。根拠を確認したものは [zap.conf](zap.conf) に IGNORE 行
として記録する (理由は同ファイルのコメントに why-first で残す)。

判断履歴・スキャン結果サマリは git commit log に残す方針 (zap-reports/ 自体は
git 管理しない)。レポートを公開したい場合は HTML を手動でサニタイズしてから
別途共有する。

## OpenAPI メンテナンス

`src/app/api/**/route.ts` を追加・変更したら [openapi.yaml](openapi.yaml) も追記する。
未記載のエンドポイントは ZAP が発見できず DAST から漏れるため。
ZAP は新しい URL に出会うと SCAN-NEW 警告を出すので、それを目印にしてもよい。

## スキャン後のクリーンアップ

Active Scan は DynamoDB に大量のテストレコードを残す可能性がある:

- `articles` / `comments` / `users` テーブルにゴミデータが入っていないか確認
- 必要なら AWS コンソール / setup の運用画面から削除

## CI 連携 (将来)

DAST は対象環境を直接叩くため毎 push CI 化は過剰。組み込む場合は
`.github/workflows/dast.yml` を作成し `workflow_dispatch` 手動トリガに限定する。
