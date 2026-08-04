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
  `pnpm --filter @ebb/web run deploy && pnpm --filter @ebb/scheduler run deploy` にした**。
  `--if-present` はスクリプト名の typo を静かに成功させる（#1 の罠と同じ）が、
  `lint`/`test` と違い `deploy` でこれを踏むと「本番に反映されていないのに CI が緑」になる
  ため実害が大きい。`db:migrate:local` と同じ `--filter` 明示 + `&&` 連結パターンに揃えた
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
  （`wrangler whoami --json`）を追加した**。`CLOUDFLARE_API_TOKEN` の期限切れは、
  何も対策しないと migrate/deploy ステップの中で他のエラーに紛れて発生し、原因の切り分けが
  遅れる。認証だけを切り出して build より前に検証することで、期限切れなら
  「Verify Cloudflare authentication」というステップ名で明確に失敗させる
  - `wrangler whoami`（`--json` なし）は未認証でも exit code 0 になることがあるため
    使わない。`--json` は「未認証なら non-zero exit」と明記されており、実機でも
    non-zero exit を確認済み
  - スコープは「トークンの期限切れ／無効」の検知のみ。`CLOUDFLARE_ACCOUNT_ID` の
    取り違えや、トークンは有効だが D1/Workers Routes の権限が不足しているケースは
    `whoami` では検知できず、引き続き `Migrate production D1` / `Deploy` ステップで
    初めて失敗する

## 開発の進め方

- リポジトリ: public
- Issue の粒度: 1 Issue = 1 PR（半日〜1日程度）
- **Web Push の技術検証（M1）を認証やメモ機能より先に置く**
  → このプロジェクトで最も不確実性が高い箇所であり、
  ここで想定外の壁に当たると設計全体に影響するため。
  認証・CRUD は手順が確立した定型作業なので後に回してもリスクが増えない
