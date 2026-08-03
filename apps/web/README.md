# @ebb/web

SvelteKit アプリ。このリポジトリの pnpm workspaces の一部としてビルド・管理する（`apps/web` 単体で `npm`/`yarn` は使わない。`typescript` は `catalog:` 経由で pnpm の catalog protocol にのみ解決される）。

## Creating a project

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.17.0 create --template minimal --types ts --no-install apps/web
```

## Developing

ワークスペースルートで依存関係をインストール後、開発サーバーを起動する:

```sh
pnpm install

pnpm --filter @ebb/web dev

# or start the server and open the app in a new browser tab
pnpm --filter @ebb/web dev -- --open
```

## Building

To create a production version of your app:

```sh
pnpm --filter @ebb/web build
```

You can preview the production build with `pnpm --filter @ebb/web preview`.

デプロイ先は [`@sveltejs/adapter-cloudflare`](https://svelte.dev/docs/kit/adapter-cloudflare) を組み込み済み（Cloudflare Workers Static Assets）。
