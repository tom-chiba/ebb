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
   - #8 で `@block65/webcrypto-web-push` の採用を確定した。legacy な
     `aesgcm` 実装だが、2026 時点の Chrome / FCM では実際に受理・復号・表示
     されることを実測済み（詳細は `docs/web-push-spike.md`）
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
   → Playwright の `storageState` にセッションを注入する方式にする
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
  （モノレポの土台 #1 の節）のため `packages/db` から `packages/core` を import
  できず、逆方向（`packages/db` が `packages/core` の値を drift 検知に使う）は
  依存の向き（`apps/* → packages/*` のみ）に反する。`apps/web` 経由で検証する
  ことは可能だが、#15 のスコープを `packages/core`（と、schema.md が明示的に
  委ねた seed migration）に絞るため見送った。migration のコメントで
  `packages/core` を値の出所として明記するに留めている（既存の `0006` と同じ方式）

## 開発の進め方

- リポジトリ: public
- Issue の粒度: 1 Issue = 1 PR（半日〜1日程度）
- **Web Push の技術検証（M1）を認証やメモ機能より先に置く**
  → このプロジェクトで最も不確実性が高い箇所であり、
  ここで想定外の壁に当たると設計全体に影響するため。
  認証・CRUD は手順が確立した定型作業なので後に回してもリスクが増えない
