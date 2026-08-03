# @ebb/db

D1 用の Drizzle スキーマとマイグレーション。

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
