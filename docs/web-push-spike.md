# Web Push 検証 (#8)

## 受け入れ条件の状況

開発用サンドボックス環境は outbound network を許可リスト方式で制限しており
（`allowedHosts: []`）、Worker からの実際の Push 送信（FCM 等への `fetch`）が
届かない。そのため実配送の確認は、ユーザー自身の環境で
`pnpm --dir apps/web dev` を起動し、`/debug/push` を Chrome で操作する形で行った。

- [x] デスクトップのブラウザに実際に通知が届いた
  - Chrome で確認済み。ただし初回は `sendStatus: 201`（push サービスは受理）でも
    画面に通知が表示されず、原因は **macOS 側の通知設定**（Chrome への通知許可 /
    集中モード）だった。設定を直すと通知が表示された。
    → `201` は push サービスが受理したことしか意味せず、実際の復号・表示確認には
    ならない。OS の通知設定起因の「届かない」は暗号方式の問題と区別すること
    （このセッションで実際に踏んだ切り分けポイント）。
  - Firefox は未確認（ユーザー判断でスコープ外。必要になれば #9 で確認）。
- [x] 採用するライブラリ（または実装方針）が決まった
  - `@block65/webcrypto-web-push` を採用する。legacy な `aesgcm` を実装している
    にもかかわらず、2026 時点の Chrome / FCM で実際に受理・復号・表示された。
    自前で RFC 8291 (`aes128gcm`) を実装する必要はない。
- [ ] CPU 時間がどの程度かかるか把握できた
  - **未着手**。ローカル dev（Vite/Miniflare）では Cloudflare の CPU 時間課金・
    Workers Logs は再現されない。本番デプロイ後に Workers Logs の invocation ログ
    で確認する必要がある（このセッションでは本番へのデプロイを行っていない）。
    #20 で計測するか、この Issue のためだけに手動デプロイするかは要判断。

この Spike で答えを出したかったことのうち、**ペイロードサイズの上限は未検証**。
今回送ったペイロードは `{title: 'Ebb', body: '...'}` 程度の小さい JSON のみで、
push サービス側の上限（Web Push の実用上の上限は 4KB 程度とされることが多い）を
実際に超えるケースは試していない。#20 でペイロードの型（メモ ID / タイトル / 遷移先
URL）を設計する際に、実測してから上限値を決めること。

## 用意したもの

- `scripts/generate-vapid-keys.ts`: VAPID 鍵ペア（ECDSA P-256）を Web Crypto で生成する。
  `node scripts/generate-vapid-keys.ts` で実行できる。
- `apps/web/src/service-worker.ts`: `push` イベントで `showNotification` する最小実装。
  manifest / `notificationclick` / iOS 対応は #9 のスコープ。
- `apps/web/src/routes/debug/push/`: 購読作成・endpoint 確認・テスト送信ができる
  デバッグページ（既存の `debug/d1` と同じパターン）。
- VAPID 鍵の保管方針: 公開鍵 / subject は `wrangler.jsonc` の `vars`（秘密ではない）、
  秘密鍵はローカルは `.dev.vars`、本番は `wrangler secret put VAPID_PRIVATE_KEY`
  （**ユーザーが実行する必要がある**。このセッションでは未実行）。

## 送信ライブラリの決定

採用: `@block65/webcrypto-web-push`（1.0.2, 2024-12 公開。Node/Cloudflare
Workers/Bun/Deno 対応、Web Crypto ベース）。`apps/web` に追加済み。

ソースを直接確認したところ、`content-encoding: aesgcm` を実装している
（`packages/web-push/lib/encrypt.ts` の `createInfo(..., 'aesgcm')`、
`payload.ts` の `content-encoding: aesgcm` ヘッダ、`vapid.ts` の
`Authorization: WebPush <jwt>` + `Crypto-Key: p256ecdsa=` という組み合わせは
RFC 8291 以前の legacy scheme の特徴）。現行の推奨は RFC 8291 の `aes128gcm` で、
このライブラリは legacy scheme のままである。

**実測結果**: それでも Chrome / FCM は 2026 時点でこの legacy `aesgcm` を
受理し、実際に復号・表示できた（`sendStatus: 201` → 通知表示まで確認済み）。
したがって #20 で自前の RFC 8291/8292 実装に切り替える必要はない。
Firefox / autopush での受理可否は未確認のため、Firefox 対応が必要になった
時点（#9 等）で同様に実測すること。

## 実装上判明したこと

- **`Uint8Array<ArrayBuffer>` vs `Uint8Array<ArrayBufferLike>`**
  （docs/design-decisions.md で予告されていた罠）に実際に遭遇した。
  `buildPushPayload` が返す `body` や `pushManager.subscribe` の
  `applicationServerKey` は `Uint8Array<ArrayBufferLike>` になるが、
  DOM の `BodyInit` / `BufferSource` は `Uint8Array<ArrayBuffer>` を要求するため
  `apps/web` の型検査だけで `TS2322` になる。`new Uint8Array(length)` で
  明示的に新しい `ArrayBuffer` を確保して詰め替えることで解決した
  （`+page.server.ts` の `requestBody`、`+page.svelte` の
  `urlBase64ToUint8Array`）。
- **`navigator.serviceWorker.register('/service-worker.js', { type: 'module' })`
  が dev では必須**。Vite dev は `/service-worker.js` を
  `import '/@fs/.../service-worker.ts'` という ESM シムとして配信するため、
  `type: 'module'` を指定しないと `SyntaxError` でインストールに失敗する
  （`ServiceWorker script evaluation failed`）。
- 一方 **production ビルド（`pnpm --dir apps/web build`）の
  `service-worker.js` は import/export を含まない単一スクリプト**
  （`.svelte-kit/output/client/service-worker.js` で確認）。
  `type: 'module'` を指定しても import/export のない module は問題なく
  評価されるため、dev/prod で同じ呼び出し（`type: 'module'` を常に付ける）
  で両対応できる。
- `src/service-worker.ts` は SvelteKit 生成 tsconfig の `exclude` に入っており、
  現時点で `pnpm check` の対象外（既知。design-decisions.md L191-215 参照）。
  専用 tsconfig の追加は #19 / #20 に申し送り。

## 次の Issue への申し送り

- #9: この最小 service worker を土台に manifest・`notificationclick`・iOS 実機確認を追加する。
  Firefox / autopush での `aesgcm` 受理可否もここで確認すること。
- #20: `@block65/webcrypto-web-push` の採用が決定済みなので、それを
  `sendPush(subscription, payload)` として `packages/push` に実装する
  （`packages/push/src/index.ts` のスタブはそのまま残している）。
  本番デプロイ後、CPU 時間を Workers Logs の invocation ログで確認すること
  （このセッションでは本番未デプロイのため未計測）。
