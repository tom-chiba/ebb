# Ebb

エビングハウスの忘却曲線に沿って、記録したメモをリマインドする Web アプリ。

メモを書いたら、1時間後・1日後・3日後…と間隔を空けて Web Push で通知が届きます。思い出す作業を繰り返すことで、記憶を定着させることを目的としています。

## 特徴

- **メモを書くだけ** — タイトルと本文（Markdown）を書けば、復習スケジュールは自動で組まれます
- **間隔はカスタマイズ可能** — 短期集中から長期定着まで、プリセットから選ぶことも自分で組むこともできます
- **Web Push で通知** — アプリを開いていなくても、復習のタイミングで通知が届きます

## 技術スタック

| 領域 | 採用 |
|---|---|
| フロントエンド / バックエンド | SvelteKit（server side をバックエンドとして使用） |
| ホスティング | Cloudflare Workers（`adapter-cloudflare` + Static Assets） |
| データベース | Cloudflare D1 + Drizzle ORM |
| 定期実行 | Cloudflare Cron Triggers（専用 Worker） |
| 認証 | Better Auth（Google OAuth） |
| 通知 | Web Push（VAPID / PWA） |
| スタイル | 素の CSS（Svelte scoped style） |
| テスト | Vitest / `@cloudflare/vitest-pool-workers` / Playwright |
| CI/CD | GitHub Actions |

主要な設計判断とその理由は [docs/design-decisions.md](docs/design-decisions.md) に記録しています。

## リポジトリ構成

```
apps/
  web/        SvelteKit アプリ（UI + API）
  scheduler/  Cron Trigger で動く通知送信 Worker
packages/
  db/         Drizzle スキーマとマイグレーション
  core/       復習間隔の計算ロジック
  push/       Web Push 送信処理
```

## 開発

準備中です。セットアップ手順は開発基盤の整備（M0）完了後に記載します。

## ライセンス

未定
