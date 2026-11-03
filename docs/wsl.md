# 配布用 WSL イメージのリリース手順

> **why:** 一般ユーザーが `homepage-v2` をローカルでセットアップできるよう、必要なツール（Node.js 24 / Docker / AWS CLI / プロジェクトコード＋ビルド済み setup 画面）を全部入りで構成した WSL イメージを GitHub Releases で配布する。受け取り側はインストーラを実行するだけで `http://localhost:3001` のセットアップ画面に進める。
>
> **作成・公開はインストーラーリポジトリ（`homepage-v2-installer`）の `tools/build-wsl-image.ps1` 1 コマンドで完結する**（生成 → 軽量化 → 圧縮 → 検証 → GitHub Release 公開）。実手順はインストーラー側のドキュメントに置き、このページは「何を押すか・何に気をつけるか」だけを持つ。理由は、同じ手順書を 2 か所に持つと必ず片方が古くなり、版ズレ・秘密情報混入・検証漏れの温床になるため。

## 関連ドキュメント（`homepage-v2-installer`）

| ドキュメント | 使いどころ |
|---|---|
| [wsl-image-automation.md](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/docs/wsl-image-automation.md) | 自動化の全体像（何が自動化されるか・パラメータ・リリース前の検証ゲート・実測 8〜9 分） |
| [wsl-image-release-runbook.md](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/docs/wsl-image-release-runbook.md) | Step 0〜6 の実行手順・チェックリスト・失敗したときの後始末 |
| [tools/build-wsl-image.ps1](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/tools/build-wsl-image.ps1) | 実行スクリプト本体（`provision.sh` / `cleanup.sh` / `verify.sh` を呼び出す） |
| [installer-setup.md](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/docs/installer-setup.md) | 利用者向け: セットアップ画面の起動（スクリーンショット付き） |
| [installer-update.md](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/docs/installer-update.md) | 利用者向け: アプリの更新（スクリーンショット付き） |

## 実行の流れ

1. **版を上げて push** — リポジトリ直下の `package.json` の `version` を更新して `main` に push する
2. **リリースノートを置く** — `D:\wsl_backup\homepage-release-notes-v<version>.md`（`v` は付けない。ファイル名の版がそのままタグになる）。中身がそのまま Release 本文になるので、[update_v2.md](./update_v2.md) §6 の「押すボタン」案内を書く
3. **スクリプトを実行** — `homepage-v2-installer` の `.\tools\build-wsl-image.ps1` を実行する
   - 初回は `-SkipRelease` で生成＋検証だけ行い、成果物（約 0.95 GB / sha256 64 桁）を確認する
   - 問題なければ `-SkipBuild` で公開する（`gh release create --latest --target <ビルドしたコミット>` が実行される）
   - 引数なしで実行すると、検証込みで公開まで一気に進む

## 前提

| 項目 | 要件 | 理由 |
|---|---|---|
| OS | Windows 11 | `wsl --import` と systemd を使うため |
| WSL | 2.x（`wsl --version` が通る） | 同上。カーネルはイメージに含まれないため、ホスト側は `wsl --update` で最新化する |
| `gh` CLI | インストール済み ＋ `gh auth login` 済み | Release 作成に使う（`-SkipRelease` なら不要） |
| 空き容量 | `D:\` に 20 GB 以上 | 中間 tar が数 GB になる |
| ネットワーク | cdimages.ubuntu.com / GitHub / Docker / AWS CLI / nvm | ベース rootfs の取得とプロビジョニングで使う |

## 注意（自動化されていない部分）

| 項目 | 内容 |
|---|---|
| 画面のバージョン | `NEXT_PUBLIC_APP_VERSION` は `next build` 時に root `package.json` から焼き込む。push 前にビルドすると画面だけ古い版になるため、スクリプトは**ビルド開始前**に `package.json` と raw の version を突き合わせて止まる（`-SkipVersionCheck` で回避しない） |
| 版番号の使い捨て | Git タグは作り直せない。公開後に中身を作り直すときは版番号を上げる（`v2.1.2-1` のような派生は作らない） |
| 秘密情報の混入 | `~/.aws` / `~/.ssh` / `~/.npmrc` / `~/.bash_history` などは削除され、`~/homepage/.env` に `AKIA...` 等が無いことを検査する（ヒットしたらビルド失敗） |
| 個人情報の持ち込み禁止 | クリーンな Ubuntu rootfs から作り、リポジトリ（public）と `env_template.txt` 以外のファイルを入れない。`.env` はテンプレートのコピーで、AWS キー等は受け取り側が setup 画面から入力する |
| インストーラ本体 | 配布イメージとは別成果物。イメージを更新してもインストーラ（`.exe` / `.zip`）の再ビルドは不要（`releases/latest` を追従するため） |

## 利用者側（受け取り側）の操作

| 目的 | 手順 |
|---|---|
| 新規に始める | インストーラ（`homepage-v2-installer-setup.zip`）を実行 → タスクトレイ「起動 (npm run dev)」→ `http://localhost:3001/setup0`。スクショ付き: [installer-setup.md](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/docs/installer-setup.md) |
| アプリを最新にする | タスクトレイ「アプリを更新...」→ 完了後にセットアップ画面 →「運用メニュー」→「アプリコード更新」。スクショ付き: [installer-update.md](https://github.com/okamoto53515606/homepage-v2-installer/blob/main/docs/installer-update.md) |

- 更新時、`.env`（AWS キー・独自ドメイン）と `setup/setup-state.json` は自動で引き継がれ、旧ツリーは `~/homepage.old-<timestamp>` に退避される
- 手動で差し替える場合の手順と、変更種別ごとの反映経路（`/ops` か `setup1b` か）は [update_v2.md](./update_v2.md) を参照
