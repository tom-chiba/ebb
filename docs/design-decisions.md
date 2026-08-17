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
   → Web Crypto ベースの実装が必要
   - #8 で `@block65/webcrypto-web-push`（legacy な `aesgcm` 実装）の採用を
     確定したが、デスクトップ Chrome では実際に受理・復号・表示されたものの
     Android 実機では表示されなかった（#9 で保留していた確認を #77 で実施）。
     #77 で `crypto.subtle` ベースの RFC 8291 `aes128gcm` 自前実装に置き換え、
     `@block65/webcrypto-web-push` への依存は削除した（詳細は
     `docs/web-push-spike.md`）
2. **Free プランは CPU 10ms/リクエスト**
   → cron で全件その場送信は不可。Queues でファンアウトし 1メッセージ = 1通知にする
   → Queues 無料枠は 1万オペ/日（保持 24h）= 実質 1日1万通知が上限
3. **Better Auth + D1 の既知の罠**: D1 の内部テーブル `_cf_METADATA` を Kysely の
   introspection が読もうとして `better-auth generate` が失敗する
   - #10 で確定した。この罠は `database: env.DB`（D1 バインディングを直接渡す、built-in
     Kysely アダプター経路）を使った場合にのみ起きる。`drizzleAdapter` はスキーマ生成時に
     DB へ一切問い合わせないため、この経路を採用すれば構造的に避けられる（詳細は
     `## Better Auth + Google OAuth (#10)` を参照）
4. cron は「通知時刻」ではなく「巡回間隔」。通知時刻は `reviews.scheduled_at` が持つ
   → cron 間隔 = 通知の最大遅延。毎分実行でも無料枠に余裕（1440回/日 ≪ 10万/日）
5. SvelteKit の Worker は `fetch()` のみ公開 → Cron 用 Worker を分ける必要がある
6. Workers で `fs` は使用不可 → `$app/server` の `read()` を使う

## 実装上の要注意点（追加）

7. **Queues 不採用のため cron の送信件数に上限が必須**
   → `SELECT ... LIMIT 20` 程度に絞り、残りは次周期へ。毎分実行なら 1時間 1200 件さばける
8. **E2E で Google OAuth を通すのは不安定**
   → `createAuth` の `emailAndPassword` を `dev`（`$app/environment`、`/debug/*` と同じ
   判定）限定で有効化し、`/debug/auth/dev-login`（dev 限定、固定メール/パスワードで
   signIn/signUp）経由でセッションを発行する方式にした（#65）。本番ビルドでは
   `emailAndPassword` 自体が無効になり、`dev-login` も 404 になるため本番の認証ロジックに
   影響しない。固定パスワードはローカル D1 に永続化されるため変更しない運用とする
   （変更すると既存ユーザーとパスワード不一致になり、`dev-login` 側の再作成処理が
   常に走る）
9. 購読が失効したら（Push サービスが 410 Gone を返す）DB から購読を削除する処理が必要

## モノレポの土台（#1）

- **TypeScript は 6.0 系に固定**（`~6.0.3`）。最新は 7.0.2 だが `typescript-eslint@8.65` の
  peer が `>=4.8.4 <6.1.0`、`svelte-check@4.7.4` が `^5.0.0 || ^6.0.0`。
  上限を決めているのは typescript-eslint の `<6.1.0` なので、`^` ではなく `~` で 6.1 も塞ぐ
  - バージョンは `pnpm-workspace.yaml` の `catalog` で一元管理する
- **`packages/*` は build を持たず、`exports` から TS ソースを直接公開する**
  （Vite / esbuild / wrangler がそのまま解決できるため）
  - 帰結: 依存側ソースの型検査は **consumer 側の tsconfig で行われる**
    → 全 consumer が `tsconfig.base.json` を継承する必要がある
  - `exports` には `"./package.json": "./package.json"` も必ず足す。`"."` だけだと
    `<pkg>/package.json` を解決しようとする下流ツール（Vite/vitest プラグイン、eslint
    resolver、wrangler/esbuild プラグインなど）が `ERR_PACKAGE_PATH_NOT_EXPORTED` で落ちる
  - リポジトリ全体で構文を型消去可能に保つため `erasableSyntaxOnly` を有効にする
    （`enum` / `namespace` / パラメータプロパティが禁止される）。
    `packages/*` はソースをそのまま配るので必須（consumer 側のトランスパイラの能力に
    前提を置かない）、`apps/*` は揃えるため
  - 相対 import に `.ts` 拡張子は書かない（`moduleResolution: bundler` では `TS5097`）。
    バンドラ経由での消費が前提で、Node のネイティブ型消去での直接実行は前提にしない
- **共有する compilerOptions は `tsconfig.base.json`**、ルート `tsconfig.json` は
  それを継承してリポジトリ直下の `*.ts` だけを見る実プロジェクトにする
  - 基底を `tsconfig.json` にして `files: []` を持たせると、(1) `files: []` が子に継承されて
    子の `include` が 0 件マッチでも `TS18003` が出ず「何も検査せず緑」になる、
    (2) ファイルを持てない config が `tsconfig.json` の名前を占領するため、
    ルート直下の `.ts` が typescript-eslint の `projectService` から見えない
  - 型検査の入口は `pnpm check`（= 各パッケージの tsconfig）。
    ルート直下に `.ts` が無い間、ルートで直接 `tsc -p .` すると `TS18003` になるのが正常
- **`tsconfig.base.json` は実行環境の型を含めない**（`lib` は `ES2023` のみ）
  - `packages/core` は純ロジックなので実行環境の型を持たせない。
    **`console` も使えない**（ログは呼び出し側の責務）。
    一方 `packages/push` は Web Crypto / `fetch` を使うので実行環境の型を持つ
  - `noUncheckedIndexedAccess` は #15 の API の形を規定する。プリセット配列を復習回数で
    引くと `presets[step]` が `number | undefined` になるので、戻り型を
    `number | undefined` にするか境界で throw するかを #15 で決めることになる
  - `lib` / `target` の `ES2023` は、workerd も evergreen ブラウザも ES2024 を実装している
    ので実行環境が課す上限ではなく、意図的に保守的に置いた下限。必要になったら上げる
  - この下限が効くのは `packages/*` と `apps/scheduler` だけ。`apps/web` は
    SvelteKit 生成の `target: esnext` / `lib: [esnext, DOM, DOM.Iterable]` に従う
    （`apps/web` で書いた ES2024 の API を `packages/core` へ移すと落ちる、という非対称が残る）
- **Node のバージョンは `mise.toml` が正**。`engines` は警告しか出さない
  - **Active LTS の最新（24.18.1 / Krypton）を採る**。26.x のほうが新しいが、
    2026-10-28 まではまだ Current（非 LTS）なので採らない。24 は 2026-10-20 に
    Maintenance 入りするので、26 が LTS 化したら上げる
  - このリポジトリはツールの管理に mise を使う前提なので、mise のネイティブ形式である
    `mise.toml` に置く（mise 公式も新規プロジェクトには `.tool-versions` ではなく
    `mise.toml` を推奨している）
  - `.node-version` は使えない。mise は `.node-version` を既定で読まない
    （`idiomatic_version_file_enable_tools` が空だと無視される）
  - 代償として **`actions/setup-node` の `node-version-file` は `mise.toml` を読めない**
    （対応形式は `.nvmrc` / `.node-version` / `.tool-versions` / `package.json` のみ）。
    CI 側は #6 で `jdx/mise-action` を使う
  - 個人用の上書きは `mise.local.toml`（gitignore 済み）
- **pnpm も `mise.toml` に入れる。ただし `package.json` の `packageManager` も残す**
  - mise.toml に入れる理由: `mise install` だけで Node と pnpm が揃う。入れないと
    pnpm は各自のグローバル環境任せになる
  - `packageManager` を残す理由: mise を使わない経路（Cloudflare のビルド、
    mise-action を使わない CI、corepack）でも版が決まるようにするため
  - **両方に同じ値を書く必要がある**。pnpm は `pmOnFail` が既定 `download` なので、
    ズレた場合は `packageManager` の版を自分でダウンロードして実行し直す。
    つまり**実行時は `packageManager` が勝ち、mise.toml の pin は黙って無視される**
  - pnpm 11 は `packageManager` を legacy 扱いにし、範囲指定できる
    `devEngines.packageManager` を新設した。ただし解決結果が `pnpm-lock.yaml` に
    記録されて再利用されるため、版の出所がもう 1 つ増える。今は素直に
    `packageManager` の完全一致 pin のままにしている
- ルートの `lint` / `format` / `test` / `check` は `pnpm -r --if-present run <name>` で
  各パッケージへ委譲するだけ
  - `--if-present` は必須。無いと委譲先が 0 件のとき `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` で失敗する
  - `pnpm -r` はワークスペースルートを対象に含まない
- **依存パッケージのビルドスクリプト（postinstall 等）は既定で実行されない**。実行する /
  しないを `pnpm-workspace.yaml` の `allowBuilds` に書くまで install は失敗する
  （`strictDepBuilds` の既定が true）。#2 で esbuild・workerd を踏むので、そこで書く
- **サプライチェーン対策は pnpm の設定で足りるところまでを #1 で入れた**。
  依存が 1 個のうちに入れておかないと、#2 で SvelteKit 系が一気に増えたあとでは
  「今あるものを全部許容する」しかなくなるため
  - `minimumReleaseAge: 10080`（7 日）。既定は 1440（1 日）。乗っ取り公開が
    発見・取り下げされるまでの猶予を稼ぐ。**範囲指定なら古い版に落ちるだけでエラーには
    ならない**（`typescript: latest` で 7.0.2 が弾かれると 6.0.3 が入る、と実測）。
    落ちるのは満たす版が 1 つも無いときだけで、そのときは `ERR_PNPM_NO_MATCHING_VERSION`。
    出たての版がどうしても要るなら `minimumReleaseAgeExclude` に足す
  - `trustPolicy: no-downgrade`（既定は `off`）。過去のリリースより信頼レベルが
    下がった版が来たら install を失敗させる。個別に通すなら `trustPolicyExclude`
  - `strictDepBuilds` / `blockExoticSubdeps` は pnpm 11 の既定が既に true なので書かない
    （`blockExoticSubdeps` により git / tarball 直指定は直接依存でしか使えない）
  - CI と GitHub 側（`pnpm audit`、dependency-review、Actions の権限最小化と SHA 固定、
    依存更新の自動化）は #32

### 後続 Issue への申し送り（#1 では検証していない）

- **実行環境の型は `types` に明示する**（#2 / #4 / #5 / #20）
  （`@cloudflare/workers-types` / `wrangler types` の出力）。
  TS 6 は `node_modules/@types` の自動取り込みをしないので、`types` への明示が必須
  - **導入したパッケージ側だけでなく、全 consumer 側でも揃える必要がある**。
    build を持たない構成では同じソースが consumer の数だけ別の global 型集合で検査され、
    パッケージ側だけ `lib`/`types` を足しても consumer 側で `Cannot find name 'fetch'` になる
    （しかもエラーの表示位置は `packages/*` 側）。
    つまり `packages/*` のソースは**全 consumer の型集合の共通部分でしか書けない**
  - global の有無だけでなく**同名 global のシグネチャ差**でも効く。例えば DOM の `BodyInit` は
    `Uint8Array<ArrayBuffer>` を要求するが workers-types は `Uint8Array<ArrayBufferLike>` を
    受けるので、`fetch(url, { body: payload })` が `apps/web` からの検査だけ `TS2322` で落ちる。
    直し方は tsconfig ではなくコード側（境界の型を狭く書く）。#20 で踏みやすい
- **ワークスペース内の依存は `workspace:*` で書く**。
  `linkWorkspacePackages` が既定 false なので、`^0.0.0` などと書くと
  npm レジストリを見て `ERR_PNPM_FETCH_404` になる
- **パッケージ間の依存の向きは `apps/* → packages/*` のみ**にする（#5 / #20）
  - `packages/core` は無依存
  - **`packages/push` は `packages/db` に依存させない**。送信結果（成功 / 410 / その他）を
    返すだけにし、**410 を受けた呼び出し側が `packages/db` の削除を呼ぶ**
    （要注意点 9 の実装場所。逆向きに生やすと push の単体テストに D1 が必要になる）
  - 帰結として「送信結果を見て 410 なら購読を削除する」糊が呼び出し側の数だけ増える。
    #20 で置き場（`apps/*` ごとに書く / `packages/db` に削除関数を用意して呼び出し規約だけ
    決める / `apps/web` からは送らない）を決めること
- #2 `apps/web` の tsconfig は
  `"extends": ["../../tsconfig.base.json", "./.svelte-kit/tsconfig.json"]` の配列指定にする
  - `target` / `lib` は SvelteKit 側が勝ち、strict 系はルート側が残る。ただしこれは
    「後勝ち」だからではなく **SvelteKit 生成の config が strict 系を書いていない** から。
    将来 SvelteKit が書き始めたら上書きされる
  - **`apps/web` では `include` を書かない**。書くと SvelteKit 生成の `include` を上書きして
    ambient 宣言がプログラムから外れ、`$env/*` や `./$types` が解決できなくなる。
    追加ファイル（`worker-configuration.d.ts` 等）は `types` か `/// <reference>` で入れる
  - ただし SvelteKit 生成の config は `src/service-worker.ts` を **`exclude`** に入れる
    （worker の型がアプリ全体に漏れるのを防ぐため）。service worker はアプリから
    import もされないので、このままだと **どの型検査にも入らない**。
    #19 / #20 で service worker 専用の tsconfig と、それを叩く `check` を足すこと
    （`types` や `/// <reference>` では直らない。除外されているのは ambient 型ではなく
    ソースファイル自身）。専用 tsconfig は下記の形にする:
    ```jsonc
    {
    	"extends": "../../tsconfig.base.json",
    	"compilerOptions": { "lib": ["ES2023", "WebWorker"], "types": [] },
    	"files": ["src/service-worker.ts", ".svelte-kit/ambient.d.ts"]
    }
    ```
    - **`.svelte-kit/tsconfig.json` は継承しない**。継承すると SvelteKit 生成の `include`
      （`src/**` など）も入ってきて、`types: []` / `DOM` なしの型集合で**アプリ全体が検査され**、
      普通のクライアントコードが `document` / `window` で大量に偽エラーになる
    - **`include` ではなく `files` で指定する**。`.svelte-kit/tsconfig.json` を継承した上で
      `include` を書くと、継承した `exclude`（SvelteKit がアプリ側の検査から外すために
      `src/service-worker.ts` を入れている）に打ち消されて **1 行も検査せず exit 0** になる
      （`ambient.d.ts` が残るので `TS18003` すら出ない）。`exclude` は `files` には効かない
    - `$service-worker` の型は `.svelte-kit/ambient.d.ts` 経由で解決するので `paths` は不要。
      逆にこのファイルを書かないと `$service-worker` が `TS2307` になる
    - `lib` は `WebWorker`（`ServiceWorkerGlobalScope` の出所）。`DOM` は入れない
    - 足したら `tsc --listFiles` に `service-worker.ts` が出ることを必ず確認する
      （この失敗は緑で埋没する）
- #3 各パッケージに実スクリプトが揃ったら `--if-present` を外す
  （付いている間はスクリプト名の typo が静かに成功する）
  - `lint` / `format` はリポジトリ直下のファイル（`README.md` / `docs/*` / `.github/*` /
    ルート直下の `.ts`）を対象にできていないので、ルート直実行に変える
  - `check` は tsc がプロジェクト単位でしか動かないので委譲のままにし、ルート直下の `.ts`
    （`eslint.config.ts` 等）を置いたら `tsc -p .` を足す。ルート `tsconfig.json` の
    `include: ["*.ts"]` はそのために用意してある（置くまでは `TS18003` になる）
    - #8 で `scripts/`（ワンショットの運用スクリプト置き場）を追加した際、
      `include` に `"scripts"` を足した。`apps/*` / `packages/*` に属さない
      スクリプトはこれ以外どの tsconfig からも見えず、足さないと `pnpm check` の
      対象外のまま静かに型エラーが埋没する
  - `packages/*` の `include` は `src/` 配下とパッケージ直下だけなので、テストを
    `test/` に置くと型検査から外れる。`src/` に併置するか `include` を広げる
  - `packages/*` の `include` はディレクトリ形式 `["src", "*.ts"]` で書く。
    `"src/**/*.ts"` のような拡張子固定の glob に**戻さない**こと。`.ts` にしか
    マッチせず、`.mts` / `.cts` / `.tsx` がツリーにあっても型検査から黙って外れ
    `pnpm check` が緑のまま通ってしまう（実測済み）
- #6 CI の Node / pnpm は `jdx/mise-action` で `mise.toml` から入れる
  - `actions/setup-node` の `node-version-file` は `mise.toml` に対応していないので、
    setup-node を使うならバージョンの二重管理になる
  - mise-action がキャッシュするのは mise 本体と mise が入れたツールまで。pnpm store の
    キャッシュ（setup-node の `cache: pnpm` に相当）は別途用意する必要がある

## scheduler Worker の雛形（#5）

- **ローカル D1 は `apps/web` と `apps/scheduler` で別インスタンスになる**（実測済み：
  `apps/web/.wrangler/state/v3/d1` と `apps/scheduler/.wrangler/state/v3/d1` が別々に生成される）。
  wrangler のローカル永続化はワーカーのディレクトリ単位で行われ、`database_id` が一致していても
  共有されない。remote では同じ D1 を指すので影響しないが、local では
  「`apps/web` で書いた行を `apps/scheduler` の cron が読む」という構成が成立しない
  - 本 issue のスコープでは両方に `migrate:local` すれば（ルートの
    `pnpm db:migrate:local` は `apps/web` と `apps/scheduler` の両方に適用する）
    `packages/db` 経由の SELECT 疎通確認は成立するため、これで十分と判断した
  - scheduler が web の書いた `reviews` 行を cron で読む #21 では、`--persist-to` 等で
    ローカル永続化先を共有する対応が必要になる見込み（#21 で検証する）
- **`apps/scheduler/package.json` に `migrate:remote` を持たせていない**。remote D1 は
  web/scheduler で共有なので、`apps/web` 側で一度適用すれば scheduler からも参照できる
  （二重に持たせても実害はないが、実行する意味のあるコマンドを増やさない）
  - 逆に `deploy` は scheduler 側にのみ用意した。`apps/web` は CI（#6）経由のデプロイを
    想定しているためこの時点では持たせていないが、scheduler は #6 より先に本番での
    cron 発火確認が必要なため、手動デプロイの入口を用意した
    - **#7 で `apps/web` にも `deploy` を追加し、CI から web/scheduler 両方の `deploy` を
      自動実行するようにした**。scheduler 側の `deploy` も「手動デプロイの入口」から
      CI 経由の自動実行に役割が変わっている

## production へのデプロイ（#7）

- **deploy ワークフローは `main` への push のみで起動し、`ci.yml`（`pull_request`）の
  lint/test/check を再実行しない**。main へのマージ自体がブランチ保護
  （`required_status_checks: ["ci"]`, `enforce_admins: true`）で CI 通過済みであることを
  前提にしている。「PR で検査、main で deploy」という当初の役割分担（技術スタックの節）どおり
- **`pnpm build` → `pnpm db:migrate:remote` → `pnpm run deploy` の順に実行する**。
  スキーマ変更は新コードのデプロイ前に反映しておく必要があるため。この順序は
  マイグレーションが**追加的（後方互換）である前提**に立っており、migrate 完了後・
  scheduler の `wrangler deploy` 完了までの間は旧バージョンの scheduler が新スキーマに
  対して毎分実行され続ける。rename/drop を伴う破壊的マイグレーションを行う場合は、
  この順序自体を見直す必要がある
- **ルートの `deploy` スクリプトは `pnpm -r --if-present run deploy` ではなく
  `pnpm --dir apps/web run deploy && pnpm --dir apps/scheduler run deploy` にした**。
  `--if-present` はスクリプト名の typo を静かに成功させる（#1 の罠と同じ）が、
  `lint`/`test` と違い `deploy` でこれを踏むと「本番に反映されていないのに CI が緑」になる
  ため実害が大きい
  - 当初は `db:migrate:local` と同じ `--filter @ebb/xxx` 明示 + `&&` 連結にしていたが、
    `pnpm --filter` はパッケージ名が一致しない場合も警告のみで exit 0 になる
    （実機確認済み: `pnpm --filter @ebb/does-not-exist run deploy` → exit 0）ため、
    「パッケージ名の typo／リネーム」には typo 対策が効かないままだった。
    存在しないディレクトリを指定すると ENOENT で確実に exit 1 になる `--dir <path>` に
    変更し、ディレクトリ指定の typo・リネームも確実に失敗させるようにした
  - `&&` 連結のため web 成功 / scheduler 失敗時は「web だけ本番反映済み」の部分適用状態が
    起こり得るが、自動ロールバックは本 issue のスコープ外（起きたら手動で追いデプロイする）
- **CI 実行時は `pnpm deploy`（bare）ではなく `pnpm run deploy` を明示する**。
  pnpm には `pnpm --filter <pkg> deploy <dir>`（ワークスペースの実行体をディレクトリに
  切り出す別コマンド）が予約されており、bare 呼び出しでも将来のpnpmバージョンでの
  挙動変化に依存しないよう `run` を明示した（現行の pnpm 11.18.0 では bare `pnpm deploy`
  でも package.json の `deploy` スクリプトに委譲されることを実機確認済み）
- **`apps/web/wrangler.jsonc` に `routes: [{ pattern: "ebb.tom-chiba.com", custom_domain: true }]`
  を追加**。Custom Domain の割り当てには Account 単位の Workers Scripts 編集権限だけでなく、
  対象ゾーン（`tom-chiba.com`）に対する **Zone: Workers Routes 編集権限**が API トークンに
  別途必要（Cloudflare 公式ドキュメントで確認）。「API トークンの権限は Workers Scripts / D1
  の編集に絞る」という #7 の当初方針だけでは custom domain の割り当てに失敗するため、
  トークン発行時にはこのゾーン権限を追加すること
  - `routes` を追加すると次回デプロイ以降 `workers_dev` は実質 `false` 扱いになり、
    既存の `*.workers.dev` URL は無効化される見込み。環境は local/production の2つのみで
    workers.dev URL を使い続ける想定はないため、意図した挙動として許容している
- **`concurrency.cancel-in-progress` は `ci.yml` の `true` と逆の `false` にした**。
  デプロイやマイグレーションの途中でキャンセルされると中途半端な状態が残るため、
  実行中のジョブはキャンセルさせない。ただし GitHub Actions の concurrency group は
  「実行中1件 + 待機中1件」までしか保持できない固定仕様（設定で深さを変える手段はない）で、
  main への push が短時間に3回以上続くと、待機中だった中間コミットのデプロイはキャンセル
  されて最新のものに差し替わる（＝完全な直列キューではない）
- **本番 D1 のマイグレーション適用は deploy ワークフローに自動組み込みにした**（手動手順の
  文書化ではなく）。ユーザー判断により、早期に自動化する方針を採った
- **`Install dependencies` の直後に `Verify Cloudflare authentication`
  （`wrangler d1 info ebb`）を追加した**。`CLOUDFLARE_API_TOKEN` の期限切れは、
  何も対策しないと migrate/deploy ステップの中で他のエラーに紛れて発生し、原因の切り分けが
  遅れる。認証だけを切り出して build より前に検証することで、期限切れなら
  「Verify Cloudflare authentication」というステップ名で明確に失敗させる
  - 当初は `wrangler whoami --json` を使っていたが、`whoami` は内部で `/accounts`
    （アカウント一覧取得 API）を呼ぶため **Account Settings Read 権限**が別途必要になり、
    「Workers Scripts / D1 / Workers Routes に絞った最小権限トークン」だと
    `whoami` 自体が失敗して全デプロイが止まってしまう（wrangler ソースの
    `getAccounts` → `fetchAllAccounts` で確認）。migrate/deploy ですでに必要な
    D1 権限だけで完結する `wrangler d1 info ebb`（読み取りのみ、状態を変更しない）
    に変更した
  - スコープは「トークンの期限切れ／無効」の検知のみ。`CLOUDFLARE_ACCOUNT_ID` の
    取り違えや、トークンは有効だが Workers Scripts/Workers Routes の権限が不足している
    ケースはこの認証チェックでは検知できず、引き続き `Migrate production D1` /
    `Deploy` ステップで初めて失敗する
- **`apps/web/wrangler.jsonc` にも `observability: { enabled: true }` を追加した**。
  `apps/scheduler/wrangler.jsonc` は cron 失敗を追えるよう既に有効化していたが、
  `routes` 追加で `apps/web` も本番トラフィックを受ける Worker になったため揃えた。
  なければ本番の web リクエスト失敗が Workers Logs に記録されず、インシデント調査の
  初手が「observability を有効化して再発を待つ」になってしまう
- **`ci.yml` / `deploy.yml` で重複していた checkout 以降のセットアップ手順
  （mise-action → pnpm store path 取得 → キャッシュ復元 → `pnpm install`）を
  `.github/actions/setup-pnpm` の composite action に切り出した**。バイト単位で重複していると
  片方だけ更新した際に CI と本番デプロイでツールチェーン挙動が分岐しかねない。
  `checkout` 自体はローカル composite action を読み込むために各ワークフローの
  先頭で必要なため、composite action 側には含めていない

## PWA 受信・通知確認 (#9)

- **SvelteKit は `kit.serviceWorker.register`（既定 `true`）かつ `src/service-worker.ts` が
  存在する場合、`navigator.serviceWorker.register(...)` を全ページの `window` `load` イベントに
  自動的に注入する**（`@sveltejs/kit` の `runtime/server/page/render.js` /
  `core/sync/write_server.js` で確認。このリポジトリには `svelte.config.js` が無く
  `vite.config.ts` の `sveltekit()` プラグインオプションで Kit を設定しているが、
  この既定値はそれとは無関係に効く）。dev では `type: 'module'`、本番ビルドでは
  無指定（`classic`）で登録される。**PWA 全体で Service Worker を有効にするための登録コードを
  アプリ側に書く必要はない**
  - 当初これを把握せずに `+layout.svelte` の `onMount` で独自に
    `register('/service-worker.js', { type: 'module' })` を呼ぶ処理を追加していたが、
    レビューで「本番では SvelteKit 自動注入（`classic`）と型が食い違い、Service Worker の
    Register/Update アルゴリズム上、登録のたびに再インストールが起きる懸念がある」と
    指摘された。`vite preview`（本番ビルド）でレンダリング後の HTML を直接確認したところ、
    実際に `addEventListener('load', function () { navigator.serviceWorker.register(sanitised); })`
    が注入されていることを確認し、指摘は正しいと判断して独自の登録コードを削除した
  - `/debug/push` の `subscribe()` は今も独自に `register()` を呼んでいるが、こちらは
    dev 環境限定のページで SvelteKit の自動注入と同じ `type: 'module'` を指定しているため
    型の食い違いは起きない（#8 由来のコードで #9 では変更していない）
- **`fetch` イベントハンドラは追加しなかった**。Chrome for Developers 公式ブログには
  「`beforeinstallprompt` のリッチなインストール導線には今も `fetch` ハンドラが必要」との
  記述があるが、実際に `fetch` ハンドラの有無で A/B して確認したところ、現行 Chrome
  （151、実測時点）では `fetch` ハンドラなしでも `Page.getInstallabilityErrors` が空、
  `beforeinstallprompt` も発火した。ブログの記述は書かれた時点の Chrome バージョンでは
  正しかった可能性があるが、現行バージョンの実機測定を優先し、コードに反映しなかった。
  `fetch` ハンドラを持つと Service Worker がページの全リクエストを横取りするようになり
  （`clients.claim()` と組み合わさるとより早いタイミングから横取りが始まる）、実装していない
  オフラインキャッシュ抜きでは素通しにする以外の意味がなく、単一障害点を増やすだけになる
  （Chrome 自身も「空の `fetch` ハンドラを付けるだけの実装がパフォーマンスを悪化させた」と
  同ブログで指摘している）。受け入れ条件が求めるのは「ホーム画面に追加して通知が届く」
  ことであり、これは Chrome の「メニューからインストール」でも満たせるため
  `beforeinstallprompt` 自体も本 Issue の必須要件ではない
- **`beforeinstallprompt` / installability の判定を Playwright の in-memory（一時）プロファイルで
  確認しようとすると、常に `in-incognito` 判定で失敗する**。Chrome はインストール自体を
  シークレットモードで許可しないため。判定を検証する際は `playwright-cli open --persistent`
  のような永続プロファイルが必須（実測済み）
- **push イベントの受信ロジックは、実際の push サービスへの配送を経由せずに Chrome DevTools
  Protocol の `ServiceWorker.deliverPushMessage` で直接シミュレートできる**。開発用サンドボックス
  環境は outbound network を許可リスト方式で制限しており（#8 で判明済み）実配送を試せないため、
  この方法で受信側（`showNotification` 呼び出し）のみを切り離して検証した
- **`notificationclick` の分岐ロジックは、Playwright の `BrowserContext.serviceWorkers()` で
  取得した Worker コンテキストに対して `worker.evaluate()` を使うと、実際の Service Worker
  内で直接検証できる**。OS 通知そのものをクリックする操作は自動化できないが、
  `self.clients.matchAll` / `self.clients.openWindow` をその場で差し替えて
  `self.dispatchEvent(new Event('notificationclick', ...))` すれば、既存クライアントが
  ある場合の `focus()` 分岐とない場合の `openWindow('/')` 分岐の両方を実際のコードパスで
  確認できる（実測済み）。Service Worker のコンテキストを掴むには、登録直後は
  Playwright にワーカーが見えないことがあるため、`unregister()` → `reload()` で
  登録し直す必要がある場合がある
- **`#1c2b39`（テーマカラー）は `apps/web/static/manifest.webmanifest` の
  `theme_color`/`background_color` と `apps/web/src/routes/+layout.svelte` の
  `<meta name="theme-color">` に別々にハードコードしており、共通化していない**。
  レビューで指摘された重複だが、値を1箇所にまとめるには manifest を
  `src/routes/manifest.webmanifest/+server.ts` のような動的レスポンスに変更する必要があり、
  静的な2値の重複を解消するには過大な変更になると判断し、意図的に許容した。ブランドカラー
  確定時にはこの2箇所を両方更新する必要がある点に注意
- **PWA アイコンは独自の簡易プレースホルダーを用意した**。既存の favicon（`favicon.svg`）は
  SvelteKit テンプレート由来の Svelte ロゴであり、ホーム画面アイコンとして流用すると
  第三者のブランドがユーザーに見える形で残ってしまう。ブランド未確定の現時点では
  自作の簡易マーク（波形モチーフ）を使い、確定後に置き換える前提とした
- **iOS 実機・Android 実機での受信確認はユーザー判断で保留した**。`/debug/push` が開発環境限定
  （本番ビルドでは 404）である一方、Web Push / Service Worker の登録は secure context が必須で、
  LAN 上の IP への `http` アクセスでは動作しない。実機からアクセスするには USB ポート
  フォワーディングやトンネルなどの追加セットアップが必要になるため、コードベースに問題が
  なければ実機確認なしでマージし、本番運用開始後に確認する方針にした
  - 依存 Issue #8 の受け入れ条件は「iOS 実機」を前提に書かれているが、ユーザーが普段使うのは
    Android のため、**iOS 実機確認は Android 実機確認に読み替える**運用にした（詳細は
    `docs/pwa-notification-receive.md`）
- **iOS Safari（ホーム画面未追加）でどう見えるかは、実機を用意できないため公開情報の記録に
  留めた**（ユーザー了承済み）。iOS/iPadOS 16.4 で Web Push はホーム画面追加済みの Web App
  にのみ対応する形で追加されており、Chrome の `beforeinstallprompt` に相当する自動インストール
  バナーは存在しない（WebKit 公式ブログで確認。詳細は `docs/pwa-notification-receive.md`）

## Better Auth + Google OAuth (#10)

- **`_cf_METADATA` の罠は「D1 に実接続する経路」でのみ起きる**。`betterAuth({ database: env.DB })`
  （D1 バインディングを直接渡す、built-in Kysely アダプター経路）で `generate`/`migrate` を実行すると
  Kysely の introspection が D1 の内部テーブル `_cf_METADATA` を読もうとして失敗する。
  **`drizzleAdapter` はスキーマ生成時に DB へ一切問い合わせない**（フィールド定義から
  コードを組み立てるだけ）ため、`drizzleAdapter` 経路を採用してさえいれば、実際に本物の D1 に
  繋がなくても Kysely introspection 自体が走らず、この罠を構造的に避けられる。
  `packages/db/auth-cli-config.ts` は `drizzle({} as D1Database)`（未使用のダミー）に
  `drizzleAdapter` を被せているだけで、元の失敗を再現して確認したわけではない
  （再現には本物の D1 バインディングが要り、`better-auth generate` を Node から実行する CLI の
  実行コンテキストではそもそも D1 バインディングを持てない）
  - Context7 経由で得たドキュメント（GitHub `main` ブランチ由来）には `generate --adapter drizzle
--dialect sqlite`（DB 接続なしで生成できる新フラグ）が載っていたが、実際に導入した
    `@better-auth/cli@1.4.21`（npm 公開済みの最新）には未実装だった（`error: unknown option
'--adapter'` で実測確認済み）。ドキュメントが先行しリリースが追いついていない状態だったため、
    `--config` + ダミー DB 方式（`better-auth-cloudflare` コミュニティパッケージが採用している
    パターンと同型）に変更した
- **`auth-cli-config.ts` に `socialProviders`/`plugins` は書かない**。Google OAuth は
  追加のテーブル・カラムを生成しないため、生成結果に一切影響しない（`socialProviders` を
  含む版と含まない版で `generate:auth-schema` の出力が完全に一致することを実測確認済み）。
  書いても「google 固有のフィールドが生成に影響する」という誤解を招くだけなので削除した
- **`packages/db` は `better-auth`/`@better-auth/cli` を devDependency にしか持たない**。
  `auth-cli-config.ts` はスキーマ生成専用のツール設定（`drizzle.config.ts` と同種）であり、
  アプリケーションコードからは import されない。実行時の設定（`socialProviders` の実値含む）は
  `apps/web/src/lib/server/auth.ts` の `createAuth(env, origin)` に別途持つ。
  「依存の向きは `apps/* → packages/*` のみ」を保つため
- **`createAuth` はファクトリ関数**。D1 バインディング（`platform.env.DB`）はリクエストごとにしか
  手に入らないため、モジュールスコープで単一の `auth` インスタンスを作れない
  （`createDb` と同じ制約）。`baseURL` もリクエストの `event.url.origin` から都度導出する
- **`apps/web/src/routes/api/auth/[...all]/+server.ts` は作らなかった**（Issue の作業内容には
  明記されていたが、意図的に外した）。`better-auth/svelte-kit` の `isAuthPath(url, options)` は
  実際には `_url.origin !== baseURL.origin` を見ている（origin 非依存という当初の記述は誤りで、
  レビューで訂正した）。`baseURL.origin` は `options.baseURL` が文字列なら `new URL(baseURL).origin`
  になり、`createAuth(env, origin)` は毎リクエスト `event.url.origin` を `baseURL` に渡すため、
  比較対象の2つの origin は常に「同じリクエストの origin」同士になり必ず一致する。
  つまり local/production どちらでもマッチするのは「origin を見ないから」ではなく
  「`baseURL` をリクエスト毎の origin から都度導出しているから」。この不変条件が崩れる変更
  （例: `baseURL` を固定の env 変数に変える）をする場合は、対応するルートファイルが無いことに
  注意すること（`isAuthPath` が false を返すと `/api/auth/*` は静かに 404 になる）
- **`hooks.server.ts` は `svelteKitHandler` を使わず、`isAuthPath` + `auth.handler` を直接呼ぶ**。
  `svelteKitHandler` は内部で `getSession` を呼ばないため、公式サンプル通りに
  `getSession` → `svelteKitHandler` の順で書くと、`/api/auth/*` へのリクエストでも
  `getSession`（D1 read）が実行されてから `auth.handler` に委譲され、その `getSession` の結果は
  どの `locals` 読み取りにも到達せず捨てられる。`isAuthPath` は `better-auth/svelte-kit` から
  そのまま import できるので、これで早期リターンしてから `getSession` を呼ぶことで、
  `/api/auth/*` に対する無駄な D1 読み取りとレイテンシを避けた
- **`createAuth` に `sveltekitCookies(getRequestEvent)` を最後の plugin として追加した**。
  `hooks.server.ts` は `auth.api.getSession(...)` を `auth.handler` 経由ではなく直接呼ぶため、
  `getSession` 内部でセッションが延長・削除される際の `Set-Cookie`
  （`node_modules` 内の実装を確認: `ctx.context.responseHeaders` に書かれるだけで、
  `auth.handler` の `Response` を経由しない呼び出しでは誰も読まない）が
  `sveltekitCookies` を挟まない限り失われる。公式ドキュメントの
  「Server Action Cookies」節がこの plugin を要求している理由と同じ機構
  - **この修正は動作確認できていない**。再現には `session.updateAge`（既定1日）を超えて
    古いセッションが必要で、実際の Google アカウントでのログインが前提のため
    このセッションでは検証手段がない。better-auth のソース（`sveltekitCookies` の
    `_flag === "router"` ガード）と公式ドキュメントの記述に基づいて適用したのみ
  - `sveltekitCookies` は `getRequestEvent`（`$app/server`、AsyncLocalStorage 依存）を
    使うため、`pnpm build && wrangler dev`（実際の workerd ランタイム、`nodejs_compat`
    有効）で `/` `/debug/d1` を確認し、AsyncLocalStorage 関連のエラーが出ないことは確認した
    （`/debug/auth` は本番ビルドでは 404 になるが、これも実際に確認した）。
    ただし `getRequestEvent()` の呼び出し自体は「`getSession` が実際に Set-Cookie を
    生成したとき」だけ実行される分岐にあり、未ログイン状態の `getSession` 呼び出しは
    そこに到達しない。つまり ALS がモジュール解決・Worker 起動を壊さないことは確認できたが、
    実際に `getRequestEvent()` が呼ばれる分岐そのものは上記と同じ理由で未検証
  - レビューで機構自体（動作確認できていない、と上で書いた部分）の裏取りが進んだ:
    SvelteKit 本体の `respond.js` は `handle` フック全体を `with_request_store(...)` で
    ラップしており、`hooks.server.ts` 内の `getRequestEvent()` は常にこの ALS コンテキスト内
    から呼ばれる。また `sveltekitCookies` の `_flag === "router"` ガードは `auth.handler`
    経由（レスポンス自身の Set-Cookie で完結する）のときだけ処理をスキップし、
    `getSession` 直接呼び出しの経路では `event.cookies.set()` → SvelteKit の
    `add_cookies_to_headers` を通って `resolve(event)` のレスポンスに正しく載る配線に
    なっていることをソースで確認した。**これは「配線が正しく組まれている」という静的な
    裏取りであり、実際に `session.updateAge` を超えたセッションで Set-Cookie が発生する
    場面を動かして確認したわけではない**。その一点（挙動そのものの動作確認）は
    実際の Google アカウントでのログインが前提のため、依然としてユーザー側の実機確認が必要
- **`hooks.server.ts` の `getSession` 呼び出しを `try/catch` で囲んだ**。セッション行の競合削除
  （別デバイスでのサインアウト等）や D1 の一時的な失敗で `getSession` が例外を投げると、
  `resolve(event)` の手前でその例外が伝播し、認証と無関係な通常ページの閲覧まで
  500 になってしまう。失敗時は `locals.user`/`locals.session` を `null` にフォールバックする
- **Google Cloud Console に登録するリダイレクト URI**（OAuth クライアント作成時にユーザーが登録）:
  - local: `http://localhost:5173/api/auth/callback/google`（`pnpm dev` = `vite dev` の既定ポート）
  - production: `https://ebb.tom-chiba.com/api/auth/callback/google`
  - **OAuth 同意画面の公開設定にも注意**: 個人アカウントで新規作成した GCP プロジェクトは
    既定で「テスト」公開状態になり、Google Cloud Console の「対象ユーザー」でテストユーザーとして
    明示的に追加したアカウントしか同意画面を通過できない（アプリコードとは無関係に
    `access_blocked` になる）。自分の Google アカウントをテストユーザーに追加すること
- **secret の登録**: `BETTER_AUTH_SECRET` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` は
  ローカルは `.dev.vars`、本番は `wrangler secret put <NAME>`（#8 の VAPID 鍵と同じ方針で
  **ユーザーが実行する**。このセッションでは未実行）。`BETTER_AUTH_SECRET` はランダム値でよく、
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` で生成できる
  （`.dev.vars.example` は空欄のままなので、clone 後は各自このコマンドで生成して埋める）
  - **`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` が未登録のまま merge しても、サイト全体は
    落ちない**ことを実測済み。`.dev.vars` から該当行を丸ごと削除して（空文字ではなく未定義の
    状態を再現）`pnpm dev` → `/` `/debug/d1` を確認したところ、`[Better Auth]: Social provider
google is missing clientId or clientSecret` の warning のみで両ページとも正常に描画された。
    影響は `/api/auth/*` の実処理（サインイン試行時に 500 `CLIENT_ID_AND_SECRET_REQUIRED`）に留まる
  - **`BETTER_AUTH_SECRET` は未登録だとサイト全体が 500 になる（意図的）**。better-auth は
    secret 未設定時、公開されている固定文字列 `"better-auth-secret-12345678901234567890"`
    （`node_modules` 内 `utils/constants.mjs` の `DEFAULT_SECRET`）にフォールバックし、
    `NODE_ENV === 'production'` のときだけ throw するガードしか持たない
    （`@better-auth/core/env` の `isProduction`）。Cloudflare Workers は `NODE_ENV` を
    自動で立てないため、本番でこのガードに頼ると**session cookie が誰でも知っている鍵で
    署名される**（session forgery）まま気付かない可能性がある。そのためこちらのガードには
    頼らず、`hooks.server.ts` で `BETTER_AUTH_SECRET` 未設定を明示的に検出し 500 にしている
    （利用不可にはなるが、黒塗りセッションを本番で握るよりは安全という判断）
- **Step 5 の検証は「コード起点」に限定した**（実際の Google アカウントでの同意画面通過は未検証、
  ユーザー判断）。確認したのは (1) `/api/auth/sign-in/social` が `accounts.google.com` への
  正しい `client_id` を含む URL を返すこと（ダミーの Client ID で検証。Google 側が
  `invalid_client` で即エラーになるため、`redirect_uri` の値そのものは未確認）、
  (2) `hooks.server.ts` が `locals.user`/`locals.session` を解決するコードパス自体が
  型検査・実装レベルで正しいこと、(3) `drizzleAdapter` によるスキーマ解決と D1 への
  実書き込みが機能すること — ダミー Client ID でのサインイン試行時に `verification`
  テーブルへ実際に `callbackURL`/`codeVerifier`/`oauthState` を含む行が insert されることを
  ローカル D1（`wrangler d1 execute ebb --local`）で確認し、確認後に削除した。これにより
  `db._.fullSchema` 経由のテーブル解決・カラムマッピング（`timestamp_ms` 等）が
  実際に機能することまでは実証済み。`redirect_uri` の一致確認、同意画面以降の完了、
  ログアウト後の Cookie 削除、リロード後のセッション維持の**実機確認**はユーザーが
  Google Cloud Console でクライアントを作成した後に `/debug/auth`（dev 限定ページ、
  既存の `/debug/push` `/debug/d1` と同じパターン）で行う
- **`pnpm-workspace.yaml` に `semver@6.3.1` を `trustPolicyExclude` へ追加した**。
  `@better-auth/cli` 経由で入る依存で、pnpm の `no-downgrade` チェックが無関係な
  `semver@7.x` 系（provenance あり）の公開日時と比較して誤検知する既知の false positive
  （`pnpm/pnpm` discussion #11084 で同事象が報告されている。乗っ取りではないことを確認済み）
  - 同時に `@prisma/client` / `better-sqlite3`（`@better-auth/cli` が依存する、使用しない
    アダプター向けのビルドスクリプト）を `allowBuilds` で `false` にした
- **`rateLimit` を明示的に有効化した**（Codex によるレビューで指摘）。既定は
  `enabled ?? isProduction`（`NODE_ENV === 'production'` 判定）だが、Workers はそれを
  自動で立てないため実質無効になっていた。既定の in-memory storage は Workers の
  isolate ごとに独立しカウントが共有されないため `storage: 'database'` にし、
  `rateLimit` テーブルを D1 に持たせた（`auth-cli-config.ts` にも同じ設定を追加して
  スキーマ生成に反映している）。`/sign-in/social` は `verification` テーブルへの insert を
  伴うため `customRules` で既定より厳しく絞った（60秒あたり10回）。ローカルで
  `/api/auth/sign-in/social` に11回連続でリクエストし、11回目から `429` が返ることと
  `rate_limit` テーブルに実際に行が作られることを実測確認済み
- **deploy ワークフローに `wrangler secret list` で必須 secret の有無を確認するステップを
  追加した**（Codex によるレビューで指摘）。`BETTER_AUTH_SECRET` 未設定だとサイト全体が
  500 になる（このファイルの secret の登録の項）ため、`wrangler secret put` を merge 前に
  実行し忘れた場合に自動デプロイでそのまま本番へ出てしまう問題を防ぐ。値は出力せず
  名前の有無だけを見る。**このステップ自体は実際の Cloudflare 環境に対しては未実行**
  （サンドボックスから Cloudflare の API に到達できないため）。コマンド構文が実際に
  パースされること（ネットワークエラーで止まり、構文エラーでは止まらないこと）と、
  `jq` によるパース・不足検出ロジックをモックの JSON で確認したのみ

## ログイン / ログアウト UI とルート保護 (#11)

- **`redirectTo` クエリパラメータはオープンリダイレクト対策として `$lib/server/safe-redirect.ts`
  の `toSafeRedirect` でサニタイズする**。当初「単一の `/` で始まり `//`・`/\` でない」という
  手書きの正規表現チェックで実装したが、レビューで指摘され実測確認した通りこれでは不十分
  だった: ブラウザの URL パーサーは解釈前に文字列中の ASCII タブ/改行をすべて除去するため、
  `redirectTo=%2F%09%2Fevil.com`（デコード後 `"/\t/evil.com"`）は正規表現を通過しつつ、
  実際に `Location` ヘッダーとして解決されると `"//evil.com"` 相当になり外部オリジンへの
  オープンリダイレクトが成立してしまう（`new URL("/\t/evil.com", "https://example.com/")`
  が `https://evil.com/` になることを実測確認済み）。手書きの禁止パターンを増やす対症療法
  ではなく、ブラウザが実際に使うのと同じ WHATWG URL パーサー（Node の `URL`）にダミーの
  ベース URL を渡して解決し、**解決後も origin が変わっていないか**で判定する方式に変更した。
  これによりタブ/改行に限らず、同じパーサーが認識するあらゆる scheme-relative / 絶対 URL
  表現を一律に弾ける。**比較対象は `SAFE_BASE` の文字列そのものではなく
  `new URL(SAFE_BASE).origin`（`SAFE_ORIGIN`）から導出する**（レビュー指摘）。
  `SAFE_BASE` に将来パスや末尾スラッシュが付く変更が入ると `origin` の文字列表現と
  食い違い、比較が常に不一致になって全リダイレクトが黙って `fallback` に落ちる
  （安全側だが機能的なリグレッション）ため、`URL#origin` の値同士で比較する。
  検証は `/login/+page.server.ts` の `load` に集約し、コンポーネント側
  （`callbackURL` に渡す値）は `data.redirectTo` を素通しするだけにした。同じ値を
  `/app/+layout.server.ts` 側でも扱うが、そちらは `url.pathname + url.search` から
  自前で組み立てた値（常に同一オリジン）なのでサニタイズ不要
- **`/app/+layout.server.ts` はページのみを保護する**。SvelteKit の layout load は
  ページ（`+page.svelte`）にのみ実行され、`+server.ts`（API エンドポイント）には
  適用されない。今後 `/app` 配下に `+server.ts` を追加する場合は、そのファイル自身で
  `locals.user` を確認する必要がある（「まとめて保護する」はページ限定の意味）
- **`/app/+page.svelte` に専用の `+page.server.ts` は作らなかった**。SvelteKit は
  祖先の layout load が返したデータを子孫の `PageProps`（`./$types` 経由）にマージするため、
  `/app/+layout.server.ts` が返す `user` を `/app/+page.svelte` からそのまま参照できる
- **既にログイン済みで `/login` に直接アクセスした場合は `redirectTo`（既定 `/app`）へ
  即リダイレクトする**。ログインフォームを再度見せる意味がなく、実装も
  `/login/+page.server.ts` の `load` に3行足すだけのため許容した
- **`/app/+layout.svelte` のログアウトボタンは `authClient.signOut()` の戻り値
  `{ error }` を確認し、失敗時は `location.reload()` を呼ばずメッセージを表示する**。
  当初は戻り値を無視して常に reload していたが、レビューで `debug/auth/+page.svelte`
  （#10）の既存パターンとの後退を指摘され修正した。戻り値を見ないと、sign-out
  リクエスト失敗時にサーバー側 Cookie が破棄されないままリロードされ、
  `/app/+layout.server.ts` は `locals.user` が真のままなので何も起きず、
  ユーザーには失敗が一切通知されない
- **検証は「コード起点」に限定した**（#10 の Step 5 と同じ方針）。確認したのは
  (1) 未ログインで `/app` を開くと `/login?redirectTo=%2Fapp` へ 303 リダイレクトされること、
  (2) ログイン済み状態（後述の方法で D1 に直接セッションを作って再現）で `/app` を開くと
  ヘッダーにユーザー名が表示されリダイレクトされないこと、(3) ログアウトボタンで
  セッションが破棄され `/login` に戻ること。実際の Google 同意画面を通したログイン→
  元ページへの復帰そのものは、実アカウントでの操作が前提のためユーザー側の実機確認が必要
  （#10 と同じ制約）
- **ログイン済み状態を作る方法**: better-auth のセッション Cookie（`better-auth.session_token`）
  は生の `session.token` ではなく `` `${token}.${base64(HMAC-SHA256(token, BETTER_AUTH_SECRET))}` ``
  を `encodeURIComponent` した値（`better-call` の `signCookieValue`、実装をソースで確認済み）。
  検証用に `user`/`session` 行をローカル D1 に直接 insert し、上記アルゴリズムで計算した
  署名付き Cookie をブラウザにセットすることでログイン済み状態を再現した
  （実際の Google OAuth を経由しない）。検証後は insert した行を削除した

## メモの CRUD API (#13)

- **form actions ではなく `+server.ts` の JSON API にした**（`/api/memos`、
  `/api/memos/[id]`）。Issue タイトルが「CRUD API」であること、UI（#14）が
  form actions 前提の設計をまだ決めていないこと、認可・バリデーション・クエリを
  `$lib/server/memos.ts` に切り出せば #14 が form actions を被せたくなっても
  この層は無変更で済むことから採用した
- **`intervalPresetId` は作成・更新時の必須入力にした**。`interval_presets` の
  システム標準プリセットの実データ投入（seed）は #15 のスコープであり、この Issue の
  時点では1件も存在しない（`docs/schema.md` に明記済み）。作成 API は
  `intervalPresetId` を必須で受け取り、`interval_presets` に対して
  「自分の custom プリセット、またはシステム標準プリセット（`user_id IS NULL`）」で
  存在するかを事前チェックし、無ければ 400 を返す（DB 側のテナント分離トリガー
  `0004_memos_interval_preset_owner_trigger.sql` の `RAISE(ABORT, ...)` を
  生の 500 としてクライアントに漏らさないため）。#15 でシステム標準プリセットが
  seed されたら、クライアント側で「未指定なら標準プリセットを使う」ような
  デフォルト値の付与を検討できる
- **削除は論理削除**（`memos.archived_at` を立てる）。物理削除にしなかった理由は
  スキーマに既に `archived_at` カラムが用意されているため。**アーカイブ済みの
  メモへの GET / PATCH / 再 DELETE はすべて 404** にした（一覧からも除外する）。
  「アーカイブ済みかどうか」を区別して見せる UI・API（復元機能等）は本 Issue の
  スコープ外
- **他ユーザーのメモ ID を指定した場合は 404 に統一**（403 は使わない）。存在の有無を
  レスポンスの違いから推測できないようにするため
- **title は200文字、content は50,000文字を上限**にした（`apps/web/src/lib/server/memos.ts`
  の `TITLE_MAX_LENGTH`/`CONTENT_MAX_LENGTH`）。仕様・DB スキーマのどこにも具体値の
  指定がないため決め打ちした値であり、#14 が同じ上限を UI 側のバリデーションに
  使う場合はこの値を参照すること
- **バリデーションロジックは `packages/core` ではなく `apps/web/src/lib/server/memos.ts`
  に置いた**。`packages/core` は #15/#16 が `nextReviewAt` 等の計算ロジックと
  あわせてプリセット値そのものの置き場所を決める Issue であり、#13 が先に
  住人を増やすと #14/#15 の設計判断を縛ってしまうため、あえて `apps/web` 側に
  留めた
- **`packages/db/src/index.ts` に `eq`/`and`/`or`/`isNull`/`desc` を re-export
  追加した**。既存の `count` の re-export と同じ理由（「依存の向きは
  `apps/* → packages/*` のみ」を保つため、`apps/web` に `drizzle-orm` を
  直接の依存として足さない）
- **`apps/web` に `vitest` + `@cloudflare/vitest-pool-workers` を導入した**
  （このリポジトリ初）。受け入れ条件が「統合テストで検証している」ことを求めており、
  実 D1（miniflare）に対するテストが必要だったため。`packages/db` の migrations を
  `readD1Migrations`/`applyD1Migrations`（setup file）で適用し、`$lib/server/memos.ts`
  の関数を直接呼ぶ形にした（`+server.ts` は認可チェック + 関数呼び出し + JSON化 だけの
  薄いアダプタにし、HTTP 経由でのテストは行っていない）
  - `@cloudflare/vitest-pool-workers` は `minimumReleaseAge`（7日）に収まる
    `0.18.8` に固定した（`^0.18.8` は npm semver のルール上パッチ更新のみを許容
    するため、より新しい 0.19.x/0.20.x へは上がらない）
  - **`apps/web/wrangler.test.jsonc` を本番の `wrangler.jsonc` とは別ファイルにした**。
    本番設定の `main` はビルド成果物（`.svelte-kit/cloudflare/_worker.js`）を
    指しており、`pnpm build` を経ないと存在しないため、テストではそもそも `main`
    を持たない（D1 バインディングのみの）最小構成にした
  - **`compatibility_date` は本番設定と独立して `2026-07-29` に固定した**。
    `@cloudflare/vitest-pool-workers@0.18.8` が内部に同梱する
    `miniflare@4.20260722.0`/`workerd` バイナリがサポートする最新の日付がこれで、
    本番設定の日付（`2026-08-03`）をそのまま使うと
    `This Worker requires compatibility date ... but the newest date supported
by this server binary is ...` で起動に失敗することを実測した
  - `apps/web/test/env.d.ts` で `TEST_MIGRATIONS` を `Cloudflare.Env`（global）に
    型として追加している。**`declare global { namespace Cloudflare { ... } }` で
    包む必要がある**点に注意（ファイルが `import type` を持つ ES module である
    ため、`declare namespace` を素で書くとローカルスコープの宣言になり global の
    `Cloudflare.Env` にマージされない。最初これで `svelte-check` が
    `Property 'TEST_MIGRATIONS' does not exist` を出し、修正した）
- **検証は「コード起点 + 手動の実地確認」に限定した**（#10/#11 と同じ方針）。
  統合テスト（vitest-pool-workers、20 tests）で `$lib/server/memos.ts` の
  5操作・バリデーション・テナント分離・アーカイブ後 404・トリガーの存在を確認した上で、
  UI が存在しない（#14 未着手）ため playwright-cli ではなく `pnpm dev` +
  手動署名 Cookie（#11 と同じ手法で `user`/`session`/`interval_presets`/`memos`
  行をローカル D1 に直接 insert）で実際の HTTP 経由の動作を curl で確認した
  （認証・404・400・204 のステータスコードを含む）。検証後は insert した行を削除した。
  この手動確認で **GET `/api/memos` のクエリパラメータ未指定時に `limit` が
  既定値 20 ではなく 1 になるバグ**（`Number(null)` が `NaN` ではなく `0` を返し、
  `clamp(0, 1, 100)` が `1` に丸めていた）を発見し、修正した
  （`vitest` の統合テストは `$lib/server/memos.ts` を直接呼ぶため、`+server.ts` の
  クエリパラメータ解析はカバーしておらず、この手動確認がなければ埋没していた）
- **レビュー（4観点並列）で見つかった不備を差し戻して修正した**:
  - `updateMemo` が `getMemo` で読んだ既存値を使って毎回3カラムまとめて書き戻す
    read-modify-write だったため、異なるフィールドを狙った同時 PATCH が互いの
    変更を古い値で上書きしうるロストアップデートがあった。指定された
    フィールドだけを `SET` する形に変え、`vitest-pool-workers` で
    `Promise.all` による同時 PATCH のテストを追加した
  - クエリパラメータの `limit`/`offset` が非数値チェック（`Number.isNaN`）
    のみで、小数（`limit=2.5`）や指数表記（`1e21`）を渡すと D1 の
    `LIMIT`/`OFFSET` に渡した時点で `SQLITE_MISMATCH` により 500 になることを
    実測した。`$lib/server/pagination.ts` の `parsePaginationParam` で
    非負整数のみを正規表現で受理し、不正な値は 400 にする形に変更した
    （空文字を `undefined` ではなく `0` として通してしまう不具合も同時に解消）
  - `content-type` の完全一致比較が `application/json; charset=utf-8` を
    弾いていたため、先頭のメディアタイプのみを比較するように変更した
  - `listMemos` の並び順が `createdAt`（ミリ秒精度）のみで、同一ミリ秒の
    行が複数あるとページ間で順序が不安定になり得た。`id` を tie-breaker に
    追加した
  - レスポンスが DB の行をそのまま返しており、非アーカイブの memo にしか
    到達しないため常に `null` にしかならない `archivedAt` が漏れていた。
    `MemoResponse` として明示的に必要なフィールドだけ返すようにした
    （#15 でカラムが増えても自動でレスポンスに混入しないようにする狙いもある）
  - `locals.user`/`platform.env.DB` のチェックとエラー→HTTPマッピングが
    5つのハンドラに複製されていたため、`$lib/server/api.ts` の
    `requireAuthedDb`/`handleMemoError`/`requireJsonContentType` に共通化した
  - **`+server.ts` から HTTP ハンドラ以外の named export（`parsePaginationParam`）
    をテスト用に追加したところ、`pnpm build` が
    `Invalid export 'parsePaginationParam' in /api/memos` で失敗した**。
    SvelteKit は `+server.ts` から `GET`/`POST`/... 等の決まった名前以外の
    export を許可しない（ビルド後の静的解析で検証される）。`svelte-check`・
    `vitest`・`eslint` はいずれもこの制約を検知せず `pnpm build` でのみ
    顕在化したため、`parsePaginationParam` を `$lib/server/pagination.ts`
    に切り出した。**「型検査・lint・テストが全部通っても `pnpm build` は
    別に流す必要がある」ことを再確認した一件**
- **Codex（`codex:review`/`codex:adversarial-review`）によるレビューで、4周の
  人力ライクな並列レビューでも見つからなかった不具合が3件見つかり、対応した**:
  - **PATCH は指定フィールドの内容に関わらず、まず対象メモの存在・所有権・
    非アーカイブを確認するようにした**（`updateMemo` 冒頭で `getMemo` を呼ぶ）。
    以前はバリデーションを先に行っていたため、他人のメモやアーカイブ済みの
    メモに不正な `title`/`content`/`intervalPresetId` を送ると、本来の404では
    なく400が返っていた（`docs/design-decisions.md` が定めた「他人のメモは
    常に404」という契約に反する）。この並び順は round-1 の read-modify-write
    修正（既存値をマージに使わないための SET 限定化）とは独立した話で、
    「存在確認」と「マージ用の値読み取り」を混同していたのが原因
  - **PATCH に楽観的並行性制御を追加した**。round-1 でロストアップデート
    （read-modify-write による無条件上書き）は解消していたが、**同一
    フィールドへの同時更新**は依然として後勝ちで無条件に上書きされ、
    `updatedAt` を返しているのにクライアント側の再送・古いタブからの
    autosave 等でユーザーの入力が黙って消える余地が残っていた
    （adversarial-review で指摘）。`PATCH` のリクエストボディに
    `expectedUpdatedAt`（クライアントが最後に読んだ `updatedAt` の ISO
    文字列）を**必須**にし、`UPDATE ... WHERE ... AND updated_at = ?` の
    条件に含めるようにした。0行しか更新されなかった場合、対象がそもそも
    存在しない（同時アーカイブ等）のか、バージョンが古い（同時更新）のかを
    再クエリで区別し、後者は 409 を返す。**これは破壊的な API 変更**
    （PATCH に `expectedUpdatedAt` が無いと 400 になる）だが、#14 がまだ
    実装されておらずこの契約に依存するコードが存在しないため、このタイミングで
    導入した
  - **POST に冪等性キーを追加した**。以前はサーバーが毎回 `crypto.randomUUID()`
    で id を採番していたため、insert 成功後にレスポンスが失われてクライアントが
    リトライすると、区別のつかない内容のメモが重複して作られる余地があった
    （adversarial-review で指摘）。`CreateMemoInput.id` を任意のクライアント
    生成 id として受け付け、同じ id で再送された場合は新規作成せず既存の行を
    そのまま返す。id が明示されていれば `$defaultFn`（`crypto.randomUUID()`）
    は使われない（`docs/schema.md` の ID 生成の節どおり）。実装は
    「事前に SELECT で存在確認」＋「INSERT が UNIQUE 制約違反で落ちた場合も
    再度 SELECT して返す」の二段構え（前者だけだと SELECT と INSERT の間の
    競合を取りこぼす）。他ユーザーが既に同じ id を使っていた場合は
    `ValidationError`（400）にする
  - **見送った指摘**: 「メモ作成が通常デプロイの DB では使用不能（システム
    標準プリセットが未 seed）」という adversarial-review の指摘は、#12 が
    「標準プリセットの seed は #15 の責務」と明示的に決定済みであり、これを
    #13 で先取りすると値の出所を一箇所（#15）に保つという既存方針と衝突する
    ため、ユーザー判断で対応しないことにした。#13 の統合テストが
    `beforeEach` でプリセットを直接 insert しているのは、この既知の
    依存関係（#15 が先に必要）を前提にした正当なテスト分離であり、#13 の
    バグではない。#14（UI）・本番投入までに #15 が完了している必要がある
    - **追記（#14）**: 上記の「#13 で先取りしない」という判断そのものは変えていないが、
      #14 の実装時点で UI が動作確認すらできない状態は許容できないと判断し、
      複数プリセットの管理・計算ロジックには一切踏み込まない形で「システム標準
      プリセット1件だけを固定 id で seed する」という最小限の対応に変更した
      （ユーザー承認済み）。値の出所を一箇所に保つという方針とは、#15 が
      同じ「標準」プリセットの値をこの Issue本文で既に確定させているため、
      #14 はそれをコピーするのではなく先取りして固定しただけ、という位置づけ。
      詳細は下の #14 節を参照

## メモの CRUD UI と Markdown レンダリング (#14)

- **`/api/memos` の JSON API は使わず、`+page.server.ts` の load/form actions から
  `$lib/server/memos.ts` を直接呼ぶ**。#13 が「UI が form actions 前提の設計を
  まだ決めていない」として明示的に #14 に委ねていた決定。form actions は
  progressive enhancement（JS 無効でも動く）と相性がよく、`requireAuthedDb` を
  そのまま流用できて認可チェックの実装が重複しないため採用した。既存の
  `/api/memos`・`/api/memos/[id]` はそのまま残し、将来の別クライアント
  （モバイルアプリ等）向けに温存する
  - `/app/+layout.server.ts` はページの `load` だけを保護し、form actions は
    別経路で呼ばれる（#11 の既存の注意点と同じ理由）ため、追加した全 load/action
    で `requireAuthedDb` を個別に呼んでいる
- **メモ作成 API が必須とする `intervalPresetId` を、暫定シードで解決した**。
  複数プリセットの管理・計算ロジックは #15 のスコープで未着手だが、#15 の
  Issue 本文が既に定義済みの「標準」プリセット（`[1h,1d,3d,7d,14d,30d]` =
  `[1,24,72,168,336,720]` 時間）を、固定 id `system-standard`・`user_id: NULL`
  の1行として migration `0006_seed_system_interval_preset.sql` で先行投入した。
  UI 側はプリセット選択を見せず、`$lib/server/interval-presets.ts` の
  `DEFAULT_INTERVAL_PRESET_ID` を既定値として送信する。#15/#16 が着地したら
  ユーザーによるプリセット選択 UI に置き換える前提の暫定措置。GitHub Issue 上には
  この承認の記録はない（`gh issue view 14 --json comments` は空）が、実装着手前に
  この PR の作業セッション内でユーザー本人にオプション提示（暫定シード/未実装のまま
  進める/プリセットCRUDまで作り込む、の3択）の上で選択してもらった判断であり、
  GitHub コメントとしては残していない
- **Markdown レンダラは `markdown-it`（`html: false`）を採用し、DOMPurify 等の
  サニタイザは使わない**。このアプリは Cloudflare Workers（`nodejs_compat` 有効）
  で動くため DOM を持たず、DOMPurify や `isomorphic-dompurify`（内部で jsdom を
  使う）は実行環境と相性が悪い。`markdown-it` は純粋な文字列処理のみで DOM に
  依存せず、`html: false`（既定値）により本文中の生 HTML タグは常にエスケープ
  されるため、「生 HTML を許可しないレンダラ設定にする」という Issue の要件を
  設定だけで構造的に満たす。`<script>` を含む本文を保存しても実行されないことは
  `apps/web/src/lib/server/markdown.test.ts` で確認した
  - `breaks: true` にした。design mock 自身が想定する「思いついたことを雑に、
    AI の出力を貼るだけでもいい」という書き方では、CommonMark 既定の
    「単一の改行は無視される」挙動がユーザーの体感に反するため
  - `linkify: false`（既定値のまま）。オートリンクは Issue のスコープ外
- **メモ作成時に冪等性キー（`memos.id`）を `new/+page.server.ts` の `load`
  （サーバー側）で `crypto.randomUUID()` により生成し、hidden field 経由でフォームに
  埋め込む**。#13 の `createMemo` が既にこの key による重複作成防止をサポートしており、
  UI 側で使わなければ機能が死んだままになる。二重送信（ネットワーク再送・多重
  クリック）で同じ内容のメモが重複作成される事故を無料で防げる
  - **ただし `createMemo` の冪等性チェックは同じ id の再送を「内容を比較せず」
    既存 memo をそのまま返す仕様**（#13）。ブラウザの戻る/進むによる bfcache 復元で
    このページに戻ると、直前の送信と同じ draftId・入力途中の値が復元されるため、
    ここで新しい内容に書き換えて送信すると `createMemo` は古い内容の memo を
    返してしまい、ユーザーの新しい入力が黙って破棄される（curl で同一 id を
    2回 POST し、2件目の内容が保存されないことを実際に確認した）。
    `/app/memos/new` の `load` に `event.setHeaders({'cache-control':'no-store'})`
    を追加してこのページを bfcache の対象外にしたが、**これはヒントに過ぎず、
    全ブラウザでの bfcache 除外を保証するものではない**（未検証。特に Safari は
    `no-store` でも bfcache を維持する場合があると知られており、このアプリの
    主要ターゲットである iOS Safari で無効化される保証はない）。そのため
    `no-store` だけに依存せず、`new/+page.server.ts` の action 側で
    `createMemo` の戻り値（`memo.title`/`memo.content`）を今回の送信内容と比較し、
    一致しなければ（＝古い draftId が使い回され、内容が黙って破棄されようと
    している）409 を返す形にした。
    - **これは `/app/memos/new` という単一の呼び出し元でのみ閉じた対処であり、
      `createMemo`（`$lib/server/memos.ts`, #13）自体の契約や、それを直接呼ぶ
      `/api/memos` POST（#13, 本 PR では無変更）の挙動は変えていない**（設計
      レビューで「根本原因を閉じている」という記述が誤りだと指摘され訂正した）。
      `/api/memos` に同じ id を異なる内容で2回 POST すれば、201 で古い内容が
      返る余地は今も残っている。ただしこれは #13 で既に存在していた仕様であり
      #14 が持ち込んだ回帰ではない。bfcache によるサイレントな二重送信は
      ブラウザの通常のフォーム送信（本 PR が新設した `/app/memos/new`）でしか
      発生しないため、UI 側の対処で十分と判断した。`createMemo` 自体に
      内容比較を持たせる、あるいは `ValidationError` に判別用の `code` を
      持たせるといった、より根本的な改修は #13 のスコープに踏み込むため
      本 Issue では行わない
- **編集フォームは `expectedUpdatedAt`（最後に読んだ `updatedAt` の ISO 文字列）
  を hidden field で保持し、`updateMemo` の楽観的並行性制御にそのまま渡す**。
  競合（409）時はエラーメッセージを表示し、フォームの入力内容は保持したまま
  再送を促す
  - **`fail(409, …)` のレスポンスに `expectedUpdatedAt` を（`data.memo.updatedAt` では
    なく）今回の送信で使った古い値のまま含めて返す**（設計レビューで発見・修正）。
    SvelteKit の form action は `fail()` を返す際もページの `load` を再実行するため、
    hidden field を素朴に `data.memo.updatedAt` から描画すると、409 で再描画された
    フォームの `expectedUpdatedAt` が競合相手の書き込みによる**最新の** `updatedAt`
    に自動的に更新されてしまう。ユーザーがエラーメッセージに気付かず「保存」を
    もう一度押すと、その時点では最新の `updatedAt` と一致するため何の警告もなく
    通過し、フォームに残っていた古い入力内容で競合相手の変更を上書きしてしまう
    ——楽観的並行性制御が本来防ぐはずのロストアップデートがそのまま発生する。
    実際に curl で連続 POST して確認した上で修正した。修正後は、409 発生時は
    常に「同じ古い `expectedUpdatedAt` で送信 → 再度 409」になるため、最新の内容を
    取得して手動でマージするには実際にページを再読み込みする（＝ `form` が
    リセットされ、`data.memo` から真に最新の値を描画し直す）以外の経路がない
- **削除は確認なしの `<form method="POST" action="?/delete">` + クライアント側の
  `confirm()` のみ**。design mock のアカウント削除のような専用モーダルは、
  メモ削除（`archived_at` を立てる論理削除で取り消し不能ではない）には過大と判断し、
  「素の CSS で最低限整える」という技術スタックの方針に沿って作らなかった
- **一覧のページネーションは `offset` クエリパラメータのみで実装し、`limit` は
  20 固定**。タグ・全文検索は #28 のスコープ外のため、design mock にある検索欄・
  タグフィルタは実装していない
- **SvelteKit 2.26 で追加された `resolve()`（`$app/paths`）を全ての内部 `<a href>`
  に使った**。`eslint-plugin-svelte` の `svelte/no-navigation-without-resolve`
  ルールが有効になっており、リテラルの `href` 文字列では lint が落ちる。
  このリポジトリで内部リンクを持つページを追加したのは #14 が初めてで、これまで
  このルールに触れていなかった
- **`{@html}` の ESLint 警告（`svelte/no-at-html-tags`）は詳細画面の該当行に
  ピンポイントで `eslint-disable-next-line` した**。理由は `renderMarkdown()` の
  `html: false` 設定により生 HTML が構造的に混入し得ないため（上記の Markdown
  レンダラの節を参照）。ルール自体を無効化すると、将来 `{@html}` を無検証の値に
  対して使うコードが追加されても検知できなくなるため、行単位に留めた
- **作成・編集フォームの `maxlength` は `TITLE_MAX_LENGTH`/`CONTENT_MAX_LENGTH`
  （`$lib/server/memos.ts`）の値をリテラルで複製せず、`+page.server.ts` の `load`
  から `data.titleMaxLength`/`data.contentMaxLength` として渡す形にした**（設計
  レビューで指摘）。`.svelte` は `$lib/server/*` を直接 import できないため、
  load 経由で値を渡す以外に重複を避ける手段がない
- **`packages/db/migrations/0006_seed_system_interval_preset.sql` が投入する
  `interval_presets` 行の削除・置き換え手順は本 Issue では設計していない**
  （設計レビューで指摘）。`memos.interval_preset_id` の FK には `onDelete` が
  指定されていない（既定 `NO ACTION`）ため、この行を本番投入後にメモが作られた
  状態で削除しようとすると、参照している memo 側の `interval_preset_id` を
  先に付け替えるデータ移行が必要になる。#15/#16 でプリセット管理を実装する際に
  対応すること
- **`+page.server.ts` の load/actions に対する自動テストは追加していない**。
  このリポジトリは `$lib/server/*.ts` のロジックを vitest-pool-workers で、
  ルート層の実際の挙動を playwright-cli / 手動確認で検証する、という役割分担
  （#10/#11/#13 で確立済み）を踏襲した。今回の実装が薄いラッパーに留まらず
  実質的なロジック（フォームパース・エラー→fail 変換・冪等性キー・楽観的
  並行性制御）を持つことは認識しており、レビューで発見された不具合
  （上記の409再送問題、bfcache二重送信問題）はいずれも curl による直接リクエストで
  再現・修正確認した。自動テストとしては固定化していない
- **一覧・詳細ページの `load` は、テンプレートが表示に使わない `content`（Markdown
  原文、最大 50,000 文字）をクライアントへ返さない**（設計レビューで指摘）。一覧は
  `excerpt()`（先頭 80 文字程度への切り詰め）をテンプレート側ではなく `load` 側で
  行い `excerpt` フィールドだけを返す。詳細ページは `renderMarkdown()` 済みの
  `renderedContent` しか表示に使わないため、`memo` は `id`/`title` だけに絞って返す。
  20 件 × 最大 50,000 文字を毎回まるごとハイドレーションペイロードに乗せていた
  無駄を解消した
- **`$lib/server/memos.ts`（#13）の `ValidationError` が投げる英語のメッセージ
  （`title is required` 等）や、内部フィールド名を含むメッセージ
  （`intervalPresetId does not reference an accessible preset`）を、そのまま
  `fail()` 経由でユーザーに見せていた**（要件レビューで指摘）。UI 全体が日本語で
  統一されているのに対する不整合であり、後者はプリセット選択 UI 自体を持たない
  この画面にとって技術的すぎる内部詳細の漏洩でもある。
  `apps/web/src/lib/server/form-messages.ts` に `translateMemoValidationMessage()`
  を追加し、既知のメッセージ（タイトル必須・タイトル/本文の文字数上限）だけを
  日本語に翻訳し、それ以外（`intervalPresetId` 関連や将来追加されるメッセージ）は
  内容を漏らさない汎用メッセージにフォールバックする。フォーム解析失敗時の
  メッセージも `INVALID_FORM_SUBMISSION_MESSAGE` という定数にして同じファイルに
  集約し、`new`/`edit` 双方の `+page.server.ts` で複製しないようにした
  （設計レビューで「新設した集約先を使わず3箇所に直書きされている」と指摘され修正）。
  この対応表は `memos.ts` 側のメッセージ文字列と正規表現で結合している脆い設計
  であるため、当初 `apps/web/src/lib/server/form-messages.test.ts` に
  `TITLE_MAX_LENGTH`/`CONTENT_MAX_LENGTH` を使ってテスト側で文字列を組み立てて
  検証するテストを追加した（要件レビューで「他の `$lib/server/*.ts` にはテストが
  あるのにこのファイルにはない」と指摘され追加）。
  - **しかしこのテストには実効性が無いことが後続のレビュー（正確性・要件の
    2エージェントが独立に、`memos.ts` の実際のメッセージ文言を書き換えて
    テストを再実行するという同じ方法で）指摘された**。テストが
    `translateMemoValidationMessage()` に渡す入力は `memos.ts` の文言を
    テスト側で手打ちで再現した文字列であり、`assertTitle`/`assertContent` を
    実際に呼んで例外メッセージを取得していなかったため、`memos.ts` 側の文言が
    変わってもテストの入力は変化せず、常に green のまま通り続けていた
    （実際に `assertTitle` のメッセージを書き換えて再実行し、この不備を
    自分でも再現確認した上で修正した）。修正後は `cloudflare:test` の `env.DB`
    を使い、`createMemo` を実際に呼んで発生した本物の `ValidationError.message`
    を `translateMemoValidationMessage()` に通す形に書き直した。この修正が
    実際に機能することも、`assertTitle` のメッセージを一時的に書き換えて
    テストが red になることを確認してから元に戻す、という同じ手法で検証した
  - **`ValidationError` に判別用の `code`（例: `'title_required'`）を持たせて
    文字列マッチを排除する、という、より頑健な代替案は採らなかった**（設計
    レビューで提案されたが見送った）。`ValidationError` のクラス定義・全ての
    throw 箇所は `$lib/server/memos.ts`（#13、既にクローズ済みで #14 は無変更の
    ままにする方針）にあり、そこへ手を入れるのは #13 のスコープに踏み込む
    ことになるため
  - **`intervalPresetId does not reference an accessible preset`
    （システム標準プリセットの行が欠落した場合のみ発生しうる）を、ユーザー起因の
    400 ではなくシステム障害として 500 系で扱う、という案も見送った**（設計・
    要件レビューで指摘）。現状のコードベースには `interval_presets` 行を削除する
    経路が一切存在しない（#15/#16 未着手）ため、本 Issue の時点ではこの分岐は
    到達不能であり、到達しない異常系のために特別なハンドリングを持たせるのは
    過剰と判断した。#15/#16 でプリセットの削除・置き換えが可能になったら、
    この分岐の扱いを再検討すること
- **タイトル入力に `required` 属性を追加した**（要件レビューで指摘）。`maxlength`
  はあったが空タイトルを弾く仕組みがなく、`assertTitle` の「空文字列は
  `ValidationError`」という既存の制約（#13）にブラウザの標準バリデーションで
  先回りできていなかった
- **編集フォームの hidden field `expectedUpdatedAt` が欠落した改ざんリクエストの
  場合、`fail()` に `''`（空文字列）ではなく `undefined` を返すよう修正した**
  （要件レビューで指摘）。`+page.svelte` 側は `form?.expectedUpdatedAt ?? data.memo.updatedAt...`
  という `??` によるフォールバックを使っており、`''` は falsy だが nullish ではないため
  フォールバックされず、hidden field が空のまま再送され続けて `new Date('')` が
  invalid になり、手動リロードでしか抜けられなくなっていた。通常の操作では
  到達しない経路（フォームを直接改ざんした場合のみ）だが、安価に直せるため修正した
- **`/app/memos/new` の `load` でも `requireAuthedDb(event)` を呼ぶようにした**
  （設計レビューで指摘）。この `load` は DB もユーザー固有データも読まないため
  実害はなかったが、「追加した全 load/action で個別に認可チェックする」という
  このファイル内の既存の記述（#11 節を参照）と実装が食い違っていた。将来この
  `load` がユーザー固有の値を返すよう変更された際に、認可チェックを追加し忘れる
  リスクをなくすため、無害なうちに揃えた
- **編集ページの `load` も、一覧・詳細ページと同じ projection の方針に揃えた**
  （設計レビューで指摘）。`getMemo` の戻り値（`id`/`userId`/`title`/`content`/
  `intervalPresetId`/`createdAt`/`updatedAt`）をそのまま返していたが、
  テンプレートが使うのは `id`/`title`/`content`/`updatedAt` だけなので、
  未使用の `userId`/`intervalPresetId`/`createdAt` を落とした
- **`/app/memos/new` の 409 メッセージを「ページを再読み込みしてから」ではなく
  「もう一度『保存』を押してください」に修正した**（設計レビューで指摘・実機で
  再現確認）。SvelteKit の form action は `fail()` を返す際もこのページの
  `load` を再実行するため、409 の時点で hidden field の `id` は
  `crypto.randomUUID()` により既に新しい draftId へ更新されている。そのため
  実際にはページを手動でリロードしなくても、「保存」をもう一度押すだけで
  新しい id により正しい内容のメモが作られる（curl で実際に、409後に
  埋め込まれる hidden id が新しい値になっており、その値のまま再送すると
  成功することを確認した）。「再読み込みが必要」という誤った操作を要求する
  メッセージになっていたのを修正した。この `id` の扱いは、編集ページの
  `expectedUpdatedAt`（送信時の値を固定し、load 再実行に追従させない）とは
  意図的に逆方向の対処であり、`[id]/edit/+page.server.ts` の該当コメントに
  「揃えないこと」を明記した
- **一覧の `excerptOf()` を `String#slice`（UTF-16 コード単位）ではなく
  `Array.from()`（コードポイント単位）で切り詰めるよう修正した**（正確性
  レビューで2名のレビューアが独立に指摘）。80文字目付近に絵文字等のサロゲート
  ペア文字があると、ペアが分断されて文字化けした表示になり得た
- **一覧の空状態メッセージを、`data.total === 0`（メモが1件もない）と
  `data.items.length === 0` かつ `data.total > 0`（他タブでの削除や `offset`
  の手動書き換えで、今のページには表示するものがないだけ）とで出し分けるように
  した**（要件レビューで指摘）。後者でも「まだメモがありません」と表示すると、
  実際にはメモが存在するのに誤解を招く
- **`excerptOf()` を `apps/web/src/routes/app/memos/+page.server.ts` 内の非公開
  関数から `apps/web/src/lib/server/excerpt.ts` に切り出し、
  `excerpt.test.ts`（サロゲートペア境界のケースを含む）を追加した**（要件
  レビューで指摘）。ルート層（`+page.server.ts`）のロジックはこのリポジトリの
  規約でテスト対象外だが、このロジックは一度サロゲートペア分断のバグを
  実際に埋め込んだ実績があり、`markdown.ts`/`form-messages.ts` と同じ
  「実質的なロジックを持つ `$lib/server/*.ts` にはテストを書く」規約の対象に
  すべきと判断し、非公開のまま留めず切り出した
- **フォーム送信された `content` を、DB へ渡す前に CRLF を LF へ正規化する
  （`apps/web/src/lib/server/text.ts` の `normalizeLineEndings()`）**（要件
  レビューで指摘）。ブラウザは `&lt;textarea&gt;` の送信時に改行を CRLF へ正規化する
  仕様があるが、クライアント側の `maxlength` はライブの DOM 値（LF）で文字数を
  数える。改行を多く含む本文をブラウザ上でちょうど `CONTENT_MAX_LENGTH` まで
  入力できても、送信後は CRLF 化された分だけ文字数が増え、サーバー側の
  `assertContent` に弾かれて本人の認識と食い違うエラーになり得た。また
  `/api/memos`（JSON、CRLF化されない）経由の保存と改行コードが不揃いになる
  問題も併せて解消した
- **編集フォームで `NotFoundError`（他タブでの同時アーカイブ等）が発生した場合、
  入力中のタイトル・本文を保持せず、通常の `error(404, …)` に委ねる挙動は
  意図的に変えなかった**（要件レビューで、`ValidationError`/`ConflictError`
  との「入力保持の一貫性のなさ」として指摘されたが見送った）。`ValidationError`/
  `ConflictError` は「対象は存在するが入力かタイミングを直せば成功しうる」
  失敗であり、入力を保持して再入力の手間を省く価値がある。一方
  `NotFoundError` は「対象そのものが既に無い」失敗であり、そこへは何を
  再送しても成功しない。この違いにより、404 は下記の `+error.svelte` で
  日本語のメッセージと一覧への導線を出すに留め、入力保持の対称性はあえて
  揃えなかった
- **`&lt;textarea&gt;{content}&lt;/textarea&gt;` という記法により、本文が改行で
  始まる場合に HTML 仕様上その改行が失われるのではないか、という懸念が
  4周目のレビューでも改めて提起された**。これは1周目のレビューで advisor から
  指摘され、実際に先頭が改行のメモを作成しローカルの Chromium
  （playwright-cli）で編集画面を開いて `textarea.value` を直接取得する形で
  実測済みであり、先頭の改行は失われないことを確認している（詳細は本ファイルの
  1周目の検証記録、および実装時のセッションログを参照）。4周目のレビューは
  この検証を再実行しておらず理論上の懸念に留まるものだったため、既存の実測結果を
  優先し、追加の対応はしていない
- **`/app/+error.svelte` を新設し、`error(401/404/409/500, …)`（#10/#13 由来、
  `requireAuthedDb`/`handleMemoError`）が投げるエラーを日本語で表示するようにした**
  （設計レビューで指摘）。これらは元々 `/api/*`（JSON API）と `/debug/*`（開発者
  専用ページ）でしか使われておらず、SvelteKit 既定の英語・無装飾エラーページで
  問題にならなかったが、#14 で `/app/memos/*` という実際のユーザー向け HTML
  ページから初めて到達可能になった。別タブでの削除後に詳細・編集を開く（404）、
  編集中のセッション切れ（401）などは実際に踏みやすい経路であり、「ページ全体を
  日本語で統一する」という本節自身の方針（`translateMemoValidationMessage` 導入の
  動機と同じ）と矛盾しないよう、404/401/409 は個別のメッセージと導線（ログイン
  画面 / 一覧画面へのリンク）を、それ以外は汎用メッセージを表示する
- **`docs/design-decisions.md` に記載した「ユーザー承認済み」は GitHub Issue 上の
  記録ではない**（スコープ外レビューで、`gh issue view 14 --json comments` が
  空であることを指摘され、経緯を明記した）。この PR の作業セッション内で
  ユーザー本人に選択肢（暫定シード/未実装のまま進める/プリセットCRUDまで
  作り込む）を提示し、その場で選んでもらった判断であり、GitHub コメントとしては
  残していない

### PR 作成後の Codex レビュー（通常 / adversarial）

PR #46 作成後、Codex の通常レビューと adversarial レビュー（`/codex:review`,
`/codex:adversarial-review`）を並行実行し、指摘 2 件をそれぞれ PR
（https://github.com/tom-chiba/ebb/pull/46）の該当行にコメントした上で対応した。

- **修正した: 編集フォームの 409 競合時、メッセージ通りに「ページを再読み込み」
  してもループから抜けられない**（adversarial レビュー、`medium`）。編集フォームは
  `use:enhance` を使っておらず、409 は通常の POST への SSR レスポンス表示になる。
  ブラウザの「再読み込み」はこの POST ページへの再送信となり、多くのブラウザで
  「フォームを再送信しますか」の確認ダイアログを経由する。承認すると、意図的に
  保持している古い `expectedUpdatedAt` がそのまま再送され、また 409 になるだけで
  終わらない。対応として `fail(409, …)` に `conflict: true` を追加し、
  `apps/web/src/routes/app/memos/[id]/edit/+page.svelte` に同じ編集ページへの
  `<a>` リンク（GET によるページ遷移、再送信ダイアログを経由せず `load` が
  再実行され最新の内容を取得できる）を追加した。メッセージも「再読み込み」から
  「下のリンクから確認」に変更した
- **見送った（既知の制限として明記に留めた）: bfcache から `/app/memos/new` が
  復元され、直前に作成したのと内容が完全一致するメモをもう一度作ろうとした場合、
  新規メモは作成されず古いメモへリダイレクトされてしまう**（通常レビュー、
  `P2`）。`createMemo` の冪等性キーは `memos.id` そのものであり、「同じ id への
  意図しない再送」と「id は同じだが利用者が意図した別の新規作成」を区別する
  情報を持たない。区別するには memo の識別子とは独立な「送信試行 ID」を新設する
  必要があり、#13 のスコープに踏み込む設計変更になる。発生条件も「no-store
  にもかかわらず bfcache が有効なブラウザ」かつ「直前と一字一句同じ内容を
  再送する」の両方を満たす必要があり、影響も「重複作成が1回スキップされる」に
  留まりデータは失われない。大きな設計変更なしに直せる不具合ではないため、
  コードは変更せずここに記録するに留めた

## 復習間隔プリセットと計算ロジック (#15)

- **`nextReviewAt(baseTime, intervals, step)` は全ステップ完了後（`step` が範囲外）に
  `undefined` を返す**（`noUncheckedIndexedAccess` により `intervals[step]` の型が
  `number | undefined` になることが、この API の形を規定するという上記の申し送り
  （TypeScript は 6.0 系に固定の節）に対する回答）。例外を投げる案と比較した結果、
  `undefined` を採用した。**根拠は SM-2/FSRS 的な「一般的な設計」ではなく、
  `reviews` が「メモ作成時に全ステップ分をまとめてバッチ生成する」方針
  （`docs/schema.md` の reviews 節）で確定していること**: 最終間隔を無限に繰り返す
  設計は、有限個の行を一括生成するこの方針と構造的に噛み合わない。「全ステップ完了
  したメモは復習を終える（完了扱いにする）」という決定は、この API の戻り値の形で
  表現される
  - `undefined` は「全ステップ完了（正常系）」「`intervals` が空配列（設定不備）」
    「`step` が負数・非整数（呼び出し側のバグ）」の3つの状態を区別せず返す。
    `intervals` 自体の内容（最小単位・順序）のバリデーションは #18 の責務と既に
    決まっているため、`packages/core` 側では区別・検証を行わない。**#16（メモ作成時の
    reviews 生成）は、ループの前に `intervals.length` が 0 でないことを確認すること**。
    確認しないと、空の（あるいは今後の実装ミスで空になった）プリセットを持つメモが
    `reviews` を1件も持たないまま「静かに全ステップ完了状態」に見えてしまう
- **`intervals` は時間単位の配列であり、「日」「月」といったカレンダー単位の概念を
  持たない**。30日相当の間隔は `720`（時間）として表現され、`nextReviewAt` は
  常に `baseTime.getTime() + hours * 3600000` の絶対時刻加算のみで計算する。これにより
  タイムゾーン・夏時間・カレンダー月の境界（例: 1/31 の30日後）はすべて実装上
  区別する必要がなくなる（テストで実測）。Issue 本文が挙げていた「1/31 の1ヶ月後」
  という検証観点は、この設計の下では「カレンダー上の3月末」ではなく「1/31 + 720時間
  （実測上 3/2）」に読み替えて検証した。「最小単位 1時間」という仕様（`docs/design-decisions.md`
  の仕様節）を採用した時点で、この読み替えは必然の帰結である
- **将来 SM-2 / FSRS を差し込むための `SchedulingStrategy` インターフェースは、
  現在の `nextReviewAt` と同じシグネチャ（`(baseTime, intervals, step) => Date | undefined`）
  のみを持つ最小のものにした**。SM-2/FSRS は自己評価等の追加入力・メモごとの状態を
  必要とするため、このインターフェースのままでは実装を差し込めない可能性が高いが、
  #29 の Issue 本文が「そうなっていなければ、まずリファクタリングする」と既に
  明記して #29 側にその判断を委ねている。`ReviewContext` のような、今は使われない
  抽象を先取りして持たせることはしなかった
- **`packages/db/migrations/0007_seed_remaining_system_interval_presets.sql` で
  「短期集中」（`system-short`）「長期」（`system-long`）の2プリセットを追加投入した**。
  `docs/schema.md` の interval_presets 節が「実際の3プリセットの値と、固定 slug の
  `id` での INSERT は #15 に委ねる」と明記していたための対応。「標準」
  （`system-standard`）は #14 が migration `0006` で暫定的に先行投入済みであり、
  値は `packages/core` の `SYSTEM_INTERVAL_PRESETS` と完全に一致するため、
  再投入・変更は行わなかった（`DEFAULT_INTERVAL_PRESET_ID` や既存メモの FK が
  この行を参照しているため、id・値を変えると既存データと食い違う）
- **`packages/core`/`packages/db` 間、あるいは `apps/web` を経由したプリセット値の
  drift を検知する自動テストは追加しなかった**。`packages/core` は無依存の方針
  （モノレポの土台 #1 の節）のため `packages/core` から `packages/db` を import して
  drift 検知することはできない。逆方向（`packages/db` が `packages/core` を import
  して drift 検知に使う）も、パッケージ間の依存の向きは `apps/* → packages/*` のみ
  （#5/#20 節）という既存方針に反するため採らない。`apps/web` 経由で検証すること
  自体は依存方向としては可能だが、#15 のスコープを `packages/core`（と、schema.md が
  明示的に委ねた seed migration）に絞るため見送った。migration のコメントで
  `packages/core` を値の出所として明記するに留めている（既存の `0006` と同じ方式）

## メモ作成時の reviews 生成とアーカイブ時の削除 (#16)

- **`createMemo` は `memos` への INSERT と `reviews` の全ステップ分バッチ生成を
  `db.batch()` で1つの暗黙トランザクションとして実行する**。D1 の batch API は
  途中の1文が失敗すると全体がロールバックされるため、メモは作られたが reviews が
  1件も無い（あるいはその逆）という中途半端な状態が生じない
  - `id`・`createdAt`/`updatedAt` は呼び出し側（JS）で確定させてから両方の
    INSERT に渡す。DB 側のデフォルト値（`unixepoch('subsecond')`）に生成を
    任せると、`memos.createdAt` と `reviews.scheduledAt` の計算起点が別クロックに
    なり得るため、`nextReviewAt` の `baseTime` と `memos.createdAt` を同一の
    `Date` インスタンスに揃えた
  - **`intervals` が空配列の場合は `createMemo` が `ValidationError` を投げて拒否する**
    （当初は `reviews` の INSERT をスキップし0件生成を正当な結果として許容していたが、
    Codex の通常レビュー・adversarial レビュー双方から指摘され修正した）。#15 の
    設計判断（本ドキュメントの「復習間隔プリセットと計算ロジック」節）が
    「#16 はループの前に `intervals.length` が 0 でないことを確認すること。確認しないと、
    空のプリセットを持つメモが reviews を1件も持たないまま『静かに全ステップ完了状態』に
    見えてしまう」と明記しており、0件生成を許容する当初の実装はこの申し送りに反していた。
    `intervals` 自体の内容（最小単位・順序等）のバリデーションは引き続き #18 の責務だが、
    メモ作成時点で空配列を検出した場合の拒否は #16 の責務とした
- **`createMemo` の冪等性チェック（`findOwnMemoById`）が既存メモを見つけた場合、
  `ensureReviewsExist` でそのメモの reviews の有無を確認し、無ければその場で生成する**
  （Codex adversarial レビューで指摘）。#16 のデプロイ前（reviews 生成ロジックが
  存在しなかった時点）に作られたメモが、同じクライアント生成 id で再送された場合に
  reviews を持たないまま返されてしまう問題への対応。`memo.createdAt`（実際に持続化
  された値）を `baseTime` として使うため、通常の生成経路と同じ日時になる
  - **これは「同じ id で再送された場合」のみを治癒する、狙いを絞った対応であり、
    #16 のデプロイ前に作られ、その後一度も同じ id で再送されていないメモまでは
    救わない**。より広範なバックフィル（既存の全 non-archived メモを対象にした
    一括生成）が必要かはユーザーに確認し、**本番 D1 にはこの PR 以前に作成された
    実データがまだ存在しないことを確認した**（このプロジェクトは開発初期段階で、
    本 PR 時点では #10〜#16 が同日にマージされている）ため、一括バックフィル
    migration は追加しなかった。将来、本番に実データが存在する状態でこの種の
    変更を行う場合は、改めてバックフィルの要否を検討すること
  - 同時に複数のリトライが治癒を試みた場合に備え、`reviews_memoId_step_unique`
    の違反は無視する（望む終状態は既に満たされているため）
- **`isUniqueConstraintViolation` は違反したインデックス/カラム名（例:
  `memos.id`）を明示的に指定して判定するよう変更した**。バッチに `memos` と
  `reviews` 両方への INSERT が含まれるようになったため、単に
  `"UNIQUE constraint failed"` の有無だけで判定すると、`reviews_memoId_step_unique`
  の違反（本来起こり得ないはずだが）を「id が既に使われている」という
  冪等性リトライのケースと取り違えかねない
- **`archiveMemo` はメモの `archivedAt` 更新と、そのメモの未完了
  （`completedAt IS NULL`）`reviews` の削除を同じ `db.batch()` で行う**。
  `docs/schema.md` の reviews 節が #21 への申し送りとして残していた
  「アーカイブ済みメモの reviews を JOIN で除外するか、アーカイブ時に削除/無効化
  するか」というエッジケースは、この Issue の受け入れ条件（「メモを削除すると
  予定も消える」）に応えるため**削除する側をここで採用して解消した**。#21 は
  改めてこの判断を検討する必要はない
  - **完了済み（`completedAt` が設定済み）の行は削除しない**。`docs/schema.md` は
    完了済み `reviews` を履歴として残す方針を既に明記しており、#18 の再計算
    レシピ（「完了済みステップ数を起点に新しい `intervals` から残りステップを
    再生成する」）も完了済み行が残っていることを前提にしている。アーカイブ時に
    完了済み行まで削除すると #18 のレシピが壊れる
- **`updateMemo` で `intervalPresetId` を変更しても reviews は再生成しない**。
  再計算のレシピ（未完了行を削除して残りステップを新しい `intervals` から
  作り直す）は `docs/schema.md` が明示的に #18 に割り当てているため、#16 の
  スコープには含めない
- **`getAccessiblePreset`**（旧 `assertPresetAccessible`）は intervals も返すように
  変更した。`createMemo` がアクセス可否チェックと reviews 生成に使う `intervals`
  取得を1回のクエリにまとめるためで、`updateMemo`（アクセス可否チェックのみ必要）は
  戻り値を無視して呼ぶだけにした
- **`createMemo` の戻り値は、INSERT に渡した値を手元で再構築するのではなく、
  `db.batch()` の `memos` への INSERT に `.returning()` を付け、その結果を
  `toMemoResponse()` に通して作る**（レビューで指摘され修正）。当初は `insertMemo`
  に渡した値をそのままリテラルとして返しており、`toMemoResponse`・INSERT の
  `.values()`・戻り値リテラルの3箇所にメモの形が重複していた。`archiveMemo` は
  もともと `.returning()` の結果を使っており、`createMemo` だけこのパターンから
  外れていた非対称も合わせて解消した
- **レビューで指摘され追加した検証**:
  - `createMemo` の冪等性チェック（`findOwnMemoById` による早期return）は、
    同じ id で直列に2回呼ぶテストでは `db.batch()` の一意制約違反
    （`isUniqueConstraintViolation`）を経由しない（1回目の結果が2回目の
    `findOwnMemoById` で見つかるため）。`Promise.all` で本当に競合させるテストを
    追加し、`memos.id` の一意制約違反を経由しても reviews が重複も欠損もしないこと
    を確認した
  - `updateMemo` で `intervalPresetId` を変更しても既存の `reviews` 行が
    変化しないことを確認するテストを追加した（「reviews は再生成しない」という
    上記の決定に対する回帰テスト）

## 復習一覧と「復習した」操作の UI (#17)

- **公開 API（`/api/reviews`）は追加しなかった**。#14（メモの CRUD UI）が既に、
  `/api/memos`（#13）を再利用せず `+page.server.ts` から `$lib/server/memos.ts` を
  直接呼ぶ形にした前例があり、reviews にもこの UI 専用の呼び出し方を踏襲した。
  scheduler（#21）も HTTP 経由ではなく `packages/db` 経由で直接 D1 を読む設計のため、
  現時点で `/api/reviews` を必要とする消費者が存在しない。「使われない抽象を先に
  作らない」という方針に基づく。

- **期限が来ており、かつ常に最小の未完了 step である review だけを完了・閲覧できる、
  という不変条件をこの Issue で実装として確定させた**（`docs/schema.md` の reviews 節が
  決定を #17 に委ねていた点）。
  `$lib/server/reviews.ts` の `listDueReviews` は、メモごとに「未完了行の中で
  最小の step」だけを `GROUP BY memo_id` のサブクエリで抽出し、その行に対しての
  み `scheduled_at <= now` の due 判定を適用する。due 判定をサブクエリの内側
  （`GROUP BY` に含める形）で行うと「期限が来ている行の中での最小 step」になり、
  期限前の若い step を飛ばして期限切れの後続 step を表示しうる（advisor によるレビューで
  指摘）ため、意図的に外側でフィルタする。`completeReview`/`getDueReviewDetail` も
  `scheduledAt <= now` と `assertIsCurrentStep` の両方を再検証する。一覧は常にこの条件を
  満たす行しか見せないため通常経路では到達しないが、review id を直接指定した呼び出し
  （URL 直打ちや、再アンカリング前に配信済みだった古い通知等）に対する防御として、
  完了操作・詳細取得の両方で個別に検証している。`completeReview` の UPDATE にも due 条件を
  含め、事前 SELECT の後に予定が未来へ再計算された場合の競合を防ぐ。

- **「復習した」で完了させると、完了時刻を起点に残り未完了ステップの `scheduledAt` を
  再計算する**（ユーザー承認済みの設計判断）。#16 はメモ作成時に全ステップの
  `scheduledAt` を `memos.createdAt` 起点で一括計算する方針だったため、長期間アプリを
  開かないと同じメモの複数ステップが同時に期限切れになり得る。この状態で
  再計算をしないまま完了操作を許すと、放置していた期間をそのまま引き継いで
  残り全ステップを間隔なしで一気に消化できてしまい、間隔反復として機能しなくなる
  （advisor のレビューで指摘）。そこで `completeReview` は、対象ステップを完了させると
  同時に、同じメモの残り未完了ステップ（`step > 完了させた step`）それぞれについて
  `nextReviewAt(completedAt, intervals, step)`（`intervals` はそのメモの現在の
  `intervalPresetId` が指すプリセットの値）で `scheduledAt` を再計算し、
  `notifiedAt` も `NULL` に戻す。`notifiedAt` をクリアしない場合、scheduler の
  部分インデックス（`reviews_pending_scheduledAt_idx`、条件は
  `completed_at IS NULL AND notified_at IS NULL`）が既通知の行をスキャン対象から外してしまい、
  再アンカリングで新しくなった予定に対して通知が二度と飛ばなくなる
  （#19/#21 に影響する）。
  - 完了操作と残りステップの再アンカリングは同じ `db.batch()` で実行し、
    途中で失敗した場合に「完了はしたが再アンカリングされていない」中途半端な
    状態が残らないようにしている。
  - **同じ review を2件同時に完了しようとした場合、負けた側のバッチでも残り
    ステップの再アンカリング UPDATE だけは成功してしまう問題を、再アンカリング
    UPDATE の `WHERE` に「この呼び出し自身の `completedAt` で対象 review が実際に
    完了している」ことを保証する `exists` ガードを追加して修正した**（Codex による
    最終レビューで指摘）。D1 の `batch()` は1つの暗黙トランザクションだが、
    先頭 UPDATE（`completeCurrent`、`WHERE id = ? AND completed_at IS NULL`）が
    競合により0件更新になってもエラーにはならないため、後続の再アンカリング
    UPDATE は独立に実行されてしまう。ガードなしだと、負けた側の呼び出しが
    自分自身の `completedAt`（勝者より後の時刻）を起点に残りステップを
    再アンカリングしてしまい、実際に保存された `completedAt`（勝者の値）と
    再アンカリング元の時刻が食い違う。`packages/db` から drizzle-orm の
    `exists` を re-export し、対象 ID とこの呼び出しの `completedAt` が一致する行の
    `exists` を再アンカリング UPDATE の条件に
    加えることで、負けた側ではこのガードが false になり0件更新のまま終わる。
  - `db.batch()` は静的に1件以上とわかるタプル型 (`[U, ...U[]]`) を要求するが、
    再アンカリング対象の件数は実行時にしか決まらない（0件〜プリセットのステップ数-1件）。
    完了させる1件は常に配列の先頭にあるため実行時には常に1件以上になるが、
    可変長の spread を含む配列リテラルが非空タプルであることは TypeScript の型
    システムでは静的に証明できない。`packages/db` から drizzle-orm の `BatchItem`
    型を re-export し、`[typeof completeCurrent, ...BatchItem<'sqlite'>[]]` という
    型注釈（`as unknown as [...]` のような二重アサーションではなく）で表明している
    （`$lib/server/reviews.ts` の `completeReview`。当初は `as unknown as [...]` を
    使っていたが、正確性レビューで「戻り値の形が異なるため静的に表現できない」という
    コメントの理由づけ自体が不正確だと指摘され、より安全な形に修正した）。
  - **`intervalPresetId` が reviews 生成後に `updateMemo`（#13）で変更され、
    新しいプリセットの `intervals` が既存の未完了ステップ数より短くなっている場合、
    再アンカリングできないステップの `scheduledAt` は元の値のまま残し、対象ステップの
    完了自体は失敗させない**（正確性レビューで指摘され修正）。当初は
    `nextReviewAt` が `undefined` を返すと即座に `Error` を投げていたため、この
    状態のメモは以後どのステップも完了操作ができなくなる（何度リトライしても
    同じ理由で失敗し続ける）不具合があった。この「プリセットの要素数が既存の
    完了済み/未完了ステップ数と食い違う」エッジケース自体の解消は `docs/schema.md`
    が #18 の責務としているが、#17 側のコードが新規に導入した「未処理のまま
    完了操作自体をクラッシュさせ続ける」という無防備な失敗モードは、この Issue の
    スコープとして塞いだ。
    - **この修正自体が `nextScheduledAt` に別の不具合を持ち込んでいた**（正確性・
      テスト網羅性の両レビューで指摘）。「全ステップ完了」（`null` を返すべき）と
      「次のステップは存在するが再アンカリングできず古い `scheduledAt` のまま残って
      いる」を、修正直後は同じ条件（`reanchorUpdates.find(...)` が見つからない）で
      判定していたため区別できず、後者でも `null` を返して「このメモの復習はすべて
      完了しました」という事実と異なるフラッシュメッセージを表示していた
      （実際には一覧に戻ると同じメモが即座に復活する）。フィルタ前の `remaining`
      から「次のステップの行自体が存在するか」を先に判定し、存在すれば
      再アンカリング後の日時（無ければ据え置かれた既存の `scheduledAt`）を返す形に
      修正した。playwright-cli でこのシナリオ（3ステップ作成→1ステップのプリセットに
      切り替え→ step0 を完了）を実際に操作し、修正前後の挙動の違いを確認済み。

- **一覧の「全 N 件」バナーと実際に表示される一覧は同じ定義の集合を数える**
  （advisor によるレビューで指摘）。素朴に `reviews` の生の行数を数えると、
  1つのメモで複数ステップが同時に期限切れの場合に過大な件数を表示してしまい
  （一覧には最小の未完了 step の1行しか出せないため）、バナーと一覧の件数が
  食い違う。`listDueReviews` の一覧クエリ・件数クエリは同じ JOIN・WHERE
  条件（メモごとの最小未完了 step かつ due）を共有しており、常に一致する。

- **一覧の並び順は `scheduledAt` 昇順（古い順）とし、`id` を tie-breaker に追加した**。
  `listMemos`（#13）のレビューで指摘された「同時刻の行でページ間の順序が不安定になる」
  問題と同型で、reviews はメモ作成時にバッチ生成されるため同時刻の行がむしろ
  発生しやすい。

- **「もっと見る」による段階的な読み込みを採用した**（Issue 本文の UX 論点への回答、
  ユーザー承認済み）。件数だけをバナーで見せ、既定 10 件ずつ `offset` を進めて
  読み込む方式にした。`/app/memos`（#14）の前へ／次へページネーションと同じ
  `limit`/`offset` の仕組みをそのまま再利用している。

- **完了後は `offset` を保持せず、素の一覧 URL（`/app/reviews`）へリダイレクトする**
  （advisor によるレビューで指摘）。完了操作は対象の行を一覧から取り除くため、
  `offset` を保持したまま同じページに留まると後続の行がひとつずつ前にずれ、
  次のページに送られていた行が表示されないままスキップされてしまう。

- **完了直後のフラッシュメッセージはセッション等を使わず、リダイレクト先の
  クエリパラメータ（`completedTitle`/`nextScheduledAt`）に載せるだけにした**。
  この情報は「直前の操作の結果」でしかなく、ページを再読み込みされたら消えて
  構わないため、専用のフラッシュメッセージ基盤を導入する必要はないと判断した。

- **「常に最小の未完了 step から完了させる」不変条件により、`reviews` に
  `expectedUpdatedAt` のような楽観的並行性制御用のカラムは不要と判断した**。
  `completeReview` の `UPDATE ... WHERE id = ? AND completed_at IS NULL` が
  そのまま「未完了である」ことを条件にした排他制御として機能する（同じ review を
  二重に完了させようとする競合は、後勝ちの一方が 0 行更新になり `ConflictError` に
  なる）。`updateMemo`（#13）のように複数フィールドを任意の組み合わせで
  更新できるわけではなく、完了操作は単一の状態遷移（未完了→完了）でしかないため、
  この単純な排他制御で十分としている。

- **`ValidationError`/`NotFoundError`/`ConflictError` と、それを HTTP ステータスへ
  マッピングする関数を `$lib/server/memos.ts` から `$lib/server/errors.ts` に切り出した**
  （設計レビューで指摘）。これらは memo 固有の情報を持たない汎用的なエラー分類で、
  #13 の時点では消費者が memos.ts 自身しかいなかったためそこに置いていたが、
  reviews（#17）という2つ目の消費者ができたことで「memos.ts に依存する」という
  不自然な結合が生じた。マッピング関数は `handleMemoError` から `handleDomainError`
  へ改名し、`memos.ts`/`reviews.ts` の双方と、両者を呼び出す全ての `+page.server.ts`/
  `+server.ts`/テストファイルの import 元を新しいモジュールへ揃えた（後方互換の
  re-export は残していない）。
- **`clamp()`・`offset` の正規化（`normalizeOffset`）・limit/offset のオプション型
  （`{ limit?, offset? }`）を `$lib/server/pagination.ts` に切り出した**
  （設計レビューで指摘）。`listMemos`（#13）と `listDueReviews`（#17）が同一の実装を
  それぞれ個別に持っていたため統合した。`pagination.ts` 自体は `parsePaginationParam`
  の置き場所として既に存在していたが、`clamp`/`normalizeOffset` はこの統合まで
  `memos.ts`/`reviews.ts` 側にそれぞれ個別定義されており、`pagination.ts` を
  import してはいなかった（スコープ外の変更レビューで、この点の記述が不正確だったと
  指摘され訂正した）。

## 間隔設定の変更 UI と既存 reviews の再計算 (#18)

- **設定画面（`/app/settings`）のスコープはプリセット管理のみに絞った**（ユーザー承認済み）。
  プリセットの一覧・作成（自由入力のパース）・`intervals` の編集・削除、新規メモの
  既定プリセット選択を行う。既存の個別メモに対するプリセット切替 UI
  （`updateMemo` の `intervalPresetId` を変更する UI）は今回のスコープに含めない。
  `updateMemo` 自体は #13 時点から `intervalPresetId` を受け付けるが、呼び出し元の
  UI が存在しないため実質未使用のまま残る。この経路（`/api/memos/[id]` の PATCH）から
  `intervalPresetId` を変更した場合、reviews は再計算されない（#16 の時点からの既知の
  制約がそのまま残る）。恒久的な解消は将来 Issue に委ねる。

- **プリセットの `intervals` は作成後も編集可能にし、編集時にそのプリセットを使っている
  全ての非アーカイブメモへ再計算を適用する**（`docs/schema.md` の reviews 節が委ねていた
  二択のうち、「作成後は編集不可にし削除・新規作成のみ許可する」ではなくこちらを
  採用。ユーザー承認済み）。

- **再計算のレシピ**（`$lib/server/reviews.ts` の `planReviewRecalculation`）:
  対象メモの未完了 `reviews` を、**期限到来済み（due）のものも含めて全て削除**し、
  完了済みステップ数を起点に新しい `intervals` から残りステップを再生成する。
  完了済み（`completedAt IS NOT NULL`）の行には一切触れない。
  - **due 行も特別扱いせず作り直す**（ユーザー承認済み）。Issue 本文の「注意」は
    「期限が来ている分まで動かすと混乱する」として due 行を保持する案を示唆していたが、
    `docs/schema.md` のレシピ（未完了行を全 DELETE）をそのまま採用する方を選んだ。
    「今日の復習」に出ていた項目の予定が変わる可能性があることは、設定画面の
    「N 件の予定が更新されます」プレビューで事前に明示する。
  - **baseTime は「最新の完了済みステップの `completedAt`（無ければ `memos.createdAt`）」**
    とした（advisor の指摘で、docs のどこにも明記されていないことが判明した未決定事項）。
    #17 の `completeReview` が残りステップを再アンカリングする際の基準
    （完了時刻を起点にする）と揃えており、計算モデルの一貫性を保つ。
  - **新しい `intervals` の要素数が既存の完了済みステップ数以下の場合、残りステップは
    生成せず、そのメモは全ステップ完了扱いになる**（エラーにはしない。ユーザー承認済み。
    `docs/schema.md` が #18 に委ねていたエッジケースへの回答）。
  - 「常に最小の未完了 step から完了させる」不変条件（#17 の `assertIsCurrentStep` が
    保証）に依存しており、完了済み行数は「最大の完了済み step + 1」と一致する
    （欠番が発生しない）ため、完了済み行を1件1件数えるクエリを別に発行する必要はない。

- **アーカイブ済みメモは再計算対象・件数プレビューの両方から除外する**
  （advisor の指摘）。`archiveMemo`（#16）が未完了 reviews を削除して成立させている
  「アーカイブ済みメモに未完了 reviews が残らない」という `docs/schema.md` の不変条件を、
  素朴な再計算が静かに復活させてしまうため。`$lib/server/interval-presets.ts` の
  `collectAffectedMemoIds` で `memos.archivedAt IS NULL` を必ず条件に含める。

- **「N 件の予定が更新されます」のプレビューと実際の更新は同じ定義を共有する**
  （`countReviewsAffectedByPresetChange` と `updateCustomPresetIntervals` が実行時に
  返す件数）。「非アーカイブメモの未完了 reviews 件数」という同一の定義を使い、
  #17 で指摘されたバナー件数と一覧のズレと同型の不整合が起きないようにしている。
  確定時（`confirmed=true` での再送信）に返す件数も、送信された hidden field の数値を
  信用せず、実行直前に読み直した実数の合計を使う（advisor の指摘。別タブでの操作等による
  ズレを防ぐ）。

- **1回の `db.batch()` に積む文の数に上限（`MAX_BATCH_STATEMENTS = 500`）を設けた**
  （advisor の指摘）。プリセット編集は「プリセット UPDATE + 影響メモ数 ×
  (DELETE 1 + INSERT 最大 `MAX_INTERVAL_COUNT` 件)」を1つのバッチにまとめるため、
  影響メモ数に応じて文の数が増える。「Free プランは CPU 10ms/リクエスト」という既知の
  制約（`docs/design-decisions.md` の要注意点2）に対し、無制限に積む設計を避けるための
  安全弁。本アプリの想定ユーザー規模ではまず到達しない、十分に大きい値として選んだ
  任意の上限。超過時は `ValidationError` で拒否する。

- **`user_settings` テーブルを新設し、新規メモ作成時の既定プリセットをユーザーごとに
  持たせた**。Better Auth 生成物（`auth-schema.ts`、手動編集しない）に `additionalFields`
  を足す案も検討したが、生成・実行時設定の二重管理（`rateLimit.storage` と同じ運用上の
  負担）が増え、業務データを `schema.ts` 側に集約する既存の境界とも合わないため見送った。
  `default_interval_preset_id` は `memos.interval_preset_id` と同じ「他ユーザーの
  custom プリセットを指せてしまう」問題を持つため、`0004` と同型のトリガー（`0009`）で
  テナント分離を DB 層に強制する。一方 `onDelete` は `memos.interval_preset_id`
  （`no action`）とは異なり `set null` にし、既定プリセットとして参照されているだけの
  カスタムプリセットの削除まではブロックしない（削除可否の判定は `memos` の使用有無だけを
  見る。ユーザー承認済み、詳細は `docs/schema.md` の `user_settings` 節）。
  `apps/web/src/routes/app/memos/new/+page.server.ts` は、固定値
  `DEFAULT_INTERVAL_PRESET_ID` の送信から `getDefaultPresetId(db, user.id)`
  （未設定ならシステム標準にフォールバック）に切り替えた。

- **プリセットのバリデーション（最小1時間・整数・厳密昇順・要素数上限）と、
  自由入力のパース・表示用フォーマットは `packages/core` に置いた**
  （値の出所を1箇所に保つ既存方針、`packages/core` は無依存なので単体テストが軽い）。
  対応する単位は Issue 本文の例（`1h, 12h, 2d, 10d`）に合わせて `h`/`d` のみとし、
  カレンダー単位（`w`/`m` 等）は導入しなかった。#15 が `intervals` を
  「カレンダー概念を持たない時間単位の配列」と確定させているため、曖昧な
  "1ヶ月" 相当の単位を増やすと #15 の決定と矛盾する。要素数上限
  （`MAX_INTERVAL_COUNT = 20`）は Issue 本文が具体的な数を指定していないため、
  既存のシステムプリセット最長（6ステップ）に十分な余裕を持たせた任意の値。
  「厳密昇順」は同値も拒否する（重複禁止）。表示用フォーマット
  （`formatIntervals`）はパースの逆変換で、24時間で割り切れる値は `d` 表記に
  正規化する。編集フォームに保存済み値を表示し直す際、そのまま再送しても同じ値が
  復元できることをテストで確認している（`parse(format(x)) === x` の往復）。

- **`getAccessiblePreset`（#13 で `memos.ts` に定義）を `interval-presets.ts` へ移設した**。
  新規メモの既定プリセット設定（`setDefaultPresetForUser`）でも同じ「自分の custom
  プリセット、またはシステム標準プリセット」というアクセス可否チェックが必要になり、
  `interval_presets` に関するチェックロジックの置き場所を1箇所に保つため。`memos.ts`
  は `interval-presets.ts` から import するだけになった（動作の変更はない）。

- **レビューで検出・修正した不具合**:
  - **プレビュー（`confirmed=false`）経路が認可・検証を素通りしていた**（正確性レビューで
    指摘）。当初 `countReviewsAffectedByPresetChange(db, presetId)` は所有権チェック
    （`getOwnedCustomPreset`）も `intervals` の構文検証も一切通らず、他ユーザーの
    custom プリセットやシステムプリセットの id をフォームアクションへ直接 POST すると、
    自分のものではないメモの未完了 reviews 件数が取得できてしまっていた。確定
    （`confirmed=true`）経路だけが `updateCustomPresetIntervals` 内部で検証を通っており、
    同じ入力に対して `confirmed` の値だけで検証の有無が変わっていたのが根本原因。
    `previewPresetIntervalsUpdate` として関数自体を作り直し、`getOwnedCustomPreset` と
    `parseIntervalsOrValidationError` を確定経路と全く同じ順序で呼ぶようにした。
  - **`planReviewRecalculation` の SELECT と `db.batch()` 実行の間の競合**（正確性レビューで
    指摘）。対象メモの完了済みステップ数を事前に読んでから `db.batch()` を実行する間に、
    別リクエストの `completeReview` が同じメモの対象ステップを完了させると、古い
    完了済みステップ数を前提にした INSERT が既に完了済みの step 番号と衝突し
    `reviews_memoId_step_unique` に違反する（#17 の `completeReview` 自身が
    `wonThisCompletion` ガードで対処している、同じ SELECT-then-write ハザード）。
    D1 の batch は単一の暗黙トランザクションのため、この違反はプリセット自体の
    UPDATE も含めてバッチ全体をロールバックさせるが、修正前はこれが未捕捉のまま
    生の DB エラー（500）としてクライアントに漏れていた。この違反を検知し
    `ConflictError`（409、リトライを促す）に変換するようにした。`isUniqueConstraintViolation`
    は memos.ts（#16）にあった同名のプライベート関数と全く同じロジックだったため、
    `errors.ts` に共有関数として切り出した。
  - **`parseIntervals` に1間隔あたりの上限が無かった**（正確性レビューで指摘）。
    上限が無いと、`baseTime.getTime() + hours * 3600000` が JS の `Date` の表現可能範囲
    （epoch から約 ±8.64e15ms）を超えて `Invalid Date` になり、それが NOT NULL の
    `reviews.scheduledAt` へそのまま INSERT されてしまう（`Invalid Date` は `Date`
    インスタンスなので truthy であり、`nextReviewAt` の呼び出し側にある
    `if (scheduledAt)` ガードでは弾けない）。`MAX_INTERVAL_HOURS`（10年、Date の
    オーバーフローには全く近づかない任意の上限）を追加した。
  - **設定画面のフォームアクションの型設計が判別可能 union を実質的に破壊していた**
    （設計レビューで指摘）。`presetActionFail(err, action: string, extra: Record<string,
unknown>)` という非ジェネリックな型のため、失敗時の返り値は `action` がリテラル型に
    絞られず、`extra` で積んだフィールド（`name`/`intervals` 等）も型上は存在しなくなり、
    `+page.svelte` 側の `'name' in form` という判別が `unknown` にしか narrowing できず
    実質的に型安全性が失われていた。`presetActionFail` をジェネリック化
    （`<A extends string, E extends Record<string, unknown>>`）してリテラル型と
    フィールドの型を保持するようにした。
  - **`PRESET_NAME_MAX_LENGTH` がクライアントに渡らず、`+page.svelte` の
    `maxlength="100"` がマジックナンバーとして重複定義されていた**（設計レビューで指摘）。
    `MAX_INTERVAL_COUNT` と同じく `load` 経由でクライアントへ渡すようにした。
  - **`interval-presets.ts` からの `MAX_INTERVAL_COUNT` の再エクスポートが未使用だった**
    （設計レビューで指摘）。`+page.server.ts` は `@ebb/core` から直接 import しており、
    この再エクスポートを経由するコードは存在しなかったため削除した。
  - **プレビューが `MAX_BATCH_STATEMENTS` の上限チェックを一切通らず、確定操作だけが
    後から拒否されうる非対称があった**（advisor 指摘）。`previewPresetIntervalsUpdate`
    は対象メモ数に上限を設けていなかったため、確定（`updateCustomPresetIntervals`）が
    `MAX_BATCH_STATEMENTS` 超過でリジェクトするほど対象メモが多い場合でも、
    プレビューは「N件の予定が更新されます」と成功を返してしまい、ユーザーが
    「確定して更新する」を押した瞬間に初めてエラーになる UX が生じ得た。1メモあたり
    最大2文（DELETE + INSERT）という `planReviewRecalculation` の実行系の上限から
    悲観的に見積もる `estimateWorstCaseBatchStatementCount` をプレビュー側にも追加し、
    確定が拒否しうるケースを常にプレビュー時点で検知するようにした（悲観的見積もり
    のため、実際には上限内に収まるはずのケースをプレビュー側が過剰に拒否することは
    あり得るが、安全側であるため許容する）。確定操作にも後から同じ悲観的見積もりを
    追加し、上限超過時の報告（メッセージ文言・例外の種類）は
    `assertWithinBatchStatementLimit` に共通化して、2箇所で同じ文言を重複させない。
  - なお、**間隔を大きく縮小した際、プレビューの「N件」が示す件数はあくまで
    「削除・作り直しの対象になる既存の未完了行数」であり、新しい intervals の長さは
    見ていない**（テスト網羅性レビューで指摘、一貫した定義として結論・マージ非ブロック）。
    そのため縮小の結果メモが全ステップ完了扱いになる場合でも、プレビューはその旨を
    伝えず件数のみを示す。ユーザーへの影響明示としては不完全だが、既知の制約として
    残し、必要になれば別 Issue で対応する。
  - **D1 は1クエリあたりの bind パラメータ数に上限（実測でちょうど100件、101件から
    `too many SQL variables` エラー）があり、`countIncompleteReviewsForMemos` が
    memoId をチャンク分割せずに `inArray` へまとめて渡していたため、
    `MAX_BATCH_STATEMENTS`（500）が許容する規模（悲観的見積もりで最大249メモ）の
    範囲内でも、対象メモが101件を超えるプリセットのプレビューで生の D1 エラーになる
    ことを実測で確認した**（正確性レビューで指摘、advisor 指摘のプレビュー側上限
    ガード追加作業中に発見）。`chunk()` ヘルパーで memoId を100件単位に分割し、
    複数クエリの結果を合算するようにした。同じ問題を持つ、アーカイブ状態の
    再確認クエリ（下記）にも同様の対処をした。
  - **プリセット再計算（`updateCustomPresetIntervals`）と `archiveMemo` の間の
    競合状態**（正確性レビューで指摘）。`collectAffectedMemoIds` の SELECT から
    `db.batch()` 確定までの間に、対象メモのいずれかが別リクエストの `archiveMemo` に
    よりアーカイブされると、`archiveMemo` が同期的に削除した未完了 reviews を
    `planReviewRecalculation` の INSERT が知らずに作り直してしまい、「アーカイブ済み
    メモに未完了 reviews が残らない」不変条件を静かに破る（#17 の `completeReview` と
    同種の SELECT-then-write ハザードだが、DB 制約に触れないためエラーとして検知
    できない点が異なる）。`db.batch()` 実行の直前にもう一度だけ対象メモのアーカイブ
    状態を確認し、その時点までにアーカイブされた memoId を再計算対象・
    `updatedReviewsCount` の両方から除外することで競合の窓を大幅に狭めた。
    `completeReview` の `wonThisCompletion` と異なり、この確認と `db.batch()` 実行の
    間には依然として僅かな窓が残る（DB 制約による検知ができないため、SQL の
    WHERE 句に組み込む形での完全な排除は見送った）。現状のどの読み取り経路も
    `isNull(memos.archivedAt)` でフィルタしているため、この残存レースが仮に起きても
    アーカイブ済みメモの孤立した reviews 行が外部から見える・操作できることはない。
    このガードには、`planReviewRecalculation` を横取りして「対象メモの列挙後・
    再確認前」にアーカイブを割り込ませる回帰テストを追加した（`db.batch` を横取りする
    既存の競合テストとは異なるタイミングを再現する必要があったため、手法を変えた）。
  - **`activePlans` を memoId と plan の並行配列＋index対応付けで組み立てていた**
    （設計レビューで指摘）。`memoIds.map((memoId, index) => ({ memoId, plan:
plans[index] }))` という実装は、「memoIds と plans が同じ順序・同じ長さ」という
    `Promise.all` の性質に暗黙に依存しており、`noUncheckedIndexedAccess` を満たすための
    型ガードもその依存を表現できていなかった。`Promise.all(memoIds.map(async memoId
=> ({ memoId, plan: await planReviewRecalculation(...) })))` として最初から
    ペアで組み立てるよう変更し、並行配列と手書きの型ガードを排除した。
  - **チャンク分割ロジックの重複**（設計レビューで指摘）。`countIncompleteReviewsForMemos`
    と `updateCustomPresetIntervals` 内のアーカイブ再確認が、それぞれ独立に
    `chunk()` を呼んで結果を結合していた。`queryInChunks(ids, query)` として
    「チャンク分割 → 並列クエリ → 結合」を1箇所にまとめ、`D1_MAX_BIND_PARAMS` が
    「1つの `inArray` に渡せる件数」ではなく「1クエリの bind パラメータ総数」の
    上限であることのコメントも、将来クエリに条件を追加する際の注意点として明示した。
  - **`listPresetsForUser` の `inUse` が userId で絞らずに全ユーザーの memo を
    集計しており、システム標準プリセット（全ユーザー共有）については「自分が
    使っているか」ではなく「他ユーザーも含め誰かが使っているか」を返してしまって
    いた**（正確性レビューで指摘）。カスタムプリセットは所有者以外がそもそも
    一覧に現れないため実害は無いが、システム標準プリセットについては、UI 上は
    `inUse` を表示していない（`+page.svelte` は非システムプリセットの行にしか
    使っていない）ものの、ページの `data.presets` には含まれる形で他ユーザーの
    存在に関する1ビットの情報（そのシステムプリセットを誰かが使っているか）が
    漏れていた。使用中判定の SELECT に `eq(memos.userId, userId)` を追加して
    修正した。
  - **`updateCustomPresetIntervals`（確定操作）が、実測の `statements.length` による
    バッチ上限チェックしか持たず、それより前に対象メモ全件分の `planReviewRecalculation`
    （1メモあたりSELECT3回）とアーカイブ再確認クエリを実行してしまっていた**
    （設計レビューで指摘）。`previewPresetIntervalsUpdate` は
    `estimateWorstCaseBatchStatementCount` による悲観的見積もりで実行前に早期拒否
    するのに対し、確定操作側はこの見積もりを使っておらず、UIの確認フローを迂回して
    `confirmed=true` を直接POSTした場合、`MAX_BATCH_STATEMENTS` を設けた本来の目的
    （Free プランの CPU 10ms/リクエスト制約に対する安全弁）を実行系では
    部分的にしか達成できていなかった。`collectAffectedMemoIds` の直後に同じ
    悲観的見積もりチェックを追加した。この早期チェックが `1 + memoIds.length * 2 <=
500` を保証する以上、`activeStatements`（`memoIds` の部分集合である
    `activePlans` 由来、1メモ最大 `MAX_STATEMENTS_PER_MEMO` 文）の実測値が
    `MAX_BATCH_STATEMENTS` を超えることは論理的にあり得ないため、それまであった
    実測値 `statements.length` による重複チェックは削除した（起こり得ないシナリオへの
    防御的検証は書かない方針）。これに伴い、実測値ちょうど500文を境界とするテストは、
    悲観的見積もり側で先に拒否されるようになったため、見積もり自体の境界
    （249メモまでは必ず成功、250メモ以上は即座に拒否）を検証するテストに置き換えた。

## packages/push に Web Push 送信処理を実装する (#20)

> **#77 による訂正**: 以下は `@block65/webcrypto-web-push`（legacy `aesgcm`）
> 採用時点の記録。Android 実機で通知が表示されない不具合が発覚し、#77 で
> `crypto.subtle` ベースの RFC 8291 `aes128gcm` 自前実装に置き換えた。
> `sendPush` の型・インターフェース（`PushSendResult` / `PushSubscriptionRecord` /
> `PushPayload` / 戻り値の5値分類 / auth のみ明示検証する方針 / リトライしない方針）
> は変更していないため、以下の記述はその部分に限り引き続き有効。暗号化の実装詳細
> （`buildPushPayload` への言及、ペイロードサイズの実測値）のみ #77 時点の実装とは
> 異なる。

- **`sendPush(subscription, payload, vapid)` は `packages/db` に依存しない**
  （L184-189 の方針どおり）。`subscription` は D1 の行と同じ平坦な形
  （`{ endpoint, p256dh, auth }`）で受け取り、`@block65/webcrypto-web-push` が要求する
  `{ keys: { p256dh, auth } }` へのネストは関数内部で行う。呼び出し側に
  詰め替えを要求すると「呼ぶだけで送れる」という受け入れ条件に反するため
- **`sendPush` が入力を検証するかどうかの基準は「その入力が不正だと、返す
  `PushSendResult` 自体が不正確になるか」**（3回目の設計レビューで指摘された
  統一原則）。`subscription`（`endpoint`/`p256dh`/`auth`）を検証するのはこの
  基準に当てはまるから、`payload`（`memoId`/`title`/`url`）を検証しないのは
  当てはまらないから ―― push サービスへは実際に届くので `sent` は不正確になら
  ない。2つの無関係な理由を並べているわけではない
- **`auth` だけを base64url デコード後のバイト長（16バイトの共有シークレット）
  で明示的に検証する**。最初は `endpoint`/`p256dh`/`auth` の3つとも文字列が
  空文字かどうかだけを見ていたが、3回目のレビューで `auth: 'a'`（1文字、
  デコードすると0バイト）が空文字判定をすり抜け、かつ
  `@block65/webcrypto-web-push` の HKDF 実装がデコード後バイト長0の `auth` に
  対して例外を投げずダミーハッシュを返して暗号化・送信まで進めてしまうことを
  実測で発見した。文字列の長さチェックはこの「デコード後のバイト長が0」という
  ハザードの近似に過ぎず、1文字の破損した値（切り捨て等で現実的にあり得る）を
  見逃す。この問題に気付かず放置すると、復号不能な通知が「送信成功」として
  報告されてしまう。
  **`endpoint`/`p256dh` には明示的なガードを置かない**（5回目のレビューで指摘）。
  不正な `endpoint`（URL として解析できない）や壊れた `p256dh`（EC 鍵として
  `crypto.subtle.importKey` が受理できない）は、いずれも `buildPushPayload` の
  例外を経由して既存の try/catch だけで `invalid` になる。実際にこの2つの
  ガードをコメントアウトしてテストを実行しても全件変わらず通ることを実測で
  確認しており、無くても結果は変わらない。「起こり得ないシナリオへの防御的
  検証は書かない方針」（要注意点、L1566-1567 参照）に合わせ、実効性の無い
  ガードは置かない。**`auth` 側だけがこの明示チェックが唯一の防御線**
  （HKDF が例外を投げないため）であり、テストでもこの違いを区別して記述している
- 戻り値は `'sent' | 'expired' | 'retryable' | 'invalid' | 'rejected'` の5値
  （それぞれ 成功 / 購読の失効 / 一時的な失敗 / それ以外の2種類 に対応）
  - **`expired` は 404 / 410 のみ**。401/403（VAPID 鍵の設定不正の可能性がある）を
    含めると、鍵の設定ミス1つで全購読が「失効」と誤判定され、#22 の削除処理が
    全ユーザーの購読を消しかねない。安全側に倒し、判別が付かないものは
    `rejected` に落とす
  - `retryable`: ネットワークエラー / 408 / 429 / 5xx。408 は要求のタイムアウト、
    429・5xx は push サービス側の一時的な問題であり、購読自体は無効ではない
  - **「それ以外」を `invalid` と `rejected` の2つに分ける**（設計レビューで指摘）。
    `invalid` は `buildPushPayload` 自体が失敗した場合（subscription または
    VAPID 鍵のどちらの形式が不正なのかは区別しない）、`rejected`（`status` 必須）
    は push サービスが 404/408/410/429/5xx 以外のステータスを返した場合（その送信
    固有の問題）。**`invalid` は「1件の購読だけがおかしい」場合と「VAPID 鍵の
    設定自体がおかしく全件が同じ理由で失敗する」場合の両方を含み得る**
    （2回目の設計レビューで指摘。前者は購読単位、後者は全送信に影響する
    グローバルな問題で性質が異なるが、issue #20 が求める分類は3種類 + 成功の
    ため、ここでは追加の判別子は設けない。呼び出し側でこの区別が必要になったら
    ―― 例えば VAPID 鍵をループの外側で一度だけ検証する ―― 呼び出し側で
    対処するのが妥当）
  - fetch の**タイムアウトは実装しない**（`AbortSignal` を渡していない）。
    Workers のサブリクエストにはプラットフォーム側の上限があり、無限に待つ
    リスクは無いため。明示的な timeout 制御が必要になったら #21 以降で検討する
  - `readVapidConfig` の引数の3プロパティは全て optional なので、`VAPID_*` を
    一切持たない `Env`（現時点の `apps/scheduler/worker-configuration.d.ts` は
    `{ DB: D1Database }` のみ）を渡してもコンパイルは通り、実行時にしか
    不足が検出されない（2回目の設計レビューで指摘）。#21 で `apps/scheduler` の
    `wrangler.jsonc` に `VAPID_*` を追加し `wrangler types` を再生成すれば、
    その時点から「渡し忘れ」もコンパイルで検出できるようになる
- **リトライ方針: `sendPush` 自身はリトライしない（1回のみ試行）**。呼び出し側が
  `retryable` をどう扱うかは配送保証に応じて決める。#21 の scheduler は「同じ復習に
  二度届かない」を優先し、応答喪失後の再送による重複を避けるため at-most-once とする
- VAPID 鍵は呼び出し側から引数で渡す（テスト容易性のため、関数内部で
  環境変数を直接読まない）。ただし「環境変数から読む」という受け入れ条件は
  `readVapidConfig(env)` を別途 export し、env var 名をこの1箇所に集約して満たす
- **秘密鍵はログ・エラーメッセージに一切含めない**。`buildPushPayload` の失敗
  （subscription 形式不正・VAPID 鍵の形式不正等）は詳細を握り `invalid` を
  返すのみにする。テストでは「subscription や VAPID 鍵の形式が不正でも
  例外を投げずに `invalid` を返す」ことを検証している（`PushSendResult` は
  判別子と `status`（数値）以外の文字列フィールドを持たないため、返り値に
  秘密鍵の値が含まれる余地自体が無い）。値そのものが漏れる余地があるのは
  `readVapidConfig` のエラーメッセージ（不足しているキー**名**を含める設計）
  のみで、こちらは値を含めないことをテストで直接検証している
- 単体テストはダミー文字列ではなく実際に生成した ECDSA/ECDH P-256 鍵ペアを使う。
  ダミー値だと `buildPushPayload` 内の `crypto.subtle.importKey` が例外を投げ、
  ステータスコードの分類ロジック（本来テストしたい部分）が一度も実行されずに
  全テストが `invalid` で緑になってしまうため
- **ペイロードサイズの実測**（docs/web-push-spike.md がこの実測を#20に委ねていた。
  数値自体はweb-push-spike.mdには記載が無く、#20で新たに実測した）: title
  200文字（日本語）+ memoId + url を含む JSON（`buildPushPayload` が実際に
  暗号化する平文は `JSON.stringify(message.data)` そのもので、716 bytes）を
  実際に暗号化し、暗号化後 734 bytes だった。`aesgcm`（legacy scheme）は
  2バイトのパディング区切り + 16バイトの AES-GCM 認証タグ = 18バイトを
  常に付加するため、716 + 18 = 734 と一致する。Web Push の実用上限とされる
  4KBに対して十分小さい。`memos.title` に長さ制限は無いが、4KBに達するには
  数千文字規模のタイトルが必要になる計算のため、#20 では truncation 等の
  対応は行わない（制限が必要になったら測り直して決める）
- 本番デプロイ後の CPU 時間計測（docs/web-push-spike.md から申し送り）は
  #20 のスコープでは行わない。実際にスケジューラから送信するのは #21 のため、
  計測はそちらに委ねる

## scheduler での実送信 (#21)

- **`reviewsDeferred`（送信予算不足）、`reviewsContended`（並行実行が先に claim）、
  `reviewsFailed`（review 単位の予期しない例外）は別カウンタにする**
  （4回目の設計レビューで指摘・修正）。当初は両方を `reviewsDeferred` に
  合流させていたが、`SEND_BUDGET` を本番デプロイ後に実測して調整する際、
  ログの `deferred=N` だけでは「健全なスロットリングが機能している」のか
  「DB 更新等が例外を投げている」のかを区別できず、調整判断を誤らせる
  （前者なら `SEND_BUDGET` を上げる調整で済むが、後者は別途原因調査が必要）。
  それぞれをログから区別できるようにする
- **CPU 予算は「review の件数」ではなく「sendPush の呼び出し回数」で管理する**
  （advisor によるレビューで指摘）。CPU を消費するのは crypto（ECDSA 署名 +
  ECDH 鍵合意 + AES-GCM 暗号化）であり、その回数は review 件数ではなく
  `review × その所有者の購読数`。#19 でユーザーは複数デバイスから購読できるため、
  review 件数だけを LIMIT すると「1ユーザーが3台持っていれば1件の review で
  3回の crypto 処理が走る」を無視してしまい、「大量に溜まった状態でも CPU 超過で
  Worker が落ちない」という受け入れ条件を満たせない。`SEND_BUDGET`
  （送信回数の予算）を主たる上限にし、review 単位で消費する。SELECT 自体にも
  緩い上限（`REVIEW_QUERY_LIMIT`）を掛けるが、これはクエリ・メモリを一定以上
  肥大化させないための副次的な上限に過ぎない
- **予算を超える review に到達したら `continue`（その review だけスキップ）で、
  `break`（それ以降の処理を丸ごと打ち切る）ではない**（正確性レビューで指摘・
  修正）。当初は `break` にしていたが、`selectDueReviews` は scheduledAt 昇順の
  ため、1ユーザーの購読数が `SEND_BUDGET` を超える review が一度先頭（最古）に
  来ると、それ以降の**すべての** cron 実行が毎回そこで停止し、それより新しい
  **他ユーザー**の通知まで永久に止まってしまう（該当 review はユーザーが
  「復習した」操作をするまで `completedAt` が付かず、SELECT 対象から外れない
  ため、放置される限り毎回先頭に居座り続ける）。さらに deferred 行の
  `notificationAttemptedAt` を更新して次回の SELECT では後方へ回す。`continue` だけでは、
  予算超過行が `REVIEW_QUERY_LIMIT` 件あると SELECT 枠の外の他ユーザーを依然として
  永久に止めるため（5回目のレビューで指摘・修正）
- **具体的な `SEND_BUDGET` は保守的な値 5 とする**。CPU 実測は Issue #21 の
  完了条件に含めないことをユーザー確認済み。運用ログで CPU 超過が観測された場合は
  値を下げる
  - Cloudflare 公式ドキュメント（developers.cloudflare.com/workers/platform/limits/）
    で確認: **Free プランの Cron Trigger の CPU 時間制限も HTTP リクエストと同じ
    10ms/呼び出し**（advisor の指摘で裏取りした。Cron Trigger 専用の別枠は無い）
- **1ユーザーの購読数が `SEND_BUDGET` を超える場合、そのユーザーの review は
  常に「予算不足」と判定され続け、事実上処理されない**（既知の限界）。
  実運用で想定されるデバイス数を大きく超える値のため対応は行わない
- **`selectDueReviews` はメモごとに「未完了の最小 step」のみを対象にする**
  （設計レビューで指摘・修正）。`reviews` はメモ作成時に全 step 分の
  `scheduledAt` が baseTime から一括生成される（`packages/core` の
  `nextReviewAt`）ため、ユーザーが長期間操作しないと同じメモの複数 step が
  同時に期限到来・未完了・未通知になり得る。この不変条件（「常に最小の未完了
  step からのみ通知・操作できる」）は #17 が `apps/web/src/lib/server/reviews.ts`
  の `listDueReviews`/`getDueReviewDetail` で既に確定させているが、当初の
  `selectDueReviews` はこれを見ずに条件だけで SELECT していた。これを見逃すと
  非最小 step にも通知が送られ、通知の遷移先 `/app/reviews/{id}` を開くと
  `getDueReviewDetail` の `assertIsCurrentStep` が `ConflictError` を返す
  （「通知は届くが開けない」）ことに加え、本来アクションできない step が
  `SEND_BUDGET` を無駄に消費する。scheduler では外側の LIMIT 前に全未完了行を
  `GROUP BY` しないよう、候補行に対して「より小さい未完了 step が存在しない」ことを
  相関 `NOT EXISTS` で確認する。同じ理由で
  `apps/web` の `listDueReviews` が既に持っていた `memos.archivedAt` の除外と
  `id` の tie-breaker（`scheduledAt` はミリ秒精度で同時刻の行が起こり得るため、
  どの review が今回の `SEND_BUDGET` を使うかを実行ごとに安定させる）も
  合わせて揃えた
- **`notifiedAt` は外部送信を一度でも試行する review の claim 時に立て、その後は
  `retryable` を含む結果にかかわらず維持する（at-most-once）**（5回目のレビューで
  修正）。Push サービスが受理した後に応答だけ失われたケースと、受理前に失敗した
  ケースを呼び出し側では判別できない。retryable 時に claim を解除すると前者を次回
  cron が再送し、Issue #21 の「同じ復習について通知が二度届かない」に違反し得るため、
  再試行による到達率より重複防止を優先する。購読が0件の場合も claim を維持する
- **通知の遷移先 URL は `/app/reviews/{reviewId}`**。packages/push の単体テストの
  payload フィクスチャは `/app/memos/...` だったが、これは決定ではなくテスト用の
  適当な値だった。`/app/reviews/[id]` は #17 で実装済みの「復習した」操作まで
  実行できるページであり、かつ「期限切れ通知への防御」（#17 の
  `getDueReviewDetail` が due 条件・現在の step を再検証する）が既に実装済みの
  ため、古い通知から遷移しても安全に扱える
- **外部送信の前に `notifiedAt` を条件付き UPDATE し、並行 cron 間の原子的な
  claim として使う**。同じ review を SELECT した複数実行のうち、
  `WHERE notified_at IS NULL` の UPDATE に勝った1実行だけが `sendPush` へ進む。
  claim では `completed_at IS NULL` と `scheduled_at <= now` も再検証し、SELECT 後に
  完了・再計算された review へ古い通知を送らない（5回目のレビューで指摘・修正）。
  送信後に印を付ける方式では、UPDATE の条件だけでは外部送信の重複を防げないため、
  順序を逆にした
- **`notificationAttemptedAt` は deferred review を SELECT の後方へローテーションする
  ために記録する**。未完了・未通知行用の部分インデックスも同じ並び順で追加する
- **手元での動作確認には `--persist-to` でローカル永続化先を共有する必要がある**
  （scheduler Worker の雛形（#5）の節で申し送っていた対応）。`apps/web` と
  `apps/scheduler` は個別に `wrangler dev` すると別々の `.wrangler/state` を
  持つため、`apps/web` で作った memo/review を `apps/scheduler` の cron から
  読めない。同じ `--persist-to <dir>` を両方に渡すことで解消する
  （このセッションではこの方法で実 D1 に対して SELECT・sendPush 呼び出し・
  `notifiedAt` の UPDATE が実際に動くことを確認した）
- **`apps/scheduler` に `@ebb/push` を追加した結果、`compatibility_flags` に
  `nodejs_compat` が必要になった**（`@block65/webcrypto-web-push` が
  `node:crypto` を参照するため。`apps/web` は既に持っていたが、`apps/scheduler`
  は元々 D1 しか使わず不要だったため欠けていた）。`wrangler dev --test-scheduled`
  での動作確認で初回に警告が出て気付いた。vitest-pool-workers 用の
  `wrangler.test.jsonc` には最初から付けていたためテストでは検出できず、
  本番相当の `wrangler.jsonc` を実際に起動して確認したことで見つかった
  > **#77 による訂正**: #77 で `@block65/webcrypto-web-push` を `crypto.subtle`
  > 自前実装に置き換えたため、この `nodejs_compat` の根拠（`node:crypto` 依存）は
  > 無くなった。ただしフラグ自体を外して良いかは実デプロイでの確認が必要なため、
  > #77 のスコープでは変更していない
- **`VAPID_PRIVATE_KEY` は Worker 単位の secret のため、`apps/web` に
  設定済みでも `apps/scheduler` Worker には別途 `wrangler secret put
VAPID_PRIVATE_KEY` が必要**（ユーザーが実行する必要がある。#19/#20 の
  VAPID 関連の secret 投入と同様、このセッションでは未実行）
- **実際の push 配信確認はこのセッションでは行っていない**（#8/#19/#20 と同じ
  制約：開発用サンドボックスは outbound network を許可リスト方式で制限しており、
  実際の push サービスへの `fetch` が届かない）。検証済みなのは、実 D1
  （`--persist-to` で共有した本物の SQLite）に対して「期限到来・未完了・未通知の
  review を正しく選び、購読を JOIN し、`sendPush` を呼び、結果に応じて
  `notifiedAt` を更新する」というオーケストレーション全体が動くことと、
  無効な購読（テスト用の適当な `p256dh`/`auth`）に対して `sendPush` が
  正しく `invalid`/`retryable` を返して処理が継続することのみ。実際の
  ブラウザへの通知表示は、ユーザー自身の環境で本番デプロイ後に確認する
  必要がある
- **失効購読（`sendPush` が `expired` を返した購読）の削除は #21 のスコープに
  含めない**。`packages/push` のコメントは削除を「呼び出し側の責務」としているが、
  具体的にどの Issue で削除するかは #22（「購読失効の処理と通知クリック時の遷移」、
  受け入れ条件に「送信失敗を機に DB から消える」と明記、#21 に依存）が担う。
  2回目のレビューで2エージェントから独立に「削除処理が無い」と指摘されたが、
  `gh issue view 22` で確認の上、#21 の欠落ではなく既存のスコープ分割
  （design-decisions.md 上記「送信ライブラリの決定」節、L1605-1606 の
  `#22 の削除処理` という記述も同じ分割を示す）どおりと判断し、棄却した
- **`SEND_BUDGET` の CPU 実測は不要**とユーザー確認済み。保守的な既定値 5 と、
  送信件数・失敗件数・deferred 件数の運用ログを用いる

- リポジトリ: public
- Issue の粒度: 1 Issue = 1 PR（半日〜1日程度）
- **Web Push の技術検証（M1）を認証やメモ機能より先に置く**
  → このプロジェクトで最も不確実性が高い箇所であり、
  ここで想定外の壁に当たると設計全体に影響するため。
  認証・CRUD は手順が確立した定型作業なので後に回してもリスクが増えない

## 購読失効の処理と通知クリック時の遷移 (#22)

- `sendPush` が 404 / 410 を `expired` と分類した場合、scheduler が対応する
  `push_subscriptions` 行を削除する。送信結果と後始末の状態を運用ログで区別できるよう、
  失効検出数・削除数・削除失敗数を個別に集計する。削除に失敗しても残りの送信は継続し、
  次の cron で同じ購読が再び `expired` になったときに再試行する。購読一覧は cron 開始時の
  スナップショットなので、失効と判定した購読はその実行内の送信対象からも除外し、同じ
  ユーザーの別 review を失効 endpoint へ送り続けない。後述の再購読との競合により条件付き
  DELETE が0件だった場合は、そのユーザーの購読を読み直し、後続 review では更新後の鍵を使う
- 失効削除は endpoint だけでなく、送信前に読んだ行の ID・`p256dh`・`auth` がすべて
  一致する場合に限定する。Push サービスへの送信中にブラウザが同じ endpoint で再購読し、
  `savePushSubscription` が鍵を更新した場合、古い鍵に対する 404 / 410 応答で新しい購読を
  削除しないためである
- 通知の `data.url` に scheduler が生成した `/app/reviews/{reviewId}` を保持する。
  `notificationclick` では既存の WindowClient があればそのタブを `navigate()` してから
  `focus()` し、新しいタブを増やさない。既存タブがない場合だけ `openWindow()` する。
  URL のない旧通知は従来どおり `/` へフォールバックする
- **連続失敗による購読の自動無効化は今回は導入しない**。`retryable` はネットワーク障害や
  Push サービスの 5xx を含み、`rejected` の 401 / 403 は VAPID 設定不正で全購読が同時に
  失敗する可能性がある。これらを購読単位の単純な連続回数で無効化すると、有効な購読を
  大量に止める危険がある。明確に購読失効を示す 404 / 410 の即時削除と、削除状況のログを
  先に運用し、恒久エラーの分類と再有効化 UI が必要になった時点で失敗回数カラムを検討する
- **通知の「復習した」アクションボタンは今回は付けない**。通知から直接完了させるには、
  認証済みの変更リクエスト、期限切れ・現在 step の再検証、誤操作時の回復手段が必要になる。
  既存の復習画面はこれらの検証と操作 UI を既に持つため、通知クリックで同画面へ遷移する
  導線を採用する

## デザイントークン・タイポグラフィ基盤 (#55)

- **`.flash` はアクセント淡色トークン（`--color-accent-bg: #eaf1ed` / `--color-accent-border:
#cddfd6`）に対応させた**。Issue が指定する採用色一覧には成功系（緑）の色が存在せず、
  既存の `.flash`（`#eef6ec` / `#b8d8ae`）をそのまま個別トークン化すると、パレット外の
  hex 値が2つ残ってしまい「主要な色がハードコードでなく共通の定義から参照できる」という
  受け入れ条件を半分しか満たせない。アクセント色の淡色バリアントは positive な状態表示の
  役割を兼ねると判断し、既存の緑系トーンは廃止してアクセントトークンに統合した
- **カード/入力の枠線3色（`#e5e0d5` / `#ddd8cc` / `#eae5da`）は、参照元
  （claude.ai design project 内 `Ebb Redesign.dc.html`）から役割の対応が取得できないため、
  明度順で機械的に命名した**: `--color-border-subtle`(`#eae5da`、最淡) / `--color-border`
  (`#e5e0d5`、中間・既定) / `--color-border-strong`(`#ddd8cc`、最濃)。これは実装上の想定で
  あり、デザイン確定時に役割の割り当てが変わる可能性がある
- **フォントは Google Fonts CDN ではなく `@fontsource/noto-sans-jp` /
  `@fontsource/noto-serif-jp` をセルフホストで導入した**。両パッケージは weight ×
  unicode-range（`japanese-*.css` 等）単位で `@font-face` が分割されているため、
  `japanese-400.css` のように日本語サブセットだけを `app.css` から `@import` すれば、
  ラテン文字・キリル文字等の不要な woff2（1 weight あたり数百 KB〜1MB超）を除外できる。
  Vite がビルド時に `files/*.woff2`/`.woff` を `_app/immutable/assets/` 配下の静的アセットへ
  bundling するため、本番ビルドでも Google Fonts CDN への外部リクエストは発生しない
  （手動での woff2 ダウンロード・配置は不要と判断した）
- **PWA の `theme-color`（`#1c2b39`、`manifest.webmanifest` と `+layout.svelte` の
  `<meta>` にハードコードされている値）は本 Issue のスコープ外として変更していない**。
  この重複は #9 で意図的に許容されているもので、今回導入した CSS カスタムプロパティは
  ページコンテンツの配色にのみ適用し、ブラウザ UI 用の `theme-color` には関与しない
- **既存の `.flash`/`.warning`/`.error` は表示クラス自体の共通化（1箇所への統合）は行わず、
  各ファイルの色・radius の値をトークン参照に置き換えるのみに留めた**。Issue の作業内容が
  求めるのは「新トークンへの置き換え」であり、複数ファイルへの重複定義自体の解消は
  スコープに含めていないため
- **警告バナーの文字色2値（`#6b4f21` / `#7a5f30`）は、両方とも `--color-warning-bg`
  （`#fdf3e5`）上のテキスト用として、`--color-warning-text`(`#6b4f21`) をバナー本文に、
  `--color-warning-text-secondary`(`#7a5f30`) を予備（現時点で未使用）として定義した**。
  当初はこの2値のうち1つを `--color-warning-button` 背景の上のボタン文字色に転用したが、
  レビューで `#8a6a2f` と `#7a5f30` の組み合わせが WCAG コントラスト比 1.19:1
  （最低基準 4.5:1 を大幅に下回り実質判読不能）になることを指摘され誤りと判明した。
  Issue はボタンの文字色を指定していないため、ボタン専用に `--color-warning-button-text`
  (`#fffdf8`、`--color-warning-button` とのコントラスト比 4.94:1) を新規追加し、
  警告バナーの文字色2値とは独立させた。当初 `--color-warning-text-strong` という名前も
  付けていたが、このPR内の border トークンの命名規則（`-strong` = 明度順で最も濃い値）と
  逆転していた（`#7a5f30` は `#6b4f21` より明るい）ため、意味を持たせない
  `-secondary` に変更した

## 下部4タブナビゲーション + 作成ボタン(FAB) (#56)

- **下部タブバーの背景は `--color-bg`（`#eceae4`）にした**。参照デザイン
  （`Ebb Redesign.dc.html` 1a案）のモックアップ内では画面地・タブバーとも `#faf8f3`
  だが、これはモック用のキャンバス上の「画面」背景であり、実アプリの `body` 背景
  （`--color-bg`）に対応する。Issue の「背景は紙面と同色」は実アプリの紙面＝
  `--color-bg` と読み、タブバーがページに溶け込むようにした
- **タブバー・作成ボタン(FAB)の位置調整に使う高さは `--bottom-nav-height`
  （`52px`）としてトークン化した**。`app/+layout.svelte`（タブバー自体の高さ・
  コンテンツ領域の下パディング）と `Fab.svelte`（ボタンの `bottom` 位置）の
  2箇所が同じ値を前提にするため、値のずれを防ぐ目的で共通トークンにした
- **コンテンツ領域の下パディングは FAB の有無に関わらず全ページで
  タブバー高 + 4.5rem を確保する**（advisor 指摘）。FAB は `/app` と
  `/app/memos` にしか出ないが、ページ別に下パディングを分岐させると
  レイアウトが複雑になる。FAB の真下に最後の要素が来るとページ最下部の
  操作がタブバー/FABに隠れてしまうため、FAB のないページで余白がやや
  増える方を選んだ
- **`app/memos/+page.svelte` の一覧上部にあったインラインの「＋ 新規作成」
  リンクは削除し、FAB に一本化した**。参照デザインのメモ一覧にはインライン
  リンクがなく、Issue にも明記はないが、作成導線を FAB に統一する意図と判断した
- **ユーザー名表示・ログアウトボタンは `app/+layout.svelte` から
  `app/settings/+page.svelte` に移設した**。`app/+layout.server.ts` の
  `{ user: locals.user }` は SvelteKit の親子 load データ結合により設定画面でも
  そのまま参照できるため、layout 側のデータ構造は変更していない

## 復習詳細画面のリデザイン (#59)

- **ヘッダーの「全 m 回」は `intervalPresets.intervals.length` ではなく、
  そのメモの `reviews` 行の総数（完了済み + 未完了）を数えて計算する**
  （`apps/web/src/lib/server/reviews.ts` の `getDueReviewDetail`）。
  `updateMemo`（#13）は `intervalPresetId` を変更しても既存の `reviews` 行を
  作り直さないため（#18 のスコープ、`completeReview` 節の既存コメントと同じ
  前提）、プリセット変更後は `intervals.length` と実際の `reviews` 行数が
  ずれ得る。ヘッダーは実際に画面遷移できるステップ数と一致させる必要がある
  ため、`reviews` 側の実数を正とした
- **次回予定のプレビュー（`previewNextScheduledAt`）は、ページの読み込み時点
  (`now`) を基準に計算する**。実際に「復習した」を押した時点の `completedAt`
  とは（ページを開いてから押すまでの経過時間だけ）ズレ得るが、表示は分単位
  （`Intl.DateTimeFormat` の `timeStyle: 'short'`）のため、通常の操作時間内
  では表示上の差は出ない。プリセット短縮等で再アンカリング計算ができない
  場合のフォールバック（既存の `scheduledAt` を返す）は `completeReview` と
  `resolveNextScheduledAt` ヘルパーを共有しており、この分岐は厳密に一致する
  （テストで検証済み）。再計算される分岐の厳密な一致はテストしていない
  （基準時刻が異なるため原理的に検証不可能、テストコードのコメントに明記）
- **`.complete-bar`（「復習した」ボタン+プレビュー行）は `position: fixed` で
  下部タブバーの直上に重ねる**。参照デザイン（`Ebb Redesign.dc.html` の
  「復習の詳細」フレーム）にはタブバー自体が存在しない構成だが、既存の
  `app/+layout.svelte` は全ページ共通でタブバーを表示する実装になっており、
  この画面だけタブバーを隠す変更は本 Issue のスコープ外と判断し、タブバーは
  残したままその上に固定バーを重ねる形にした
- **Markdown 表示スタイル（`.markdown-body`）は `$lib/components/MarkdownBody.svelte`
  に共通化したが、`formatDateTime`（`Intl.DateTimeFormat('ja-JP', {dateStyle:
'medium', timeStyle:'short'})`）は `$lib/format-date-time.ts` に切り出した
  上で、既存の重複箇所（`app/+page.svelte`, `app/reviews/+page.svelte`）は
  移行せず残した**。Issue が要求する共通化は markdown-body のみであり、
  `formatDateTime` の重複自体は本 Issue が持ち込んだものではない。今回
  新規に追加するコードでさらに重複を増やさない（3箇所目のコピーを作らない）
  対応に留め、既存2箇所への変更はスコープ外として見送った

## PWA のトップページ（"/"）をアプリ本体のホーム画面にする (#71)

- **`apps/web/src/routes/app/` は素の `routes/` 直下ではなく、SvelteKit の
  ルートグループ `apps/web/src/routes/(app)/` へ移動した**。ルートグループは
  URL に影響しないため、ホームは `/`、メモ一覧は `/memos`、復習一覧は
  `/reviews`、設定は `/settings` になる一方、`(app)/+layout.server.ts` の
  未ログイン時ガード（`/login?redirectTo=...`）はグループ内のみに適用される。
  素の `routes/` 直下に平置きすると、このガードが `login`/`debug/*`/`api/*`
  にも継承されてしまい（未ログイン時に `/login` 自体へアクセスするとリダイレクト
  ループになる、`/api/*` は 401 の JSON を返すべきなのに HTML リダイレクトされる
  等）、そちらを個別に除外する分岐が別途必要になる。ルートグループならその除外を
  ディレクトリ分離だけで表現できるため、この方式を採った
- **動的パラメータを取る `resolve()` 呼び出し（例: `resolve('/(app)/reviews/[id]',
{ id })`）だけ、ルートグループ名 `(app)` を含む RouteId 形式を渡す**。
  SvelteKit の型生成では、`resolve()` にパラメータを渡す場合は route group を
  含む RouteId が要求される一方、パラメータなしの呼び出しは実際の URL
  （`/reviews` 等、group 名を含まない Pathname）を渡す形になる。書き分けが
  必要になる分かりにくさは残るが、型チェック（`svelte-check`）に守られるため
  誤ったパスのまま気付かず本番に出ることはない

## タイトル・本文の全文検索 (#28)

- **スコープをタグ機能と分離し、全文検索のみを今回対応する**。#28 は「タグ機能一式」
  「全文検索」の2本柱を持つが、それぞれ独立に価値を出せる。タグはテーブル追加・
  多対多・作成/編集 UI・絞り込み UI と変更範囲が広いため別 Issue に切り出し、
  「タグごとの間隔プリセット変更」の検討も見送った（Issue 本文でも「検討」止まり）
- **FTS5 の trigram トークナイザ + 仮想テーブルは検討・実装した上で不採用にし、
  最終的に `memos.title LIKE ? OR memos.content LIKE ?`（プレーンな TEXT カラム
  への LIKE）を採用した**。理由: プレーンな `LIKE '%...%'` はトークナイザ無しで
  常に文字単位の部分一致を行うため、日本語の単語境界問題も3文字未満クエリの
  問題も最初から発生しない。FTS5/trigram が要る理由は無かった。
  検証の経緯（再現コストが高いため記録する）: trigram を `MATCH` で使うと
  クエリが3文字未満（"D1" や2文字の日本語単語）のとき常に0件になることを実機
  (`sqlite3` CLI) で確認 → `MATCH` の代わりに trigram 索引を使う `LIKE` 検索を
  一度実装した → しかし既存の `likePattern` が付与する `ESCAPE '\\'` 付きの
  3引数版 `LIKE` は SQLite のプランナーによって FTS5 の `xBestIndex` への
  プッシュダウン対象外になり（`EXPLAIN QUERY PLAN` の `idxStr` が `ESCAPE`
  無しでは `L0`＝索引利用、有りでは空＝フルスキャン）、索引が一切使われて
  いないことが判明した（同期用トリガーを no-op にしても検索結果が変わらない
  ことで確認）。索引を使わないなら FTS5・仮想テーブル・3本の同期トリガー・
  専用マイグレーションを維持する理由が無いため、全て撤去し現在の実装
  （`apps/web/src/lib/server/memos.ts` の `memoSearchCondition`）にした。
- **性能はスコープ外**。単一ユーザー・メモ数が少ない現段階では、`memos` への
  フルスキャン LIKE で十分と判断した。メモ件数が増えて実際に遅さが問題になった
  時点で改めて索引方式を検討すること。ただし FTS5 trigram を `ESCAPE` 無しの
  `LIKE`/`GLOB` で使う場合も、索引が有効に働くのは3文字以上のワイルドカード
  無しパターンに対してのみ（`%`/`_` の literal 化に `ESCAPE` を使うと今回と
  同じ理由で索引を失う）という制約があり、1〜2文字クエリの高速化にはならない
  点に注意
- **検索結果一覧のスニペット表示（一致箇所のハイライト）は対象外**。一覧の抜粋
  （`excerptOf`）は本文冒頭 80 文字程度を返す既存仕様のままで、本文の途中一致は
  一覧上で視認できない。この非対応は今回意図的な範囲外であり、見落としではない

## オンボーディング（iOS のホーム画面追加案内を含む） (#24)

- **iOS Safari 向けの案内文言は、実機を持っていないため公開情報の記録に留めた**
  （`docs/pwa-notification-receive.md` の #9 節と同じ制約・同じ運用）。iOS/iPadOS
  16.4 で Web Push がホーム画面追加済みの Web App にのみ対応する形で追加されて
  いる、という WebKit 公式ブログの記述を根拠に「ホーム画面未追加の iOS Safari
  では常に案内を出す」という単純なルールにした。ホーム画面未追加時に実際に
  `PushManager`/`Notification` がどう見える（API 自体が存在しないのか、
  存在するが `subscribe()` が例外を投げるのか）かは実機で確認していないため、
  iOS の判定はプラットフォーム判定（UA・`navigator.standalone`）を主に使い、
  「push 機能自体が使えるか」の判定（`serviceWorker`/`PushManager`/
  `Notification` の有無）はその他のブラウザ（非対応の旧ブラウザ等）向けの
  フォールバックとしてのみ使う（`$lib/platform-detect.ts` の `detectPlatform`）
- **iPadOS 13+ の Safari は UA が "Macintosh" になり iPhone/iPad と判別できない**
  ため、`navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1`
  （タッチ対応の Mac）を iPad とみなすフォールバック判定を追加した。デスクトップ
  Chrome（`--persistent` プロファイル）では `maxTouchPoints` が 0 のため
  誤判定しないことを確認済み
- **ユーザーが普段使うのは Android のため（`docs/pwa-notification-receive.md`
  参照）、Android は「案内なしで通知ボタンのみ」にはせず、ホーム画面追加を
  促す控えめな一文（アプリのように使えるという案内。必須ではない旨を明記）を
  併記する**。Chrome for Android は `beforeinstallprompt`/インストールなしの
  通常タブでも Web Push が機能するため、iOS のような「未対応なら通知ボタン自体
  を隠す」対応は行わず、通知ボタンは常に表示する
- **オンボーディング表示要否の判定（`user_settings.onboarding_seen_at`）は
  `(app)/+page.server.ts`（ホームの load）でのみ行い、`(app)/+layout.server.ts`
  には入れなかった**。理由: (1) レイアウトに入れるとクライアント側遷移のたびに
  D1 への SELECT が挟まり、Free プランの CPU 10ms/リクエスト制約に無関係な
  負荷を足す。(2) 通知クリック等の深いリンク（`/reviews/{id}`）から来た
  ユーザーの遷移先をオンボーディングが奪ってしまう。ホームの load でのみ
  判定することで両方を避けたが、副作用として「ログイン後に一度もホームへ
  行かず別ページへ直接アクセスしたユーザー」にはオンボーディングが表示され
  ない（ログイン成功後の既定リダイレクト先は `/` のため、通常はこの経路を通る）
- **列名は `onboarding_completed_at` ではなく `onboarding_seen_at` にした**。
  「スキップ」と「完了（購読まで済ませた）」を区別する必要はなく、どちらも
  「以後は自動表示しない」という同じ効果を持つ。`completed` は前者を暗に
  「未完了」のように読ませてしまうため、実態に合わせて `seen` にした
- **既存ユーザーは移行マイグレーション（`0011_chubby_victor_mancha.sql`）内で
  一括バックフィル（`onboarding_seen_at` に移行時刻を設定）した**。この機能の
  リリース前から使っているユーザーを、次回アクセス時に一律オンボーディングへ
  送るのは体験として不適切と判断した。新規ユーザー（移行後に作成される行）は
  バックフィル対象にならないため、通常どおりオンボーディングが表示される
- **通知が無効なまま使っているユーザーへの控えめなリマインド（ホーム画面上部の
  バナー）は、`Notification.permission` に加えてブラウザ側の実購読の有無
  （`pushManager.getSubscription()`）まで見て判定する**。`permission ===
'granted'` だけで「有効」とみなすと、購読の 410 Gone 削除（要注意点9）で
  サーバー側の行が消えたのに端末側は「許可済み」のまま気づけないケースを
  見落とす。一方、サーバー側の `push_subscriptions` レコードがこの端末の
  ものと一致するかまでは確認しない（所有権の再確認は、設定画面と同じく
  ユーザーが実際に有効化ボタンを押したときにのみ行う既存方針を踏襲した）。
  リマインドは `denied` のときは出さない（設定画面に既にブロック時の案内が
  あり重複するため）。「あとで」を押すと `localStorage` に記録し、3日間は
  再表示しない
- **設定画面の通知有効化ロジック（許可ダイアログ→`serviceWorker.ready`→
  `subscribe()`）を `$lib/push-subscribe.ts` の `requestPushSubscription`
  に切り出し、オンボーディング画面と共有した**。ブラウザ API の呼び出し順序
  という間違えると壊れやすい部分だけを共通化し、状態表示・エラーメッセージ・
  保存先アクション（ルートごとにパスが異なる `?/subscribePush`）は
  各ページに残した
- **`playwright-cli run-code` の `page.addInitScript` で `navigator.userAgent`/
  `navigator.standalone` を上書きし、iOS（ホーム画面未追加・追加済みの両方）・
  Android の各分岐を実際のブラウザで確認した**（実機は用意できないため、
  UA 偽装による近似検証）。`display-mode: standalone` は `--persistent`
  プロファイルの実 Chrome でも `matchMedia` は素通しで確認でき、iOS の
  `navigator.standalone` 偽装と合わせて「ホーム画面から起動した場合は案内が
  出ない」受け入れ条件を確認した

## メモのプリセット変更時に復習予定を再計算する (#82)

- **#18 が編集画面へのプリセット切替 UI をスコープ外にし、`updateMemo` が
  `intervalPresetId` を変更しても reviews を再計算しない制約として先送りした
  ものへの対応**（`docs/design-decisions.md` の #18 節を参照）。#74 で編集画面に
  `IntervalPresetChips` が実装されて以降、この不整合は API 直叩きに限らず
  通常の編集画面操作でも到達可能になっていた。
- **`updateMemo` から `intervalPresetId` を完全に除去し、`changeMemoPreset` を
  新設した**。`UpdateMemoInput` は title/content のみを受け付け、reviews に一切
  触れない。`changeMemoPreset` は intervalPresetId が実際に変わる場合にのみ
  `$lib/server/reviews.ts` の `planReviewRecalculation`（#18 のレシピをそのまま
  再利用）を呼び、memo の UPDATE と reviews の DELETE/INSERT を同じ `db.batch()`
  で実行する。編集フォームは常に intervalPresetId を送るため、値が変わって
  いない場合は reviews に触れないことを `changeMemoPreset` 側の比較で保証する
  （呼び出し側でフィールドの有無だけを見て分岐すると、この判定ができない）。
- **`/api/memos/[id]` の PATCH は、リクエストボディに `intervalPresetId` が
  含まれるかどうかで `updateMemo`／`changeMemoPreset` を呼び分ける**。含まれない
  場合は title/content のみの更新として扱い、reviews には触れない。
- **memo の楽観ロックと reviews の再計算を2段階に分けた**（正確性レビューで
  指摘、advisor 相談の上で採用）。プリセットが実際に変わる場合、
  1. memo の UPDATE だけを先に確定させ、2) その UPDATE が実際に勝った場合に
     のみ、reviews の再計算（DELETE+INSERT）を別の `db.batch()` で実行する。
     UPDATE が負けた（0行）場合、reviews には一切触れずに `ConflictError` を返す
     ——これが本来欲しかった保証そのものであり、これ以上の仕掛けを要さない。
  - **当初は memo の UPDATE と reviews の DELETE/INSERT を同じ `db.batch()`
    にまとめ、`completeReview`（#17）の `wonThisCompletion` と同じ形の EXISTS
    ガードを DELETE 文に組み込む設計だった**。しかし `db.insert(reviews)
.values(...)` は VALUES 直接挿入のため WHERE 句を持てず、ガードは DELETE
    にしか適用できなかった。UPDATE が負けた場合に DELETE も0行になり、既存の
    未完了 reviews が残ったまま後続の INSERT が同じ step 番号と衝突する
    （unique 制約違反でバッチ全体がロールバックされる）ことに「たまたま」
    頼る設計であり、完了済みステップ数と新旧 intervals の組み合わせ次第では
    （未完了行が0件で、負けた側の新ステップ番号がどの既存行とも重ならない
    場合）衝突が起きず、負けたリクエストの reviews 再計算が静かに成功して
    しまうバグが正確性レビューで発見・再現された。`memos.test.ts` の
    「does not silently apply a losing preset change even when no
    unique-constraint collision would occur」で固定化した。
    `db.insert(reviews).select(...)` や生SQLの `INSERT ... SELECT ... FROM
(VALUES ...) WHERE ...`（`db.run()` 経由）による INSERT 側のガードも
    検討したが、D1 の `batch()` は各文が `._prepare()` 由来の実 prepared
    statement（`.stmt` を持つ）であることを前提にしており、`db.run(sql\`...\`)`が返す`SQLiteRaw` はその要件を満たさず実行時エラーになることを確認した
    ため、2段階方式へ変更した。
    - この設計変更の過程で、EXISTS ガードの判定条件自体にも別の欠陥があった
      ことが判明した: 初版は「DB 上の intervalPresetId が変更先の値と一致
      しているか」でガードしており、同じ変更先プリセットへの二重送信
      （多重タブ・二重クリック）で、負けたリクエストから見ても「DB は既に
      変更先の値になっている（＝勝ったリクエストが書き込んだ値）」ため、
      ガードが誤って真になっていた（`completeReview` が `completedAt = new
Date()` という各呼び出し固有の値を使うのに対し、ユーザー入力値という
      「複数リクエストが同じ値を狙いうる」ものをガードに使ってしまっていた
      のが根本原因）。2段階方式では memo の UPDATE 自体の楽観ロック（
      `expectedUpdatedAt` との一致）だけが勝敗を決めるため、この種の判定
      ミスは構造的に起こり得ない。
  - **残るリスクは、1) の memo UPDATE が成功した直後・2) の reviews
    再計算実行前に、別リクエストの `completeReview` が割り込み、2) が
    unique 制約違反で失敗するごく狭い窓のみ**。この場合、この呼び出し自身の
    書き込み（`thisChangeStamp` という呼び出し専用のタイムスタンプを
    `updatedAt` に明示的に SET したもので識別）がまだ現在の値である場合に
    限り、1) で確定させた title・content・intervalPresetId **全フィールド**を
    呼び出し前の状態へ復元してから `ConflictError` を返す（他の誰かが既に
    このメモを更に更新していた場合は、その更新を上書きしないよう復元しない）。
    この残存レースは `updateCustomPresetIntervals`（#18）の
    `stillActiveMemoIds` が持つのと同種の「完全な排除はできないが窓を狭める」
    設計として許容する。
    - **初版は intervalPresetId だけを復元しており、正確性レビューで指摘された
      部分適用バグが残っていた**。編集画面は title・content・intervalPresetId を
      常にまとめて送るため、この2)の失敗経路では「409 を返したのに、同じ
      呼び出しで確定していた title・content の変更だけは静かに保存される」
      という、呼び出し元の期待（409＝何も反映されていない）に反する状態が
      生じ得た。復元対象を全フィールドに広げて修正した。
- **上記の unique 制約違反を `ConflictError`（409）に変換する** —
  `planReviewRecalculation` の SELECT（完了済みステップ数の読み取り）と
  `db.batch()` 実行の間に別リクエストの `completeReview` が割り込む競合
  （`updateCustomPresetIntervals` と同種の SELECT-then-write ハザード）でも
  同じ違反が起こりうるため、`isUniqueConstraintViolation` で捕捉して 409 に
  変換する（advisor 指摘）。この経路は `interval-presets.test.ts` の
  「translates a concurrent completion race into a ConflictError」と同型の
  `db.batch` 横取りで `memos.test.ts` にも回帰テストを追加した（テスト網羅性
  レビューで指摘）。
- **プリセット変更時、新しいプリセットの `intervals` が空の場合は拒否する**
  （`createMemo` の空プリセットガードと同じ理由。#18 時点でこの検証を持たない
  空プリセットが既に存在し得るため、advisor 指摘によりここでも確認する）。
- **reviews.ts に残っていた「`updateMemo` は reviews を再生成しない」前提の
  コメント（`minPendingScheduledAtSubquery`・`getDueReviewDetail`・
  `completeReview` の3箇所）を、`changeMemoPreset` 導入後の実態に合わせて
  書き換えた**（advisor 指摘）。これらのコメントが説明していた「min(scheduledAt)
  と min(step) の不一致」「プリセット短縮時の再アンカリング不能」という不整合
  自体は、#82 以前に古い `updateMemo` でプリセットが変更された既存メモに対しては
  引き続き起こり得るため、フォールバック処理自体は削除せず残した（`completeReview`
  の `reanchorUpdates` フィルタ等）。コメントだけを「Web UI からは到達しない」
  という古い（#74 以降は誤りだった）前提から「#82 より前のデータに限られる」
  という正しい前提に更新した。これに合わせて、`reviews.test.ts` の該当テストは
  `changeMemoPreset` ではなく直接 `db.update(memos)` でこの不整合状態を再現する
  よう変更した（`changeMemoPreset` 経由ではこの状態を作れないため）。
  （`minPendingScheduledAtSubquery` 自体は #83 で `isCurrentPendingReview` に
  統合され削除された。）
- **`updateMemo`・`changeMemoPreset` に一字一句同じ形で重複していた「0行
  だった理由（対象消失 vs バージョン競合）の判別」ロジックを `resolveUpdateResult`
  として共通化し、`ChangeMemoPresetInput` を `UpdateMemoInput` を拡張する形に
  変更した**（設計レビューで指摘）。

## 現在の未完了 review の定義を一元化する (#83)

- **「各メモで最小 step の未完了 review」という同じ業務ルールが、Web一覧
  （`min(step)` の groupBy サブクエリ＋JOIN）・メモ一覧（`min(scheduledAt)` の
  groupBy サブクエリ＋JOIN）・メモ詳細（step 昇順配列への `find()`）・
  `assertIsCurrentStep`（`min(step)` を返す独立したスカラー select）・
  scheduler（相関 `NOT EXISTS`）という5通りの別実装で存在していたことへの
  対応**。#82 のリファクタで「`min(scheduledAt)` と `min(step)` が異なる行を
  指しうる」不整合（プリセット変更後、再アンカリング未実施の古いステップが
  残るケース）が発見されており、その解消も兼ねる。
- **`packages/db/src/current-reviews.ts` に `isCurrentPendingReview(db)` という
  共有述語（相関 `NOT EXISTS` を使う Drizzle の SQL 条件）を新設し、5箇所すべてを
  これに置き換えた**。schema.ts が持つ `reviews(memoId, step)` の unique 制約により、
  この述語が真になる行はメモごとに高々1件である。
  - **配置先は `packages/db`**（`apps/web` と `apps/scheduler` の双方が依存できる
    唯一のパッケージであるため）。DB view にする案も検討したが、Issue の
    受入条件「due・通知済み・アーカイブ状態・所有者など用途固有の条件は
    利用側で追加する」を満たすには、呼び出し側が自由に `and()` で条件を
    追加できる「WHERE/JOIN 条件としてANDできる述語」の形の方が合う（view だと
    用途ごとに view 自体を分けるか、view の外でさらに絞り込む形になり、
    どちらも「中核実装が一か所」という条件と相性が悪い）ため見送った。
  - **`min(step)` の groupBy＋JOIN ではなく相関 `NOT EXISTS` を正とした**。
    groupBy 方式は「メモごとの最小 step」を1行だけ持つサブクエリを作り、
    本体クエリと `(memoId, step)` の両方一致で INNER JOIN する必要があるが、
    NOT EXISTS 方式は他の WHERE 条件と同じ粒度で `and()` に混ぜられる
    boolean 条件になり、`listMemosForBrowse` のように LEFT JOIN の結合条件へ
    直接組み込む用途にも自然に使える。
  - **due 判定（`scheduledAt <= now`）はこの述語の外で行う**という不変条件
    （advisor 指摘、#17 由来）は、述語を再利用可能にしたことでより壊れやすく
    なる（将来の呼び出し側が誤って述語の内側に due 条件を混ぜると、期限前の
    若い step を飛ばして期限切れの後続 step を current 扱いしてしまう）ため、
    その注意書きを `isCurrentPendingReview` 自体のコメントに移した。この不変条件の
    回帰テストは `apps/web` 側（`reviews.test.ts` の「does not surface a later step
    even if it is also due while an earlier step remains incomplete」、#83以前から
    存在）にはあったが scheduler 側には無かったため、同じ形（期限前の step0・
    期限到来済みの step1）のテストを `notify-due-reviews.test.ts` にも追加した
    （テスト網羅性レビューで指摘）。
  - **相関先は alias されていない `reviews` テーブル固定**。呼び出し側が
    outer query で `reviews` を alias している場合はこの述語を使えない
    （現状そのような呼び出しは無い）。
- **`apps/web/src/lib/server/reviews.ts` に `getCurrentPendingReview(db, memoId)`
  を新設し、メモ詳細画面の `nextStep`/`isNext` 判定と `assertIsCurrentStep`
  の両方から使う**。メモ詳細画面は従来 `listReviewSchedule` が返す step 昇順
  配列に対する `schedule.find((row) => row.completedAt === null)` という
  TypeScript 側の実装を持っていたが、これは「中核実装が一か所になる」という
  受入条件に反するため、共有述語を使う SQL クエリに置き換えた。
- **`listMemosForBrowse` の `nextScheduledAt` は、旧 `min(scheduledAt)`
  サブクエリではなく `isCurrentPendingReview` を結合条件にした `reviews` への
  LEFT JOIN から取る**よう変更した。これにより `reviews.scheduledAt`
  （timestamp 型）をそのまま返せるようになり、旧実装が必要としていた
  「raw SQL の `min()` はエポックミリ秒で返るため呼び出し側で `Date` に変換する」
  という手動デコードが不要になった。
  - **挙動変化がある**: プリセット変更後に再アンカリングされていない古い
    reviews が残るメモでは、`nextScheduledAt` が「一番早い未完了 scheduledAt」
    ではなく「最小の未完了 step の scheduledAt」に変わる（Issue の受入条件
    「後続 step の scheduledAt が早くても前の step を追い越さない」）。
    回帰テストは `memos.test.ts`・`reviews.test.ts` の両方に、`scheduledAt` の
    大小関係を意図的に逆転させたフィクスチャで追加した。
- **重複実装の同期を求めていた既存コメント**（`reviews.ts` の
  `minPendingStepSubquery` 直前にあった「apps/scheduler/src/notify-due-reviews.ts
  もこの条件を変更するときは両方確認すること」という注記）は、実装が1箇所に
  統合されたことで削除した。

## プリセット更新時の review 再計算を一括取得方式にする (#84)

- **背景**: `updateCustomPresetIntervals`（プリセット確定操作）・
  `previewPresetIntervalsUpdate`（プレビュー）は、対象メモ1件につき
  `planReviewRecalculation` を呼び、1メモあたり3 SELECT（memo作成日時・最新の
  完了済み step・未完了件数）を発行していた。対象メモ数に比例してクエリ数が
  増えるため、Cloudflare Workers / D1 の CPU・クエリ負荷が対象メモ数に応じて
  線形に増加していた。

- **`$lib/server/reviews.ts` を「DB アクセスなしの純粋関数」「1件ずつ取得する
  経路」「一括取得する経路」の3つに分離した**:
  - `computeReviewRecalculation(memoId, input, intervals)`: #18 の再計算レシピ
    （baseTime の決定・新しい未完了行の生成）を DB アクセスなしで計算する純粋
    関数。入力（`MemoRecalcInputs`: `createdAt`・`latestCompleted`・
    `incompleteCount`）をどう取得したか（1件ずつ／一括）に依らず同じ結果を返す。
  - `buildReviewRecalculationStatements(db, memoId, newRows)`: 純粋関数が返す
    `newRows` から実際に `db.batch()` へ積む DELETE/INSERT 文を組み立てる
    （メモ1件あたり最大2文という既存の上限は変えていない）。
  - `planReviewRecalculation(db, memoId, intervals)`: `changeMemoPreset`
    （#82、常に対象メモ1件）向けに残した、従来どおり1件分の SELECT を発行してから
    上記2つを呼ぶ経路。挙動・シグネチャは変更していない。
  - `loadReviewRecalculationInputs(db, memoIds)`: `updateCustomPresetIntervals`・
    `previewPresetIntervalsUpdate`（#84 で追加）向けの新しい一括取得経路。対象
    メモ数に依らず常に3クエリ集合（`memos` の作成日時・完了済み `reviews`・
    未完了件数の GROUP BY、いずれもチャンク分割込み）で完了する。`Map<memoId,
MemoRecalcInputs>` を返し、見つからなかった memoId は含めない（後述）。

- **プレビューと確定処理が同じ集計・計画生成ロジックを共有する**（受入条件）。
  両者とも `collectAffectedMemoIds` → `assertWithinBatchStatementLimit`
  （悲観的見積もりによる早期拒否、#18 で導入した順序を維持） →
  `loadReviewRecalculationInputs` → `computeReviewRecalculation` という同じ経路を
  通る。異なるのはその先で、プレビューは `affectedCount` を合計するだけ、確定
  操作は `buildReviewRecalculationStatements` で文を組み立てて `db.batch()` を
  実行する。プレビュー側で `newRows`（Drizzle の insert/delete ビルダーではなく
  ただのプレーンオブジェクトの配列）は計算するが、確定操作に必要な Drizzle
  文自体は組み立てない（advisor 指摘。件数だけが必要なリクエストで最大249件分の
  未使用ビルダーを作らないため）。

- **`loadReviewRecalculationInputs` の完了済み行の集約は、SQL の
  `max(step)`/`max(completedAt)` の別々の集約ではなく、JS 側で「同じ行から
  取った」ことを保証する**（advisor 指摘）。「最新の完了済みステップの
  `completedAt`」が常に「同じ行の `completedAt`」であることは、step と
  completedAt が単調に対応するという #17 の不変条件に依存した前提であり、
  別々の集約はこの前提を検証せず、#82 より前の不整合な既存データ
  （`changeMemoPreset` のコメントが記録している既知の不整合）に対して誤った
  baseTime を返しうる。

- **`loadReviewRecalculationInputs` が対象 memoId の一部しか返さない場合、
  呼び出し側は静かにスキップする**。この実装に memo のハード削除機能は無く、
  対象は必ず `collectAffectedMemoIds` が直前に返した非アーカイブメモの id で
  あるため理屈上は常に全件見つかるが、見つからなかった場合は
  `stillActiveMemoIds` ガード（#18、途中でアーカイブされたメモの除外）と同じ
  「対象から除外する」扱いにした。エラーにしない。

- **`queryInChunks`／`chunk`／`D1_MAX_BIND_PARAMS`（#18 で `interval-presets.ts`
  に追加したチャンク分割ヘルパー）を `$lib/server/db-chunk.ts` へ切り出した**。
  `reviews.ts` の `loadReviewRecalculationInputs` も同じチャンク分割が必要になり、
  `interval-presets.ts` から `reviews.ts` を import する既存の依存方向を保ったまま
  両方から使うには、どちらのファイルにも属さない共有モジュールが必要だった。

- **既存のプリセット更新テストが通ることを確認した上で、`updateCustomPresetIntervals`
  内部の関数呼び出しを横取りしていた1テストだけ再フック先を変えた**。
  「対象メモの列挙後・アーカイブ再確認前にアーカイブが割り込む」回帰テスト
  （`interval-presets.test.ts`）は、対象メモごとに1回ずつ呼ばれていた
  `planReviewRecalculation` を横取りして内部で `archiveMemo` を呼ぶことで
  タイミングを再現していたが、確定操作はもう `planReviewRecalculation` を
  呼ばないため、代わりに一括取得を行う `loadReviewRecalculationInputs`
  （呼び出し回数は対象メモ数に依らず1回）を横取りする形に変更した。検証内容
  （アーカイブされたメモの reviews が0件のまま・他のメモは正しく再計算される）
  自体は変えていない。

## review スケジュールにバージョンを導入して競合を検出する (#85)

- **背景**: プリセット再計算（`changeMemoPreset`・`updateCustomPresetIntervals`）
  は、計画作成用の SELECT から `db.batch()` 実行までの間に review 完了・メモの
  アーカイブ・別のプリセット変更が割り込む競合窓を持っていた。#82・#84 時点では
  この窓を「unique 制約違反への偶発的な衝突」に頼って検出しており、完了済み
  ステップ数と新旧 intervals の組み合わせ次第では衝突すら起こらず、古い
  スナップショットに基づく再計算が静かに成功してしまうケースが正確性レビューで
  発見・再現されていた（#82 節を参照）。

- **version の所有先は memo の列ではなく専用テーブル `review_schedules`
  （`memo_id` 1:1 の PK、`version` 整数）にした**。理由は実測で確認した
  drizzle-orm の挙動: `buildUpdateSet`（`sqlite-core/dialect.js`）は、
  `$onUpdate` を持つ列を `.set()` に明示的に含めなくても、その UPDATE 文の
  SET 句へ自動的に追加する。`memos.updatedAt` は `$onUpdate` を持つため、
  version を memos の列にすると、`completeReview` が version を進めるたびに
  `memos` テーブルへの UPDATE が発生し、`updatedAt` が意図せず更新されてしまう。
  これは `changeMemoPreset`・`updateMemo` の楽観ロック（`expectedUpdatedAt`）を
  汚染し、他クライアントが読んでいた `updatedAt` を使った title/content の
  更新が、無関係な review の完了のたびに 409 になる回帰を生む（advisor 指摘、
  `memos.test.ts` の「does not conflict a title-only update with an updatedAt
  read before an unrelated review completion」で固定化）。専用テーブルに
  分離することで、この結合を構造的に排除した。
  - migration（`0012_uneven_jean_grey.sql`）では、既存メモ全件に
    `version = 0` の行をバックフィルする `INSERT ... SELECT` を追加した。
    以後の新規メモは `createMemo` が memos・reviews と同じ `db.batch()` で
    `review_schedules` 行（`version = 0`）も作るため、このテーブルは
    メモと常に1:1で存在する前提が成立する（delete-memo 機能が無いことに
    も依存する）。
  - **この1:1の前提には、migrate（新テーブル作成）から deploy（新しい
    `createMemo` への切り替え）が完了するまでの短い window（#7 節: この
    順序前提）という穴が残る**（正確性レビューで指摘）。この window に
    旧バージョンのコードで作られたメモは `review_schedules` 行を持たない。
    治癒しないまま version だけを 0 にフォールバックすると、以後の claim の
    bump 文（`WHERE memo_id = ? AND version = 0`）が対象行の不在によって
    恒久的に0件のままになり、そのメモの review 完了・プリセット変更が
    「一度だけ失敗する」ではなく永久に失敗し続けてしまう。`ensureReviewsExist`
    （memos.ts、#16 の reviews 欠落治癒）と同じ考え方で、`completeReview`・
    `planReviewRecalculation`・`loadReviewRecalculationInputs` の各読み取り
    箇所に `ensureReviewScheduleExists`（`version = 0` で `onConflictDoNothing`
    INSERT）を追加し、行が見つからなかった時点で治癒してから version 0 として
    扱うようにした。

- **不変条件**:「reviews への書き込み経路は、同じ論理操作内で
  `review_schedules.version` の CAS に勝った場合のみ書き込む」。これを
  `completeReview`・`changeMemoPreset`・`updateCustomPresetIntervals`・
  `archiveMemo` の4経路すべてに適用した。
  - **`completeReview`**: 冒頭の JOIN で対象メモの `review_schedules.version`
    も一緒に取得し、`completeCurrent`（対象ステップの completedAt を立てる
    UPDATE）の WHERE に「version が読み取り時のまま変わっていないか」の
    EXISTS 条件を追加した。別リクエストの claim（プリセット変更）が先に
    割り込んで version を進めていた場合、この UPDATE は0行になり、既存の
    「0行なら ConflictError」分岐がそのまま働く。加えて、この呼び出し自身が
    実際に完了させた場合（既存の `wonThisCompletion` ガードと同じ形）に限り
    version を1進める文を同じ `db.batch()` に追加した。これにより
    `completeReview` 自身も「reviews の状態を変える書き込み」として version
    を進める側に回る。
  - **`changeMemoPreset`・`updateCustomPresetIntervals`**: DELETE（未完了
    reviews）+ version bump を「claim」として1つの `db.batch()` にまとめ、
    bump の `.returning()` で勝敗を判定してから、勝った場合にのみ別の
    呼び出しで新しい行を INSERT する2段階方式にした（#82 で確立した
    「memo の UPDATE を先に確定させ、勝った場合にのみ reviews を再計算する」
    という2段階の考え方を、reviews の再計算そのものにも適用したもの）。
    INSERT 文自体に WHERE を持たせて version を検証することはできない
    （D1 の `batch()` が `INSERT ... VALUES` への WHERE 付与や、それに代わる
    guarded な生 SQL INSERT の実行を許さないことは #82 で確認済み）ため、
    「DELETE + bump が勝ったことを確認してから INSERT する」という順序上の
    分離が唯一の実現手段になる。
  - claim のガード（`reviewScheduleVersionMatches`・`memoIsNotArchived`、
    `$lib/server/reviews.ts`）は、version の列を直接 WHERE に混ぜるのではなく
    EXISTS で包む必要がある。実装時に一度、DELETE 文（`reviews` テーブルが
    対象）の WHERE へ `review_schedules` の列をそのまま条件式として混ぜた
    ところ、`review_schedules` がその文の FROM/JOIN に無いため
    "no such column: review_schedules.memo_id" という D1 エラーになった
    （実機で確認）。UPDATE 対象のテーブル自身の列であれば直接条件式に書けるが、
    それ以外の文からは EXISTS 経由でしか参照できない、という drizzle/SQL の
    制約に注意が必要。
  - アーカイブ済みメモの除外は version の一致だけでは保証できない: version を
    読み取った時点より後にアーカイブされた場合、その読み取り自体が既に
    アーカイブ後の状態であれば version は「一致している」ように見えてしまう。
    アーカイブは一方向（un-archive しない）操作のため、claim 評価時点の
    `memos.archivedAt` を毎回ライブに確認する EXISTS 条件を version チェックと
    独立に持たせることで、読み取りタイミングに関わらず確実に除外できる
    （advisor 指摘、`interval-presets.test.ts` の既存回帰テストで検証）。
  - **`updateCustomPresetIntervals`（複数メモ対象）固有の追加考慮**:
    `updatePresetStatement`（プリセット自体の `intervals` 列 UPDATE）は
    メモ単位のガードを持てず、claim の勝敗に関わらずこのプリセットを使う
    全メモに適用される。そのため、claim に負けたメモのうち「アーカイブされた
    から対象外」以外の理由（version 不一致 = 別の書き込みが割り込んだ）で
    負けたメモが1件でもあれば、この操作全体を `ConflictError` として拒否し、
    プリセットの UPDATE・勝った memo 分の INSERT を一切実行しない
    （advisor 指摘）。実行してしまうと「プリセットの intervals だけが
    更新され、負けたメモの reviews は古い intervals のまま」という恒久的な
    不整合が「成功」として返ってしまう。
    - **この結果、claim（DELETE + bump）で既に削除された「勝った」メモの
      未完了 reviews は、直後に ConflictError で操作全体を止めても元に戻らない
      残存リスクとして残る**（claim の DELETE は既にコミットされた別の
      `db.batch()` であり、後から取り消せない）。この状態は破損ではなく、
      再実行すれば `computeReviewRecalculation` が「削除された未完了行」に
      依存せず `latestCompleted`（完了済み行）だけから再計算できるため回復可能
      （advisor 指摘）。#82 の「残るリスク」と同種の、狙って完全には排除しない
      残存窓として受容する。
    - `MAX_STATEMENTS_PER_MEMO` は claim（DELETE 1 + version bump 1）+
      INSERT 1 の3文になり、#84 時点の2文（DELETE + INSERT）から増えた。
      `MAX_BATCH_STATEMENTS`（500）が許容する最大メモ数は、悲観的見積もりで
      249件（#84）から166件に変わった。
    - claim に負けたメモを再確認するための別クエリ（旧 `stillActiveMemoIds`）
      は、claim 自身のガードが対象メモの `archivedAt` を直接見るようになった
      ことで不要になった（advisor 指摘）。
    - **claim の結果配列を読む際、DELETE 文をまとめて先に積み、bump 文をまとめて
      後に積む形にした**（初版は `[DELETE, bump]` のペアを `flatMap` で交互に
      積み、`claimResults[i * 2 + 1]` という暗黙のストライドで bump 結果を
      読んでいたが、積む側・読む側の2箇所に同じレイアウト知識が分散する
      設計になっていた。設計レビューで指摘）。bump 文は `.returning({ memoId })`
      で自分の memoId 自身を返すため、結果を読む側は位置ではなく返ってきた
      memoId の値から勝者集合を作れる。各メモの DELETE が自分の bump より先に
      実行される必要があるが、メモ同士は独立な行を操作するため「全 DELETE →
      全 bump」の順序に変えても各メモの整合性は保たれる。

- **`isUniqueConstraintViolation` による 409 変換は backstop として残した**が、
  主たる検出手段ではなくなった。claim に勝った直後・INSERT 実行前のごく狭い窓
  （2段階方式のため完全には排除できない、#82 節が記録する残存レースと同種）に
  限り、DB 制約エラーからの変換に頼る。#82 で発見された「非overlapping な
  step 番号のため unique 制約にすら頼れず静かに成功する」ケースは、version の
  CAS が主たる防御線になったことで、`memos.test.ts` の
  「does not silently apply a losing preset change even when no
  unique-constraint collision would occur」がそのまま検出できる
  （このテスト自体は実際には #82 由来の `updatedAt` 楽観ロックで先に
  弾かれる別経路だが、version CAS 経由の同種の競合は新規追加した
  「detects a stale changeMemoPreset claim even when a concurrent bulk
  preset update races in」で検証している。`updateCustomPresetIntervals` は
  memos.updatedAt に触れないため、この経路の検出は version CAS のみに
  依存する）。
