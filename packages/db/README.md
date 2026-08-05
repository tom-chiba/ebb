# @ebb/db

D1 用の Drizzle スキーマとマイグレーション。

## Better Auth スキーマの生成

`user` / `session` / `account` / `verification` テーブル（`src/auth-schema.ts`）は
手書きせず、Better Auth の設定変更（プラグイン追加など）があったら以下で再生成する。

```
pnpm --filter @ebb/db run generate:auth-schema
```

D1 の内部テーブル `_cf_METADATA` を Kysely の introspection が読もうとして失敗する既知の罠
（`better-auth generate` を実際の D1 に接続した状態で実行すると起きる）を避けるため、
`auth-cli-config.ts`（CLI 専用、アプリからは import しない）はダミーの D1 インスタンスに
`drizzleAdapter` を使う。生成後は `pnpm db:generate` を実行してマイグレーション SQL に反映する。
詳細な経緯は `docs/design-decisions.md` の `## Better Auth + Google OAuth (#10)` を参照。

## マイグレーションの生成

`src/schema.ts` を変更したら、ルートで以下を実行する。

```
pnpm db:generate
```

`migrations/` 配下に SQL ファイルが生成される（`drizzle-kit generate` は D1 に接続しないオフライン処理）。

## マイグレーションの適用

ローカルの D1（`.wrangler/state` 配下、`apps/web` の実行に使われる）に適用する場合:

```
pnpm db:migrate:local
```

本番の D1 に適用する場合（元に戻せないので注意）:

```
pnpm db:migrate:remote
```

いずれも実体は `apps/web` の `wrangler.jsonc` に設定された `d1_databases` の `migrations_dir` を
通じて、このパッケージの `migrations/` を参照する（drizzle-kit の出力は flat 構成なので
`migrations_pattern` は既定値のままで良い）。
