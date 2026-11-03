# 既存ユーザーのアップデート手順 v2

> **why:** 配布している WSL イメージは「ツール一式 + ビルド済みの setup 画面」を固めたもの。受け取り側は `http://localhost:3001` のセットアップ画面から操作する前提なので、アップデートも画面操作で完結させる必要がある。一方で「どの変更がどの経路（`/ops` か `setup1b` か）で反映されるか」を先に決めておかないと、
> 「1b を押したのに反映されない」「コード 1 行の修正のために 30〜60 分待たされる」という取り違えが起きる。

---

## 1. 前提 — 配布物の中身と、更新時に壊してはいけないもの

| パス | 中身 | 更新時の扱い |
|---|---|---|
| `~/homepage/` | アプリ本体ソース・`cdk/`・`Dockerfile` | 新しい版で**差し替える対象** |
| `~/homepage/.env` | AWS キー / Stripe / Cognito / 独自ドメイン（`CUSTOM_DOMAIN`・`CUSTOM_DOMAIN_CERT_ARN`）/ `ALARM_EMAIL` | **必ず引き継ぐ**（消すと AWS 認証も独自ドメインも失う） |
| `~/homepage/setup/setup-state.json` | セットアップの進捗（どの Step まで完了したか） | **必ず引き継ぐ**（消すと Step が未完了に巻き戻る） |
| `~/homepage/node_modules` | `npx cdk` 実行用の依存 | 差し替え後に再インストール |
| `~/homepage/setup/node_modules`・`setup/.next` | セットアップ画面本体（`next start` で配信） | 差し替え後に**再ビルド必須** |

理由: `setup` は `next start` で配信しているため、`.next` を作り直さないと**画面のコードが古いまま**になる。またセットアップ画面ヘッダの `v2.1.1` は `NEXT_PUBLIC_APP_VERSION`（ビルド時にリポジトリ直下の `package.json` から焼き込み）なので、再ビルドを忘れると「新しいファイルを入れたのにバージョン表記だけ古い」状態になる。

---

## 2. 変更種別ごとの反映経路（ここが本題）

| 変更内容 | 使う経路 | 所要時間 | 何が更新されるか |
|---|---|---|---|
| **アプリのコードのみ**（Next.js / Route Handler / 画面 / CSS） | セットアップ画面 → `/ops` →「アプリコード更新」 | 数分 | `homepage-app` のコンテナイメージのみ（`UpdateFunctionCode`） |
| **WAF の切替**（none / ip / captcha） | `/ops` →「WAF 構成変更」 | 3〜10 分 | `HomepageWafStack` と CloudFront の WebACL 関連付け |
| **監視・通知先だけ**（`ALARM_EMAIL`） | `setup1b` →「アラート通知先を保存」 | 数分 | `HomepageMonitoringStack` / `HomepageMonitoringEdgeStack` のみ |
| **構造変更**（DynamoDB の GSI 追加・新規 Lambda・IAM・CDK スタック修正） | `setup1b` →「デプロイ」 | 30〜60 分 | CloudFront / DynamoDB / IAM / Lambda / 監視スタック全部 |

### コード修正で `setup1b` を使わない理由

- `setup1b` は Docker ビルドを含むため 30〜60 分かかり、CloudFront・DynamoDB・IAM まで作り直し対象になる。コード 1 行の修正には過剰で、影響範囲も広い。
- `/ops` の「アプリコード更新」は `docker build` → ECR push → `UpdateFunctionCode` だけを行い、**CloudFront の設定（Aliases / ViewerCertificate / WAF）に一切触らない**。Lambda の更新は AWS 側で atomic なのでゼロダウンタイム。

### 構造変更で `setup1b` を使ってよい理由

- `setup1b` は `.env` の `CUSTOM_DOMAIN` / `CUSTOM_DOMAIN_CERT_ARN` を CDK context として渡すため、**独自ドメインを保持したまま**再デプロイされる（両方が `.env` に揃っていることが条件。`setup2b` Phase D-2 の成功時に永続化される）。
- 逆に言うと、**`.env` を引き継がずにファイルだけ差し替えた場合、ここが崩れる**（→ §5）。

---

## 3. ファイルを新しくする手順

### 3-1 WSL 内で差し替える（推奨）

配布イメージには `docs/` が入っているため、この手順書は `~/homepage/docs/update_v2.md` でも読める。

`setup/scripts/fetch-app.sh --update --build` が「ダウンロード → 不要ファイルの除去 → 旧ツリーの退避 → `.env` と `setup/setup-state.json` の引き継ぎ → 再ビルド」まで行う。

```bash
cd ~/homepage
bash setup/scripts/fetch-app.sh --update --build
```

配布済みイメージに `setup/scripts/fetch-app.sh` が無い場合（v2.1.1 以前のイメージ）は、GitHub から取得して実行する。スクリプトの位置から対象を決められないため `--dir` で明示する。

```bash
curl -fsSL -o /tmp/fetch-app.sh \
  https://raw.githubusercontent.com/okamoto53515606/homepage/main/setup/scripts/fetch-app.sh
bash /tmp/fetch-app.sh --dir "$HOME/homepage" --update --build
```

確認プロンプトを出さずに流す場合は `--yes` を付ける。特定のタグに固定したい場合は `--ref v2.1.1`。

スクリプトが内部でやっていること（手で同じことをしたい場合）:

```bash
# 0) 事前にバージョンを控える（更新後の確認用）
curl -s localhost:3001 | grep -o 'v2\.[0-9.]*' | head -1

# 1) 引き継ぐものを退避（.env と進捗）
cp ~/homepage/.env ~/env.backup
cp ~/homepage/setup/setup-state.json ~/setup-state.backup.json

# 2) 旧ツリーは残したまま、新しいツリーを展開
#    why: 丸ごと消さず別名で残すことで、切り戻しが「ディレクトリ名を戻すだけ」で済む
mv ~/homepage ~/homepage.old
mkdir -p ~/homepage
cd ~/homepage
curl -L https://github.com/okamoto53515606/homepage/archive/refs/heads/main.tar.gz \
  | tar -xz --strip-components=1

# why: 配布イメージサイズ削減のため、利用者が触る必要のないファイルを除く
#      （docs/ は配布物に含めており、この手順書も ~/homepage/docs/update_v2.md で読める）
rm -rf prompt_history test scripts

# 3) 退避したものを戻す
cp ~/env.backup .env
cp ~/setup-state.backup.json setup/setup-state.json

# 4) 依存を入れ直す（Node は 24 系であること）
source ~/.bashrc && nvm use 24 && node -v
npm install
cd ~/homepage/setup
npm install
npm run build

# 5) 動作確認できたら旧ツリーを削除
rm -rf ~/homepage.old ~/env.backup ~/setup-state.backup.json
```

> **注意:** 手順 4 を飛ばすと、`/ops` など新しい画面が表示されない（`.next` が古いまま）。`npm install` が `Cannot read properties of null (reading 'edgesOut')` で落ちる場合は `npx -y npm@11 install` を使う。
>
> **注意:** `rm -rf ~/homepage` を先に実行しないこと。`.env` と `setup/setup-state.json` が消え、AWS 認証・独自ドメイン・セットアップ進捗を失う。

### 3-2 新しい WSL イメージを再取り込みする（非推奨）

インストーラで新イメージを入れ直す方法。VHDX ごと入れ替わるため、**`.env` と `setup-state.json` は自動では引き継がれない**。事前に Windows 側へコピーし、取り込み後に戻す必要がある。手間とリスクが大きいので、通常は 3-1 を使う。

---

## 4. 更新の反映と確認

1. セットアップ画面（`http://localhost:3001`）を開き直し、**ヘッダのバージョン表記が新しい版になっている**ことを確認
   → 古いままなら手順 3-1 の 4（`setup` の `npm run build`）が未実行
2. 変更内容に応じて §2 の経路を実行
   - コード変更あり → `/ops` →「アプリコード更新」
   - 構造変更あり → `setup1b` →「デプロイ」
   - 監視だけ → `setup1b` →「アラート通知先を保存」
3. 公開サイトを開き直す。HTML がキャッシュされている場合は `/ops` →「CDN キャッシュ削除」
4. 管理画面サイドバー下部のバージョン表記でも `package.json` の値を確認できる（`/ops` でイメージを差し替えた場合、この表記が更新の可否判定に使える）

---

## 5. 前提が崩れたときの症状と対処

| 前提 | 崩れたときの症状 | 対処 |
|---|---|---|
| `.env` を引き継いでいる | `setup0` に戻る / AWS API が `Unauthorized` / 独自ドメインが消える | 退避ファイルを戻す。消えた場合は `setup0` から再入力（独自ドメインは `setup2b` Phase D-2 で再紐付け） |
| `setup/setup-state.json` を引き継いでいる | 完了済みの Step が未完了扱いになり、サイドバーがロック | 退避ファイルを戻す。無い場合は該当 Step を再実行 |
| `setup` を再ビルドした | 画面が旧版のまま・`/ops` が無い | `cd ~/homepage/setup && npm install && npm run build` → WSL 再起動 |
| 構造変更は `setup1b` で反映する | コードだけ差し替えて `ops` を押しても、新テーブルや新 Lambda が無く 500 になる | `setup1b` を実行（`ops` はコードしか変えない） |
| `/ops` で反映したイメージは次回 CDK デプロイで置き換わる | リリース後しばらくして CDK を使うと、イメージタグが `ops-<epoch>` から CDK ビルド品に戻る | 想定どおりの挙動。コードは同じなので実害なし |

---

## 6. リリースノートに書く型

利用者に「何を押せばよいか」だけを伝える。CDK コマンドは書かない（利用者は WSL のセットアップ画面から操作する前提のため）。

```markdown
### アップデート手順（既存ユーザー）

1. WSL 内でファイルを差し替える（`docs/update_v2.md` 3-1）
2. セットアップ画面を開き直し、ヘッダが vX.Y.Z になっていることを確認
3. セットアップ画面 →「運用メニュー」→「アプリコード更新」を実行
4. 今回は <構造変更の有無> のため、`setup1b` の「デプロイ」も実行する
   （構造変更が無いリリースではこの行を削除）
5. 公開サイトを開き直す。古い画面が残る場合は「CDN キャッシュ削除」
```

> **配布側の確認:** リリース用イメージを作るときは `setup` を**再ビルドしてから**エクスポートする。`docs/wsl.md` §6 の注意どおり、ビルド済み `.next` を使い回すと画面のバージョン表記だけが古いまま配布される。
