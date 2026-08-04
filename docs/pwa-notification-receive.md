# PWA 受信・通知確認 (#9)

## 実装したもの

- Web App Manifest（`apps/web/static/manifest.webmanifest`）
  - `name` / `short_name` / `start_url` / `display: standalone` / `icons`（192, 512）
- `apps/web/src/service-worker.ts`
  - `notificationclick`: 既存のクライアントがあればフォーカス、なければトップページを開く
  - `fetch` ハンドラは追加していない（後述の A/B 検証の結果、不要と判断した）
- `apps/web/src/routes/+layout.svelte`
  - `<link rel="manifest">` / `<link rel="apple-touch-icon">` / `<meta name="theme-color">`
  - **Service Worker の登録処理はここには書いていない**。SvelteKit は `kit.serviceWorker.register`
    が既定 `true` かつ `src/service-worker.ts` が存在する場合、`window` の `load` イベントで
    `navigator.serviceWorker.register(...)` を全ページに自動的に注入する（詳細は
    `docs/design-decisions.md` 参照）。当初これを知らずに `onMount` で独自に登録する処理を
    追加していたが、SvelteKit の自動注入と `type` オプションが食い違い（本番は無指定=`classic`、
    自作コードは `module` 指定）、レビューで再インストールが繰り返される懸念を指摘されたため削除した
- アイコン（`apps/web/static/icons/`, `apple-touch-icon.png`）
  - 独自の簡易プレースホルダー（波形モチーフ）。**ブランドアイコン未確定のための仮素材**であり、
    既存 favicon（Svelte ロゴ）の流用は避けた。確定後に置き換えが必要

## 検証状況

### デスクトップ Chrome（検証済み）

playwright-cli 経由の実 Chrome（`--persistent` プロファイル）で確認した。

- Chrome DevTools Protocol の `Page.getInstallabilityErrors` が `[]`（インストール可能条件を満たす）
  - **注意**: in-memory の一時プロファイル（`--persistent` なし）では Chrome がそもそも
    `in-incognito` を理由にインストール不可判定を返す。実質常に非インストール可能に見えるため、
    installability を確認する際は persistent プロファイルが必須
- `beforeinstallprompt` イベントの発火を確認（`+layout.svelte` に登録コードがない最終状態・
  `fetch` ハンドラなしの最終状態の両方で再確認済み）
- `.webmanifest` の `Content-Type` が `vite dev` / `wrangler dev`（本番相当の Cloudflare Workers
  Static Assets）の両方で `application/manifest+json` になることを確認（拡張子起因で
  `application/octet-stream` になる懸念はなかった）
- `navigator.serviceWorker.getRegistrations()` で、SvelteKit 自動注入による登録が
  `vite dev`（`type: 'module'`）・`wrangler dev` 本番相当ビルド（無指定 = `classic`）の
  両方で有効になっていることを確認（`+layout.svelte` に登録コードを書いていない状態で確認）
- Chrome DevTools Protocol の `ServiceWorker.deliverPushMessage` で、実際の push サービスへの
  配送を経由せずに `push` イベントを直接シミュレートし、`showNotification` が正しい
  title/body で通知を作成することを確認
  - 開発用サンドボックス環境は outbound network を許可リスト方式で制限しており
    （`docs/web-push-spike.md` に既知の制約として記載済み）、実際の push サービス
    （`fcm.googleapis.com` 等）への配送は試せない。CDP 経由のシミュレーションはこの制約を
    回避して受信側ロジックのみを検証する方法として有効だった
- `notificationclick` の分岐ロジック: OS 通知そのものをクリックする操作は自動化できない
  （`Notification.prototype.click()` 相当の API は存在しない）が、Playwright の
  `BrowserContext.serviceWorkers()` で取得した Worker コンテキストに対して
  `worker.evaluate()` を実行し、`self.clients.matchAll` / `self.clients.openWindow` を
  差し替えた上で `notificationclick` イベントを直接 dispatch することで、
  既存クライアントがある場合の `focus()` 分岐、ない場合の `openWindow('/')` 分岐の
  両方を実際のコードパスで確認した
- `fetch` ハンドラの要否を A/B で検証した: ハンドラを追加した状態と削除した状態の両方で
  `Page.getInstallabilityErrors` が `[]`、`beforeinstallprompt` の発火も変わらないことを
  確認した（Chrome 151 で実測）。Chrome for Developers 公式ブログには「`beforeinstallprompt`
  にはなお `fetch` ハンドラが必要」との記述があるが、現行バージョンでは不要という実測結果を
  優先し、`fetch` ハンドラは追加しなかった。理由の詳細は `docs/design-decisions.md` 参照

### Android 実機（保留）

`/debug/push` は開発環境限定（本番ビルドでは 404 を返す。VAPID 秘密鍵で任意の endpoint に
fetch できてしまうため #8 で意図的に制限している）。一方 Web Push / Service Worker の登録は
secure context を要求し、LAN 上の IP へ `http` でアクセスする方式は使えない。

実機からのアクセス方法（USB ポートフォワーディングや `cloudflared`/`ngrok` 等のトンネル）は
検討したが、**ユーザー判断により今回は保留**し、本番運用を開始してから確認する方針にした
（コードベースに問題がなければ、実機確認なしでマージして良いという判断）。

依存 Issue #8 の受け入れ条件は「iOS 実機」を前提に書かれているが、ユーザーが普段使うのは
Android のため、**iOS 実機確認は Android 実機確認に読み替える**（Issue 本文の申し送り事項）。

### iOS Safari（ホーム画面未追加）（公開情報のみ、実機未確認）

私（Claude）および今回の検証環境は iOS 実機を持っていないため、ユーザー了承の上で
公開情報の記録に留める。

- iOS/iPadOS 16.4（2023 年）で Web Push がホーム画面追加済みの Web App にのみ対応する形で
  追加された。ホーム画面に追加していない通常の Safari タブでは Web Push は機能しない
- Chrome の `beforeinstallprompt` に相当する自動インストールバナーは存在しない。ユーザーは
  共有メニューから「ホーム画面に追加」を手動で選ぶ必要がある
  → オンボーディングでは、iOS ユーザーに対してこの手動手順を明示的に案内する必要がある（#24 に申し送り）
- 上記はいずれも WebKit 公式ブログの記述に基づく。ホーム画面未追加時に
  `pushManager.subscribe()` や `Notification.requestPermission()` を呼んだ際の正確な
  挙動（例外の種類など）は実機で確認していない

### Firefox / autopush（未検証、次 Issue へ再申し送り）

`docs/web-push-spike.md` で #8 から #9 へ申し送られていた「Firefox / autopush での
legacy `aesgcm` 受理可否」は、今回も確認していない。Issue #9 の作業内容・受け入れ条件に
Firefox は明記されていないため、今回のスコープには含めず、必要になった時点で改めて確認する。

## 次の Issue への申し送り

- Android/iOS 実機での受信確認: 本番運用開始後、Workers Logs 等で実配送を確認できる
  タイミングで改めて実施する（このセッションでは未実施）
- iOS のオンボーディング案内文（#24）: 「ホーム画面に追加」の手動手順を案内する必要がある
- アイコン: プレースホルダーのため、ブランド確定後に置き換える
- Firefox / autopush の `aesgcm` 受理可否: 必要になった時点で確認する
- オフラインキャッシュ（`$service-worker` からの precache）: 今回は実装していない。
  必要になれば別 Issue で検討する
