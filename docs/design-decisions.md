# Ebb 設計決定メモ（Issue 化用）

## プロダクト
- 名前: Ebb
- 概要: メモを記録し、エビングハウスの忘却曲線に沿ってリマインドするアプリ
- 想定ユーザー: 自分を含む一般公開
- コア機能: メモ記録 + 間隔反復リマインド

## 仕様
- 通知手段: **Web Push (PWA) のみ**
  - iOS Safari はホーム画面追加が必須 → オンボーディングで案内
- 復習間隔: 最小単位 **1時間**、プリセット + ユーザーによるカスタム設定
  - 例: 短期集中 [1h,6h,1d,3d] / 標準 [1h,1d,3d,7d,14d,30d] / 長期 [1d,1w,1m,3m]
- 深夜通知: **quiet hours なし。scheduled_at どおりに送る**
  - → タイムゾーン対応は表示用のみ。MVP スコープから除外
- メモ形式: **タイトル + 本文 (Markdown)**
- タグ / 全文検索 / フォルダ: **MVP 対象外**（後続 Issue）

## 技術スタック（確定）
- FE/BE: **SvelteKit**（server side をそのまま BE として使う。Hono 別 Worker は不採用）
- デプロイ: **Cloudflare 統一**（adapter-cloudflare + Workers Static Assets）
- DB: **Cloudflare D1** + **Drizzle ORM / drizzle-kit**
- 定期実行: **Cloudflare Cron Triggers**（scheduled ハンドラを持つ別 Worker）
- 認証: **Better Auth**、ログイン手段は **Google OAuth のみ**
  → メール送信基盤（Resend 等）は MVP スコープ外
- UI: **素の CSS（Svelte の scoped style）**。Tailwind / UI ライブラリなし
- テスト: **単体（Vitest）+ 統合（vitest-pool-workers）+ E2E（Playwright）**
- リポジトリ: **pnpm workspaces モノレポ**
  - apps/web, apps/scheduler, packages/db, packages/core, packages/push
- Lint/Format: **ESLint + Prettier + svelte-check**（SvelteKit 標準）
- CI/CD: **GitHub Actions に一本化**（PR で検査、main で wrangler deploy）
- 環境: **local + production の 2 つ**
- 通知送信: **MVP は直送**（Queues は後続 Issue で導入）
- ドメイン: 独自ドメイン保有済み

## 却下した選択肢と理由
- **Vercel**: Hobby プランの cron が 1日1回のみ。`0 * * * *` はデプロイ自体が失敗する
  → 最小 1h の要件を満たせない
- **Cloudflare Workflows**: 
  - Free は 3,000 steps/日、2026-08-10 から steps/storage が課金対象
  - ユーザーが間隔をカスタム変更する仕様と相性が悪い（sleep 中インスタンスは terminate → 再作成が必要）
  - 復習予定の一覧表示のため結局 D1 にも persist が必要 → 二重管理
  → Cron Triggers + D1 ポーリングを採用
- **Lucia**: 2025年3月に deprecated

## 実装上の要注意点（Issue に反映）
1. **Workers で `web-push` パッケージは動かない**（Node crypto 依存）
   → Web Crypto ベースの実装（`@block65/webcrypto-web-push` 等）が必要
2. **Free プランは CPU 10ms/リクエスト**
   → cron で全件その場送信は不可。Queues でファンアウトし 1メッセージ = 1通知にする
   → Queues 無料枠は 1万オペ/日（保持 24h）= 実質 1日1万通知が上限
3. **Better Auth + D1 の既知の罠**: D1 の内部テーブル `_cf_METADATA` を Kysely の
   introspection が読もうとして `better-auth generate` が失敗する
4. cron は「通知時刻」ではなく「巡回間隔」。通知時刻は `reviews.scheduled_at` が持つ
   → cron 間隔 = 通知の最大遅延。毎分実行でも無料枠に余裕（1440回/日 ≪ 10万/日）
5. SvelteKit の Worker は `fetch()` のみ公開 → Cron 用 Worker を分ける必要がある
6. Workers で `fs` は使用不可 → `$app/server` の `read()` を使う

## 実装上の要注意点（追加）
7. **Queues 不採用のため cron の送信件数に上限が必須**
   → `SELECT ... LIMIT 20` 程度に絞り、残りは次周期へ。毎分実行なら 1時間 1200 件さばける
8. **E2E で Google OAuth を通すのは不安定**
   → Playwright の `storageState` にセッションを注入する方式にする
9. 購読が失効したら（Push サービスが 410 Gone を返す）DB から購読を削除する処理が必要

## 開発の進め方
- リポジトリ: public
- Issue の粒度: 1 Issue = 1 PR（半日〜1日程度）
- **Web Push の技術検証（M1）を認証やメモ機能より先に置く**
  → このプロジェクトで最も不確実性が高い箇所であり、
    ここで想定外の壁に当たると設計全体に影響するため。
    認証・CRUD は手順が確立した定型作業なので後に回してもリスクが増えない
