# ドキュメント索引

> **why:** 配布している WSL イメージには `docs/` がそのまま入る（`~/homepage/docs/`）。利用者・開発者・メンテナで読む資料が違うため、入口をここに一本化する。ルートの [README](../README.md) は概要と導線だけを持ち、詳細はこの索引から辿る。

## 利用者向け（セットアップ・更新）

| ドキュメント | 内容 |
|---|---|
| [setup1.md](setup1.md) | Part 1 — AWS アカウント準備 → CloudFront ドメインでサイト公開、Google ログインと Gemini の有効化 |
| [setup2.md](setup2.md) | Part 2 — Stripe サンドボックスで決済テスト、独自ドメインの紐付け |
| [setup3.md](setup3.md) | Part 3 — Stripe の本番化（実カードでの課金） |
| [update_v2.md](update_v2.md) | 既存ユーザーのアップデート。変更種別ごとの反映経路（`/ops` か `setup1b` か）と手動での差し替え |

インストーラ（GUI）の画面付き手順は別リポジトリにあります。

- 新規: [installer-setup.md](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/docs/installer-setup.md)
- 更新: [installer-update.md](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/docs/installer-update.md)
- アンインストール・トラブルシューティング: [homepage-v2-installer](https://github.com/okamoto53515606/homepage-v2-installer)

## 開発者向け

| ドキュメント | 内容 |
|---|---|
| [blueprint_v2.md](blueprint_v2.md) | 全体設計（構成・技術選定・セキュリティ方針） |
| [database-schema.md](database-schema.md) | DynamoDB のテーブル・キー・GSI 設計 |
| [secrets-and-env_v2.md](secrets-and-env_v2.md) | 環境変数・Secrets Manager・setup 画面との対応 |
| [operations_v2.md](operations_v2.md) | 日常の変更フロー、障害時の切り分け（502 など）、監視・アラート |
| [20260420_app-modifications_v2.md](20260420_app-modifications_v2.md) | v2 アプリの修正ポイント一覧（実装の意図と制約） |
| [../.github/copilot-instructions.md](../.github/copilot-instructions.md) | 実装ルールと禁止事項（`"use server"` 禁止・DELETE に body を付けない等）と、その理由 |

## メンテナ向け（配布物）

| ドキュメント | 内容 |
|---|---|
| [wsl.md](wsl.md) | 配布用 WSL イメージのリリース手順（概要・注意・リンク集） |
| [wsl-image-automation.md](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/docs/wsl-image-automation.md) | 自動化の全体像・パラメータ・検証ゲート |
| [wsl-image-release-runbook.md](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/docs/wsl-image-release-runbook.md) | Step 0〜6 の実行手順・チェックリスト・失敗時の後始末 |

## 記録・アーカイブ

| ドキュメント | 内容 |
|---|---|
| [20261030_outage_ecr-image-expiry.md](20261030_outage_ecr-image-expiry.md) | 2026/10/24〜30 の 502 障害（ECR イメージ失効）の記録と再発防止 |
| [20260503_dast-zap-initial-scan.md](20260503_dast-zap-initial-scan.md) | OWASP ZAP による DAST 初回スキャン結果と triage |
| [genkit-vs-direct-gemini.md](genkit-vs-direct-gemini.md) | Genkit と `@google/genai` 直接利用の比較（技術選定の記録） |
| [blueprint.md](blueprint.md) | v1 の設計（過去の記録。現行は [blueprint_v2.md](blueprint_v2.md)） |

## スクリーンショット

`docs/screenshot/v2-setup/` にセットアップ画面・運用メニューの画像があります（`setup0` / `setup1a` / `setup1b` / `setup1c` / `setup2a` / `setup2b` / `setup3` / `ops` など）。新しい画面を追加したときは、該当する手順書から相対パスで参照してください。

## 表記ルール

- 設計・運用手順は **現行の内容だけ** を書く（「当初は〜だったが変更した」のような差分の記述はしない。経緯は「記録・アーカイブ」に置く）
- 同じ手順を 2 か所に書かない。詳細は 1 か所に置き、他はリンクする（片方が必ず古くなるため）
