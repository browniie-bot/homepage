# Copilot Instructions

- 全体概要: docs/blueprint_v2.md
- 環境変数/セットアップ状態管理: docs/secrets-and-env_v2.md
- DB設計書: docs/database-schema.md
- AWS最新情報: MCP（aws-knowledge-mcp-server / brave-search）

## 記述方針（必須）

- ソースコメントは「どう実装するか（How）」だけでなく「なぜそうするか（Why / 目的）」を先に明確に書く。
- CDKソースのコメントでは、構成理由・制約・運用上の意図（例: セキュリティ、循環依存回避、コスト）を明記する。
- gitコミットログは変更内容（How）だけでなく、背景と目的（Why）が第三者に伝わる件名/本文にする。

## AWS 情報の扱い

### 最新情報は aws-knowledge-mcp-server / brave-search で必ず検証する

**why:** AWS は CloudFront OAC・Lambda Function URL・Cognito 等、2023 年以降に仕様や推奨構成が頻繁に更新される領域が多い。LLM
単体の学習知識だけで断言すると、古い・誤った設定を生成して時間を浪費する（本プロジェクトでもOAC の DELETE body 等で実際に時間を失った）。

**ルール:**
- AWS サービスの仕様・制約・ベストプラクティス・API
引数を回答する前に、以下のいずれかで一次情報を確認する:
   - `aws-knowledge-mcp-server`（公式ドキュメント検索、優先）
   - `brave-search`（公式 docs にない実装 Tips、re:Post 等）
- 特に以下のトピックは必ず検証:
   - CloudFront OAC / Lambda Function URL / Lambda Web Adapter
   - Cognito（Hosted UI、MFA、OAuth2 PKCE）
   - VPC Endpoint / PrivateLink 関連

## コーディングルール（禁止事項）

### `"use server"` ディレクティブ禁止（Server Actions 禁止）

**why:** 本プロジェクトは CloudFront OAC + Lambda Function URL（AWS_IAM）構成。Server
Actions は Next.js が生成する内部 POST で動き、viewer が送る `x-amz-content-sha256`と実際の payload hash を一致させられないため、OAC の SigV4 署名検証で必ず 403になる。また攻撃面の最小化・レビュー容易性の観点でも Route Handlerに統一する。

**ルール:**
- `.ts/.tsx/.js/.jsx` のファイル先頭・関数先頭に `"use server"` / `'use server'`を書かない
- サーバー処理は `app/api/**/route.ts` に Route Handler として実装し、クライアントからは`fetchWithSigning()` 経由で呼び出す
- RSC（デフォルトの Server Component）や SSR は自由に使ってよい（GET なので OAC影響なし）

### DELETE リクエストに body を付けない

**why:** CloudFront は DELETE メソッドの body を origin に転送しない仕様。viewer が body 込みで SigV4 署名しても、Lambda 側に届く body は空になるため payloadhash が一致せず 403 になる。

**ルール:**
- DELETE はクエリ文字列（`URLSearchParams`）でパラメータを渡す

### DB 参照のあるページは `force-dynamic` を必ず付与

**why:** Next.js 16 は `cookies()`/`headers()` を使わない RSC をビルド時に SSG する。DynamoDB 参照ページを SSG させると「ビルド時の DB 状態（≒空）」の HTML が Lambda イメージに焼き付き、その後 DB を更新しても永久に古い HTML が返る（症状: `x-nextjs-prerender: 1` + 空コンテンツ。CDN invalidate しても解消しない）。

**ルール:**
- `getSiteSettings()` 等 DB を参照する Server Component には `export const dynamic = 'force-dynamic'` を入れる
- CDN 側 (`s-maxage`) で性能はカバーされるためコストは軽微

### CloudFront は IPv4 限定運用

**why:** WAF IPSet を IPv4 のみで管理する方針。CDN が IPv6 で受けると WAF の IP 制限を回避してしまうため。

**ルール:**
- CDK の `Distribution` で `enableIpv6: false`
- 入力された IPv6（`:` を含むアドレス）は IPSet に登録しない

### WAF v2 (CLOUDFRONT scope) は不要なら必ず destroy

**why:** WebACL は存在するだけで月額固定料金（約 $5）が発生。`wafMode='none'` でデプロイをスキップしても残置スタックは課金され続ける。

**ルール:**
- `wafMode='none'` 選択時は InfraStack 更新（`wafAclArn=undefined`）後に `cdk destroy HomepageWafStack` を実行する順序

## 2026/04/25 引き継ぎメモ

主要機能（記事追加/削除・ログイン・決済・コメント）が v2 で動作確認済み。独自ドメイン切替（`www.okamomedia.tokyo`）まで完了し、開発時の運用フローは [docs/operations_v2.md](../docs/operations_v2.md) に集約。

### 既知の注意点（再掲。v2 で実地検証済み）
- DELETE に body を付けない（CloudFront が origin に転送しない → OAC 署名不一致）
- `"use server"` 禁止（Server Actions の内部 POST は OAC 署名不一致で 403）
- Stripe Webhook は Proxy Lambda (`AuthType: NONE`) 経由のみ。Stripe 直 OAC は 403 確定
- CloudFront Cache Key に RSC ヘッダ (`rsc`/`next-router-prefetch`/`next-router-state-tree`/`next-url`/`accept`) を Include 必須
- payments テーブルの id 属性は `payment_id` (snake_case)。過去の `paymentId` 異常レコードは手動削除 → Stripe Resend で再挿入

## 2026/05/02 引き継ぎメモ（セキュリティテスト基盤導入）

**why（背景）:** デプロイ後にしか気づけないクラスの障害（OAC 署名不一致、RSC キャッシュキー漏れ、Cognito 認証ゲート消失、Stripe Webhook 署名検証バイパス）を Pull Request 段階で止めるため、Vitest による攻撃観点の単体テストと GitHub Actions による SAST/秘密情報/依存脆弱性ゲートを導入した。

### テスト構成
- フレームワーク: **Vitest** (node 環境、`@/*` alias、`vi.mock` で `auth`/`dynamodb`/`stripe` を stub)
- 設定: [vitest.config.ts](../vitest.config.ts) / [test/setup.ts](../test/setup.ts)
- 実行: `npm test` (CI), `npm run test:watch` (開発時)
- 現在 23 テスト全 green:
  - [test/api/admin-auth-gate.test.ts](../test/api/admin-auth-gate.test.ts) — Cognito 未認証 → 403、ID 欠落 → 400
  - [test/api/comments.test.ts](../test/api/comments.test.ts) — 401/Zod 検証 (1000 文字上限・空文字・JSON 不正)
  - [test/api/stripe-webhook.test.ts](../test/api/stripe-webhook.test.ts) — 署名ヘッダ無 400、署名不正 400、正常 200
  - [test/api/stripe-checkout.test.ts](../test/api/stripe-checkout.test.ts) — 未ログイン 401、body.userId 改ざん耐性（session JWT の uid が必ず採用される）、open redirect 防止 (returnUrl)
  - [test/api/auth-google-callback.test.ts](../test/api/auth-google-callback.test.ts) — PKCE state mismatch、Google error
  - [test/cdk/distribution.test.ts](../test/cdk/distribution.test.ts) — IPv6 無効、`/api/*` = `CachingDisabled`、RSC ヘッダが Cache Key に含まれる

### CI 構成
[.github/workflows/security.yml](workflows/security.yml) で push/PR 時に 5 ジョブ並列実行:
1. `unit-tests` (Vitest)
2. `lint` (ESLint)
3. `npm-audit` — homepage は `--omit=dev --audit-level=high`、setup は通常 `--audit-level=high`
4. `semgrep` (`p/owasp-top-ten` + `p/typescript`、SARIF アップロード)
5. `gitleaks` (秘密情報スキャン)

### 依存方針
- **homepage**: `--omit=dev` で production high+ = 0。dev/transitive moderate 28 件は許容（genkit / googleapis 経由で本番経路に攻撃面なし）
- **setup**: `postcss` を `overrides` で 8.5.10 に固定し vulnerabilities = 0
- **削除済み**: `genkit-cli`（ローカル AI Developer UI 用、未使用）と `src/ai/dev.ts`
- **保持**: `ts-node` / `source-map-support` は `cdk.json` の `npx ts-node ...` 起動に必要なので残す
- **`bundleDependencies`（同梱依存）は `overrides` で差し替えられない**。`npm ls` / `package-lock.json` の `"inBundle": true` が付いたエントリが該当する。Dependabot は同梱版もグラフに含めるため、上流が同梱版を更新するまでアラートは消えない
  - 2026/11 実例: `aws-cdk-lib` 同梱の `minimatch` 10.2.6（GHSA-g3hv-75wg-m249）。最新 `2.276.0` の tarball 内も 10.2.6 で、`overrides` の global / nested どちらも効かない（実測）。実行経路は `cdk synth` 時の `cdk.json` 除外パターンと Aspects の glob で、パターンはリポジトリ管理＝外部入力なし → Dependabot を `tolerable_risk` で dismiss し、CDK 更新時に `npm view aws-cdk-lib dependencies.minimatch` と同梱版を確認して 11.0.1 以上になっていれば undismiss する
  - 「一旦 dismiss した」ことを忘れないよう、判断理由は **アラートの dismissed_comment（280 文字上限）と git 履歴の両方**に残す

### GitHub Actions のバージョン指定は必ずコミット SHA で pin すること

**why:** `@v4` のようなフローティングタグは Semgrep の `p/owasp-top-ten` ルール
`github-actions-mutable-action-tag` に検出され、Code Scanning alert が大量に
発生する。またサプライチェーン攻撃（タグの差し替え）のリスクもある。

**ルール:**
- `actions/checkout` 等の外部 Action は必ずコミット SHA で指定する（例: `@11d5960a326750d5838078e36cf38b85af677262`）
- 最新 SHA の調べ方: GitHub の該当リポジトリの Releases ページでタグに対応するコミットを確認
- `npm audit` の例外は `.nsprc` ファイル（`better-npm-audit` 用）で管理。homepage と setup の両方に必要なら両方に置く

### 新しい Route Handler を追加するときの最低ライン
1. `src/app/api/**/route.ts` を作成（`"use server"` 禁止、DELETE は body 無し）
2. `test/api/<area>.test.ts` に最低「未認証/権限不足 → 401/403」を 1 件追加
3. `npm test` がローカルで通ることを確認してから commit

## 2026/05/04 引き継ぎメモ（DAST 初回指摘の対応）

**why（背景）:** 2026/05/03 OWASP ZAP 初回スキャン ([docs/20260503_dast-zap-initial-scan.md](../docs/20260503_dast-zap-initial-scan.md)) の Low 警告（セキュリティヘッダ未設定）と「`/api/stripe/session` が不正値で 500」問題を修正した。

### 変更点
- **CloudFront ResponseHeadersPolicy 新設** ([cdk/lib/infra-stack.ts](../cdk/lib/infra-stack.ts))
  - HSTS 1 年 / includeSubDomains, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, X-Frame-Options DENY, Cross-Origin-Resource-Policy same-site, Cross-Origin-Opener-Policy same-origin-allow-popups, Permissions-Policy（不要 API 全部塞ぐ + Stripe.js のみ payment 許可）を全 Behavior に適用
  - CSP は引き続き `next.config.ts` で生成（contentSecurityPolicy は ResponseHeadersPolicy 側で未指定にして二重定義を避ける）
- **`poweredByHeader: false`** ([next.config.ts](../next.config.ts)) — `X-Powered-By` 漏洩抑止
- **`/api/stripe/session` 入力検証** ([src/app/api/stripe/session/route.ts](../src/app/api/stripe/session/route.ts))
  - `cs_(live|test)_xxx` 形式の正規表現で事前バリデーション → 不正値で 400
  - `Stripe.errors.StripeInvalidRequestError` を catch → 400 に変換（500 にしない）
- **テスト追加** — [test/api/stripe-session.test.ts](../test/api/stripe-session.test.ts), [test/cdk/distribution.test.ts](../test/cdk/distribution.test.ts) に SecurityHeadersPolicy 回帰テスト。`npm test` 28 件 green

### 反映方法
- `npx cdk deploy HomepageDynamoDbStack` で ResponseHeadersPolicy が CloudFront に紐付く
  - スタック名は `HomepageDynamoDbStack`（旧 `HomepageInfraStack` という名称は存在しない。[cdk/bin/app.ts](../cdk/bin/app.ts) 参照）
- 反映後に再度 `scripts/dast/zap-full-scan.sh` を流し、HSTS / X-Content-Type-Options / Referrer-Policy / Permissions-Policy / CORP / X-Powered-By 関連の Low 警告が消えていることを確認する

### 残課題（将来）
- Cookie 関連 Low 警告（HttpOnly/Secure/SameSite が「無い」と検出された 4/4/6 件）— 自前 cookie は全て HttpOnly + SameSite=Lax + (NODE_ENV=prod で) Secure を付与済み。残りの検出分は Spider が辿った Google 側 cookie の可能性が高いので triage が必要
- `Unexpected Content-Type` 287 件 — Active Scan ノイズの triage

## 2026/05/04 引き継ぎメモ 第二弾（DAST 二回目スキャン triage）

**why（背景）:** ResponseHeadersPolicy + Lambda 修正反映後の zap-api-scan / zap-full-scan の再スキャン結果から、解消した警告と残存警告を切り分け、誤検知や設計上意図的な値については [scripts/dast/zap.conf](../scripts/dast/zap.conf) に IGNORE 化して恒久的にノイズを減らした。

### 解消確認できた警告（before → after で消滅）
- A Server Error 500 (2 → 0): stripe/session, stripe/checkout の入力検証強化
- Strict-Transport-Security Not Set (5 → 0)
- X-Content-Type-Options Header Missing (5 → 0)
- Server Leaks "X-Powered-By" (1 → 0): `poweredByHeader: false`
- Application Error Disclosure (1 → 0): stripe/checkout の error.message 非開示
- Cookie No HttpOnly Flag (4 → 0) / Cookie Without Secure Flag (4 → 0): google_oauth_* expiry cookie 修正

### 追加修正（Server ヘッダ漏洩）
- 画像配信パス `/media/*` で S3 origin の `Server: AmazonS3` がそのまま透過していた（CloudFront は via ヘッダで分かるが、S3 由来であることまで開示するのは情報価値マイナス）
- [cdk/lib/infra-stack.ts](../cdk/lib/infra-stack.ts) の `SecurityHeadersPolicy.customHeaders` に `{ header: 'Server', value: 'CloudFront', override: true }` を追加し、Lambda / S3 双方の Server ヘッダを CloudFront 起点で塗り潰す
- 回帰テストを [test/cdk/distribution.test.ts](../test/cdk/distribution.test.ts) に追加（`npm test` 29 件 green）

### IGNORE 化した警告（[scripts/dast/zap.conf](../scripts/dast/zap.conf)）
| pluginid | 警告 | 理由 |
|---|---|---|
| 40025 | Proxy Disclosure | CloudFront 中継は `via` / `x-amz-cf-id` ヘッダで公開済み。隠蔽不可 |
| 40038 | Bypassing 403 | `x-original-url` ヘッダは Next.js / Lambda が尊重しないため誤検知 |
| 90004 | Cross-Origin-{Embedder,Opener,Resource}-Policy Missing or Invalid | COOP=`same-origin-allow-popups` / CORP=`same-site` / COEP 未設定は意図的（Stripe ポップアップ・Next.js prefetch・3rd party iframe との両立） |
| 100001 | Unexpected Content-Type | 大半が外部ドメイン（accounts.google.com 等）由来のノイズ |
| 10024 | Sensitive Information in URL | Stripe `session_id` (cs_test_xxx) は publishable で機密ではない |
| 10110 | Dangerous JS Functions | accounts.google.com 上の eval() で当方制御外 |

### 反映フロー（ここから先）
1. `git push` 済みの変更を確認
2. `npx cdk deploy HomepageDynamoDbStack` で Server ヘッダ上書きを反映
3. `scripts/dast/zap-full-scan.sh` 再実行 → IGNORE 化により残警告が CSP系（unsafe-inline/unsafe-eval）と triage 済 Informational のみになっているか確認

## 2026/05/04 引き継ぎメモ 第三弾（DAST 三回目スキャン: ベースライン確定）

**why（背景）:** Server ヘッダ上書きを CloudFront 反映後に zap-api-scan / zap-full-scan を再実行し、すべての一次対応が反映されたことを確認した。残った警告は構成上必要な CSP の `unsafe-inline`/`unsafe-eval` と Informational のみで、これを「現状のベースライン」として固定する。今後のレグレッションはこのベースラインからの差分で判定する。

### Full Scan 03 で残った警告（すべて triage 済）
- **CSP: script-src unsafe-eval / unsafe-inline / style-src unsafe-inline**: Next.js の hydration、Stripe.js Elements、Google Tag Manager の動的 script 注入要件で removal 不可。Strict CSP (nonce/hash) への移行は将来課題
- **90004 Cross-Origin-* Missing or Invalid**: zap.conf で IGNORE 済みだが Full Scan の JSON には引き続き表示される仕様。CI gate には影響しない
- **10049/10050 Cache-Control Informational**: API レスポンスの `Cache-Control: no-store` 系 / 静的アセットの `max-age` どちらも正しい。Informational は無視

### 追加 IGNORE（[scripts/dast/zap.conf](../scripts/dast/zap.conf)）
- `10054 Cookie without SameSite Attribute` — `accounts.google.com` の `__Host-GAPS` cookie に対する警告で当方制御外（既存の 10055/90003 と同じ Google 由来 IGNORE 群に追加）

### Server ヘッダ上書きの効果（curl 実機確認）
```
$ curl -I https://test.okamomedia.tokyo/media/.../*.png | grep -i '^server:'
server: CloudFront        # 旧: AmazonS3
$ curl -I https://test.okamomedia.tokyo/         | grep -i '^server:'
server: CloudFront        # Lambda Function URL 由来も同様に上書き
```

### 今後の DAST 運用
- 新規 Route Handler を追加したら必ず [scripts/dast/openapi.yaml](../scripts/dast/openapi.yaml) を更新
- Full Scan の結果がベースライン（CSP 3 件 + 90004 9 件 + Informational のみ）と乖離したら回帰の疑い
- CSP の `unsafe-eval/unsafe-inline` 解消は別タスク（nonce ベース CSP への移行は Next.js 16 で `Middleware` ベースで実装可能）

## 2026/10/30 引き継ぎメモ（ECR イメージ失効による 502 障害）

**why（背景）:** 2026/10/24 22:00 〜 10/30 05:47 に本番サイトが全ページ 502 で停止した。原因はアプリの不具合ではなく、
アセット用 ECR リポジトリ（`cdk-hnb659fds-container-assets-210387976006-ap-northeast-1`）に手動で入れられていた
「最新5イメージのみ保持」ライフサイクルポリシーにより、`homepage-app` が参照するイメージが失効したこと。
同リポジトリは Newcleus / Kiln と共有しているため、他プロジェクトのデプロイが引き金になった。

詳細記録: [docs/20261030_outage_ecr-image-expiry.md](../docs/20261030_outage_ecr-image-expiry.md)

### ルール
- **共有アセット ECR リポジトリに `tagStatus: any|tagged` の件数・期間ベースのライフサイクルを設定しない**（使用中イメージが静かに消える）。bootstrap 既定（`untagged` / 365 日）を維持する
- 502 で `x-amzn-errortype: BadGatewayException` + `x-cache: Error from cloudfront` を見たら、まず `aws lambda get-function-configuration --function-name homepage-app --query 'StateReasonCode'` を確認する（`ImageDeleted` ならイメージ欠損）
- `ImageDeleted` は **`cdk diff` が差分ゼロになるため `cdk deploy` では復旧しない**。`docs/operations_v2.md` の「障害時の切り分け」にある「アプリコード更新」経路（docker build → ECR push → `update-function-code`）で戻す
- 監視は **`HomepageMonitoringStack`（ap-northeast-1）+ `HomepageMonitoringEdgeStack`（us-east-1）** に分離している。アプリ用スタックに相乗りさせると、監視の変更のたびに Lambda のイメージ再ビルドが走るため
- CloudFront の CloudWatch アラームは **us-east-1 固定**で、しかも **アクション先 SNS も us-east-1 でないと作成できない**（`Invalid region ... Only us-east-1 is supported.`）。このため SNS トピックを 2 つ持つ。通知先は **`.env` の `ALARM_EMAIL`（既定は空＝通知しない）** で、setup 画面 Step 1b からも保存・反映できる（`--context alarmEmail=` が最優先）。**確認メールのクリックまで通知は届かない**


