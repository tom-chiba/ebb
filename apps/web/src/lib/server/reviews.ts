import {
	and,
	asc,
	count,
	desc,
	eq,
	exists,
	gt,
	inArray,
	intervalPresets,
	isCurrentPendingReview,
	isNotNull,
	isNull,
	lte,
	memos,
	reviews,
	reviewSchedules,
	sql,
	type BatchItem,
	type Db
} from '@ebb/db';
import { nextReviewAt } from '@ebb/core';
import { queryInChunks } from './db-chunk';
import { excerptOf } from './excerpt';
import { ConflictError, isUniqueConstraintViolation, NotFoundError } from './errors';
import { clamp, normalizeOffset, type PaginationOptions } from './pagination';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

type ListOptions = PaginationOptions;

export interface DueReviewSummary {
	id: string;
	memoId: string;
	memoTitle: string;
	// ホームの一覧カードでの抜粋表示用。一覧クエリの時点で切り詰め、生の
	// memos.content（最大 50,000 文字）を呼び出し元に持ち出さない
	// （apps/web/src/routes/(app)/memos/+page.server.ts と同じ方針）。
	memoExcerpt: string;
	step: number;
	scheduledAt: Date;
}

export interface DueReviewDetail {
	id: string;
	memoId: string;
	memoTitle: string;
	step: number;
	// このメモの reviews 行の総数（完了済み + 未完了、「n 回目 / 全 m 回」表示用）。
	// intervalPresets.intervals.length ではなくこちらを正とする理由は totalSteps の
	// 計算箇所（getDueReviewDetail）のコメントを参照。
	totalSteps: number;
	scheduledAt: Date;
	memoContent: string;
	// 今この場で完了した場合に次のステップが再アンカリングされる予定時刻の事前計算。
	// completeReview と同じ nextReviewAt(baseTime, intervals, step) を使うため、実際に
	// 完了した際の値と（完了操作までの経過時間による分単位のずれを除き）一致する。
	// 次のステップが存在しない（このステップが最終ステップ）場合は null。
	previewNextScheduledAt: Date | null;
}

export interface CompletedReview {
	id: string;
	memoId: string;
	memoTitle: string;
	completedAt: Date;
	// このメモの残り未完了ステップが無くなった（全ステップ完了した）場合は null。
	nextScheduledAt: Date | null;
}

export async function listDueReviews(db: Db, userId: string, options: ListOptions = {}) {
	const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
	const offset = normalizeOffset(options.offset);
	const now = new Date();

	// アーカイブ済みメモの未完了 reviews は archiveMemo が削除するため理屈上は
	// 発生しないが、その不変条件は archivedAt を書く経路が archiveMemo のみである
	// ことに依存している（docs/schema.md）。ここでも明示的に除外し、依存しない。
	const where = and(
		eq(memos.userId, userId),
		isNull(memos.archivedAt),
		lte(reviews.scheduledAt, now),
		isCurrentPendingReview(db)
	);

	const [rows, totalRows] = await Promise.all([
		db
			.select({
				id: reviews.id,
				memoId: reviews.memoId,
				memoTitle: memos.title,
				memoContent: memos.content,
				step: reviews.step,
				scheduledAt: reviews.scheduledAt
			})
			.from(reviews)
			.innerJoin(memos, eq(reviews.memoId, memos.id))
			.where(where)
			// scheduledAt はミリ秒精度で同時刻の行が起こり得るため、id を tie-breaker にして
			// ページ間の順序を安定させる（#13 の listMemos と同じ理由）。
			.orderBy(asc(reviews.scheduledAt), asc(reviews.id))
			.limit(limit)
			.offset(offset)
			.all(),
		db
			.select({ total: count() })
			.from(reviews)
			.innerJoin(memos, eq(reviews.memoId, memos.id))
			.where(where)
			.all()
	]);

	// 呼び出し元（ホームのカード表示）は抜粋しか使わないため、ここで切り詰めて
	// 生の memos.content（最大 50,000 文字）を持ち出さない
	// （apps/web/src/routes/(app)/memos/+page.server.ts と同じ方針）。
	const items: DueReviewSummary[] = rows.map((row) => ({
		id: row.id,
		memoId: row.memoId,
		memoTitle: row.memoTitle,
		memoExcerpt: excerptOf(row.memoContent),
		step: row.step,
		scheduledAt: row.scheduledAt
	}));

	return {
		items,
		total: totalRows[0]?.total ?? 0,
		limit,
		offset
	};
}

export interface CurrentPendingReview {
	step: number;
	scheduledAt: Date;
}

// メモの「現在の未完了 step」（@ebb/db の isCurrentPendingReview が定義する不変条件、
// #83 で一元化した中核実装）を1件取得する。メモ詳細画面の nextStep 判定・isNext 表示、
// assertIsCurrentStep の両方がこれを使う。全ステップ完了済みなら undefined。
export async function getCurrentPendingReview(
	db: Db,
	memoId: string
): Promise<CurrentPendingReview | undefined> {
	const rows = await db
		.select({ step: reviews.step, scheduledAt: reviews.scheduledAt })
		.from(reviews)
		.where(and(eq(reviews.memoId, memoId), isCurrentPendingReview(db)))
		.limit(1)
		.all();
	return rows[0];
}

// 常に最小の未完了 step からのみ完了・閲覧できる（docs/schema.md が #17 に委ねた不変条件。
// #18 の再計算レシピが「完了済みステップ数を起点に」で成立することに依存している）。
// 一覧は常にこの条件を満たす行しか見せないため通常は到達しないが、review id を直接
// 指定した呼び出し（URL 直打ち等）に対する防御として、完了操作・詳細取得の両方で再検証する。
async function assertIsCurrentStep(db: Db, memoId: string, step: number) {
	const current = await getCurrentPendingReview(db, memoId);
	if (current?.step !== step) {
		throw new ConflictError('an earlier review step must be completed first');
	}
}

// getDueReviewDetail・completeReview の両方が使う「プリセットの intervals を id から取得する」
// クエリの共通化（設計レビューで指摘）。
async function getPresetIntervals(db: Db, presetId: string): Promise<number[]> {
	const presetRows = await db
		.select({ intervals: intervalPresets.intervals })
		.from(intervalPresets)
		.where(eq(intervalPresets.id, presetId))
		.limit(1)
		.all();
	return presetRows[0]?.intervals ?? [];
}

// getDueReviewDetail（プレビュー）・completeReview（実際の記録）の両方が使う、
// 「次ステップの行が見つかった場合にどの日時を返すか」の決定ロジックの共通化
// （設計レビューで指摘）。次ステップの行が無ければ「このメモの復習は完了する」
// （null）。行があれば、再アンカリング計算（nextReviewAt）が済んでいればその新しい
// 日時を、計算できなかった（プリセット短縮等で intervals[step] が存在しない）場合は
// 既存の scheduledAt を返す（プリセット短縮時にも #17 の「対象ステップの完了」自体を
// 失敗させない、という completeReview の既存の前提と同じフォールバック）。
// 共有しているのはこのフォールバック処理のみ。「次ステップの行が存在するか」自体の
// クエリ・取得方法は、呼び出し元が必要とするデータの形が異なるため（completeReview は
// 再アンカリング計算のため残り全ステップの一覧が別途必要）、各関数で個別に行っている
// （設計レビューで指摘: コメントが実態より広く「判定ロジックを共有」と書いていたのを訂正）。
function resolveNextScheduledAt(
	nextRow: { scheduledAt: Date } | undefined,
	reanchoredScheduledAt: Date | undefined
): Date | null {
	if (!nextRow) return null;
	return reanchoredScheduledAt ?? nextRow.scheduledAt;
}

export async function getDueReviewDetail(
	db: Db,
	userId: string,
	id: string
): Promise<DueReviewDetail> {
	const now = new Date();
	const rows = await db
		.select({
			id: reviews.id,
			memoId: reviews.memoId,
			memoTitle: memos.title,
			memoContent: memos.content,
			step: reviews.step,
			scheduledAt: reviews.scheduledAt,
			completedAt: reviews.completedAt,
			intervalPresetId: memos.intervalPresetId
		})
		.from(reviews)
		.innerJoin(memos, eq(reviews.memoId, memos.id))
		.where(
			and(
				eq(reviews.id, id),
				eq(memos.userId, userId),
				isNull(memos.archivedAt),
				lte(reviews.scheduledAt, now)
			)
		)
		.limit(1)
		.all();
	const row = rows[0];
	if (!row || row.completedAt !== null) throw new NotFoundError('review not found');

	await assertIsCurrentStep(db, row.memoId, row.step);

	const intervals = await getPresetIntervals(db, row.intervalPresetId);

	// 「全 m 回」は現在のプリセットの intervals ではなく、このメモの reviews 行の総数
	// （完了済み + 未完了）で数える。#82 以降 changeMemoPreset は intervalPresetId の
	// 変更と reviews の作り直しを同じ db.batch() で行うため通常は一致するが、#82 の
	// デプロイより前に古い updateMemo でプリセットだけが変更され reviews が
	// 作り直されていない既存メモでは、intervals.length と実際の reviews 行数が
	// ずれ得る（completeReview 節の既存コメントと同じ前提）。ヘッダーの
	// 「n 回目 / 全 m 回」は実際に画面遷移できるステップ数と一致させる必要があるため、
	// reviews 側の実数を正とする。
	const totalRows = await db
		.select({ total: count() })
		.from(reviews)
		.where(eq(reviews.memoId, row.memoId))
		.all();
	// count() は必ず1行返すため totalRows[0] は必ず存在するが、listDueReviews と同じ
	// 慣習で `?? 0` にする（設計レビューで指摘: 以前は `?? intervals.length` だった。
	// これは到達しないコードである上、直前のコメントが「reviews 側の実数を正とする」と
	// 述べているのに intervals 側の値へフォールバックしており矛盾していた）。
	const totalSteps = totalRows[0]?.total ?? 0;

	// 次のステップの reviews 行が実在するかを見て「次回予定」の有無を判定する
	// （intervals.length だけを見ると、プリセット変更後に「次のステップが無い」と
	// 誤判定し、実際に「復習した」を押した際の completeReview の結果と矛盾する
	// 表示になってしまう。正確性レビューで指摘。見つかった行から返す日時の決定は
	// resolveNextScheduledAt として completeReview と共有している）。
	const nextStep = row.step + 1;
	const nextStepRows = await db
		.select({ scheduledAt: reviews.scheduledAt })
		.from(reviews)
		.where(
			and(eq(reviews.memoId, row.memoId), eq(reviews.step, nextStep), isNull(reviews.completedAt))
		)
		.limit(1)
		.all();
	const previewNextScheduledAt = resolveNextScheduledAt(
		nextStepRows[0],
		nextReviewAt(now, intervals, nextStep)
	);

	return {
		id: row.id,
		memoId: row.memoId,
		memoTitle: row.memoTitle,
		memoContent: row.memoContent,
		step: row.step,
		totalSteps,
		scheduledAt: row.scheduledAt,
		previewNextScheduledAt
	};
}

// review_schedules は createMemo が memos・reviews と同じ db.batch() で必ず作るため
// 通常はメモと1:1で存在するが、migrate（新テーブル作成）から deploy（新しい
// createMemo への切り替え）が完了するまでの短い window（docs/design-decisions.md の
// #7 節: この順序前提）に、旧バージョンのコードで作られたメモは review_schedules
// 行を持たない。ensureReviewsExist（memos.ts、#16 の reviews 欠落治癒と同じ形）に
// 倣い、行が見つからなかった場合はここで治癒する。治癒しないと、この後の claim の
// bump 文（`WHERE memo_id = ? AND version = 0`）が対象行の不在によって恒久的に
// 0件のままになり、対象メモの review 完了・プリセット変更が永久に失敗し続ける
// （advisor 指摘、実機の D1 エラーではなく静的レビューで発見）。
async function ensureReviewScheduleExists(db: Db, memoId: string): Promise<void> {
	await db.insert(reviewSchedules).values({ memoId, version: 0 }).onConflictDoNothing();
}

export async function completeReview(db: Db, userId: string, id: string): Promise<CompletedReview> {
	const requestedAt = new Date();
	// reviews 自体は userId を持たないため、所有権の確認は memos との JOIN で行う。
	// scheduleVersion は Issue #85 の楽観ロック用（下記 wonThisCompletion・
	// scheduleVersionMatches の説明を参照）。review_schedules 行が無いメモを
	// 対象から除外しないよう leftJoin にする（ensureReviewScheduleExists 参照）。
	const rows = await db
		.select({
			id: reviews.id,
			memoId: reviews.memoId,
			memoTitle: memos.title,
			step: reviews.step,
			completedAt: reviews.completedAt,
			intervalPresetId: memos.intervalPresetId,
			scheduleVersion: reviewSchedules.version
		})
		.from(reviews)
		.innerJoin(memos, eq(reviews.memoId, memos.id))
		.leftJoin(reviewSchedules, eq(reviewSchedules.memoId, memos.id))
		.where(
			and(
				eq(reviews.id, id),
				eq(memos.userId, userId),
				isNull(memos.archivedAt),
				lte(reviews.scheduledAt, requestedAt)
			)
		)
		.limit(1)
		.all();
	const target = rows[0];
	if (!target) throw new NotFoundError('review not found');
	if (target.completedAt !== null) throw new ConflictError('review has already been completed');

	if (target.scheduleVersion === null) {
		await ensureReviewScheduleExists(db, target.memoId);
	}
	const scheduleVersion = target.scheduleVersion ?? 0;

	await assertIsCurrentStep(db, target.memoId, target.step);

	// 完了時刻を起点に、このメモの残り未完了ステップの scheduledAt を再計算する
	// （ユーザー承認済みの設計判断、docs/design-decisions.md の #17 節）。放置していた
	// 期間をそのまま引き継いで一括消化できてしまうことを避け、間隔反復として機能させる。
	const intervals = await getPresetIntervals(db, target.intervalPresetId);

	const remaining = await db
		.select({ id: reviews.id, step: reviews.step, scheduledAt: reviews.scheduledAt })
		.from(reviews)
		.where(
			and(
				eq(reviews.memoId, target.memoId),
				isNull(reviews.completedAt),
				gt(reviews.step, target.step)
			)
		)
		.all();

	const completedAt = new Date();

	// この completeReview 呼び出し自身が対象ステップを completedAt で完了させたことを
	// 保証するガード。db.batch 内の先頭 UPDATE（completeCurrent）が競合により0件更新に
	// なっても、後続の UPDATE 文はエラーにならず実行されてしまう（D1 の batch は文の
	// 成否ではなく件数不一致を検出しない）。このガードなしだと、同時に2件の完了操作が
	// 走った際、負けた側（completedAt がこの呼び出しの値ではない）のバッチでも残り
	// ステップの再アンカリングだけが自分の completedAt を起点に成功してしまい、
	// 保存された completedAt と再アンカリング元の時刻が食い違う（Codex のレビューで指摘）。
	const wonThisCompletion = exists(
		db
			.select({ one: sql`1` })
			.from(reviews)
			.where(and(eq(reviews.id, id), eq(reviews.completedAt, completedAt)))
	);

	// Issue #85: reviews への書き込み経路は、同じ論理操作内で review_schedules.version
	// の CAS に勝った場合のみ書き込む、という不変条件を completeReview 自身にも課す。
	// scheduleVersionMatches が false になるのは、この呼び出しの SELECT（冒頭の
	// scheduleVersion 取得）より後に、別リクエストの changeMemoPreset・
	// updateCustomPresetIntervals（いずれも claim 成功時に version をこの条件と
	// 同じ形で更新する、下記 reviewScheduleVersionMatches を参照）が割り込んだ場合。
	// completeCurrent の WHERE に含めることで、古いスナップショット（旧 intervals・
	// 旧 step 構成）を前提にした完了・再アンカリングがコミットされることを防ぐ。
	const scheduleVersionMatches = reviewScheduleVersionMatches(db, target.memoId, scheduleVersion);

	// #82 以降 changeMemoPreset は intervalPresetId の変更と reviews の作り直しを
	// 同じ db.batch() で行うため、通常この reviews のステップ数は現在のプリセットの
	// intervals と整合している。しかし #82 のデプロイより前に古い updateMemo で
	// プリセットだけが変更され reviews が作り直されていない既存メモでは、現在の
	// プリセットの intervals が当時より短くなっていることがあり、残りステップの
	// 一部・全部を再計算できない（nextReviewAt が undefined を返す）場合がある。
	// そのステップの再アンカリングだけをスキップする（scheduledAt は変更前の値の
	// まま残る）。この既存メモの不整合自体をここで解消することはしないが、
	// 「対象ステップの完了」をこの不整合を理由に失敗させない。
	const reanchorUpdates = remaining
		.map((row) => {
			const scheduledAt = nextReviewAt(completedAt, intervals, row.step);
			if (!scheduledAt) return null;
			return {
				query: db
					.update(reviews)
					.set({ scheduledAt, notifiedAt: null, notificationAttemptedAt: null })
					.where(and(eq(reviews.id, row.id), isNull(reviews.completedAt), wonThisCompletion)),
				step: row.step,
				scheduledAt
			};
		})
		.filter((update) => update !== null);

	const completeCurrent = db
		.update(reviews)
		.set({ completedAt })
		// SELECT 後に #18 の再計算等で期限が未来へ移された場合も、古い画面や通知から
		// 期限前に完了できないよう UPDATE 自体でも due 条件を再検証する。scheduleVersionMatches
		// により、#85 の claim（changeMemoPreset・updateCustomPresetIntervals）が
		// この SELECT より後に割り込んだ場合も同じ 0 行ヒットで検出する。
		.where(
			and(
				eq(reviews.id, id),
				isNull(reviews.completedAt),
				lte(reviews.scheduledAt, completedAt),
				scheduleVersionMatches
			)
		)
		.returning();

	// この呼び出し自身の完了・再アンカリングが確定したことを、後続の claim（#85）が
	// 検出できるようにする。wonThisCompletion で「この呼び出しが実際に勝った場合のみ」
	// に絞るのは reanchorUpdates と同じ理由（Codex のレビューで指摘された既存の
	// ガードと同型）。
	const bumpScheduleVersion = db
		.update(reviewSchedules)
		.set({ version: sql`${reviewSchedules.version} + 1` })
		.where(and(eq(reviewSchedules.memoId, target.memoId), wonThisCompletion));

	// db.batch は静的に1件以上とわかるタプル型（BatchItem<'sqlite'> の非空配列）を
	// 要求するが、再アンカリング対象の件数は実行時にしか決まらない。completeCurrent が
	// 常に配列先頭にあるため実行時には常に1件以上になるが、可変長の spread を含む配列
	// リテラルが非空タプルであることは TypeScript の型システムでは静的に証明できない
	// ため、型注釈で表明する（db.batch の結果は先頭要素の completedRows のみ参照する）。
	const batchQueries: [typeof completeCurrent, ...BatchItem<'sqlite'>[]] = [
		completeCurrent,
		...reanchorUpdates.map((u) => u.query),
		bumpScheduleVersion
	];
	const [completedRows] = await db.batch(batchQueries);
	if (!completedRows[0]) {
		// 直前の存在確認と実際の UPDATE の間に、別リクエストが先に完了させたか、
		// #85 の claim が割り込んだ場合。
		throw new ConflictError('review has already been completed');
	}

	// nextScheduledAt は「このメモの復習が全ステップ完了した」（null）と「次のステップは
	// 存在するが、プリセット短縮により再アンカリングできず古い scheduledAt のまま残って
	// いる」を区別する必要がある。後者を再アンカリング結果（reanchorUpdates、undefined
	// を返したステップは除外済み）だけから判定すると、両者とも見つからず null になり、
	// 実際には未完了ステップが残っているのに「すべて完了しました」と表示されてしまう
	// （正確性レビューで指摘）。フィルタ前の remaining で「次のステップの行自体が
	// 存在するか」を見た上で判定する（resolveNextScheduledAt、getDueReviewDetail の
	// プレビュー計算と共有するロジック）。
	const nextStep = target.step + 1;
	const nextRow = remaining.find((row) => row.step === nextStep);
	const nextScheduledAt = resolveNextScheduledAt(
		nextRow,
		reanchorUpdates.find((u) => u.step === nextStep)?.scheduledAt
	);

	return {
		id,
		memoId: target.memoId,
		memoTitle: target.memoTitle,
		completedAt,
		nextScheduledAt
	};
}

export interface ReviewScheduleStep {
	step: number;
	scheduledAt: Date;
	completedAt: Date | null;
}

// メモ詳細画面（apps/web/src/routes/(app)/memos/[id]）向け。そのメモの reviews 行を
// 完了済み・未完了の両方まとめて step 昇順で返す。getDueReviewDetail は「現在の1
// ステップ」の詳細を返す専用ロジック（assertIsCurrentStep 等）を含み、全ステップの
// 一覧という別の要求には合わないため、独立した関数として用意する。
export async function listReviewSchedule(db: Db, memoId: string): Promise<ReviewScheduleStep[]> {
	return db
		.select({
			step: reviews.step,
			scheduledAt: reviews.scheduledAt,
			completedAt: reviews.completedAt
		})
		.from(reviews)
		.where(eq(reviews.memoId, memoId))
		.orderBy(asc(reviews.step))
		.all();
}

export interface ReviewRecalculationPlan {
	// このメモの現在の未完了 reviews 件数（= このプランの実行で削除・作り直される件数）。
	// 「N 件の予定が更新されます」のプレビューと実際の更新が同じ定義を共有するための値。
	affectedCount: number;
	// 呼び出し側が claimReviewSchedule（このメモ分の claim）に勝った場合にのみ
	// INSERT する行（Issue #85）。
	newRows: (typeof reviews.$inferInsert)[];
	// この計画を作った時点の review_schedules.version。claimReviewSchedule・
	// buildReviewScheduleClaimStatements に渡す（Issue #85）。
	expectedVersion: number;
}

// メモ1件分の再計算に必要な入力。#84 で「対象メモを一括取得する」ようにした
// updateCustomPresetIntervals/previewPresetIntervalsUpdate（loadReviewRecalculationInputs
// 経由）と、1件だけを対象にする planReviewRecalculation の両方が、この同じ形の入力を
// computeReviewRecalculation に渡す。
export interface MemoRecalcInputs {
	createdAt: Date;
	// このメモの完了済み reviews のうち、最大 step の行（＝最新の完了済みステップ）。
	// 1件も完了していなければ undefined。
	latestCompleted: { step: number; completedAt: Date } | undefined;
	// このメモの現在の未完了 reviews 件数。
	incompleteCount: number;
	// このメモの review_schedules.version（Issue #85 の楽観ロック用）。
	version: number;
}

// #18 の再計算レシピ（docs/schema.md の reviews 節、ユーザー承認済みの設計判断）を
// DB アクセスなしで計算する純粋関数（#84 で切り出し。取得済みの入力から計画を作る
// 処理と、その入力をどう取得するか（1件ずつ／一括）を分離し、プレビュー・確定・
// 単一メモ更新の3経路すべてが同じ計算ロジックを共有できるようにした）:
// - 完了済み行（completedAt IS NOT NULL）には一切触れない。
// - 未完了行は、期限到来済み（due）のものも含めて全て DELETE し、完了済み
//   ステップ数を起点に新しい intervals の残りステップを再生成する。
// - baseTime は最新の完了済みステップの completedAt（無ければ memos.createdAt）。
//   #17 の completeReview が残りステップを再アンカリングする際の基準と揃える。
// - 新しい intervals の要素数が既存の完了済みステップ数以下の場合、残りステップは
//   生成しない（そのメモは全ステップ完了扱いになる）。
// 「常に最小の未完了 step から完了させる」不変条件（#17 が保証）により、完了済み
// 行数は「最大の完了済み step + 1」と一致する（欠番が発生しない）ため、
// 完了済み行を1件1件数えるクエリを別に発行する必要はない。
export function computeReviewRecalculation(
	memoId: string,
	input: MemoRecalcInputs,
	intervals: readonly number[]
): { affectedCount: number; newRows: (typeof reviews.$inferInsert)[] } {
	const completedCount = input.latestCompleted ? input.latestCompleted.step + 1 : 0;
	const baseTime = input.latestCompleted?.completedAt ?? input.createdAt;

	const newRows: (typeof reviews.$inferInsert)[] = [];
	for (let step = completedCount; step < intervals.length; step++) {
		const scheduledAt = nextReviewAt(baseTime, intervals, step);
		if (scheduledAt) newRows.push({ memoId, step, scheduledAt });
	}

	return { affectedCount: input.incompleteCount, newRows };
}

// Issue #85: reviews への書き込み経路は、同じ論理操作内で review_schedules.version
// の CAS に勝った場合のみ書き込む、という不変条件を守るための共通ガード。version が
// 読み取り時のまま変わっていない（他の claim・completeReview がまだ割り込んで
// いない）ことを、review_schedules が FROM に無い文（reviews への DELETE 等）からも
// 使える形（EXISTS）で表す。列を直接 WHERE に混ぜると、その文が review_schedules を
// FROM/JOIN していない場合は「スコープに無い列」として SQL エラーになる（実測で確認、
// D1 が "no such column: review_schedules.memo_id" を返した）。
function reviewScheduleVersionMatches(db: Db, memoId: string, expectedVersion: number) {
	return exists(
		db
			.select({ one: sql`1` })
			.from(reviewSchedules)
			.where(and(eq(reviewSchedules.memoId, memoId), eq(reviewSchedules.version, expectedVersion)))
	);
}

// 対象メモが（このガード評価時点で）アーカイブされていないかを、同じ理由で EXISTS の
// 形で表す。アーカイブは一方向の操作（un-archive しない）のため、version の一致だけを
// 見ると「アーカイブ後に読み取った version」を「変化なし」と誤認し、アーカイブ済み
// メモの reviews を復活させてしまう（advisor 指摘）。
function memoIsNotArchived(db: Db, memoId: string) {
	return exists(
		db
			.select({ one: sql`1` })
			.from(memos)
			.where(and(eq(memos.id, memoId), isNull(memos.archivedAt)))
	);
}

// memoId の未完了 reviews を書き換える権利を主張する DELETE + version bump の組
// （実行はしない）。両方とも version 不一致・対象メモのアーカイブのいずれかで0行に
// なり、bump は .returning() で呼び出し側に成否を伝える。
//
// この2文の直後に newRows の INSERT を無条件で積むことはできない（D1 の
// batch() は `INSERT ... VALUES` に WHERE を持てないため、db.insert().select() や
// 生SQLの guarded INSERT も db.batch() の prepared statement 要件を満たせず使えない
// ことを #82 で確認済み、docs/design-decisions.md の #82 節を参照）。そのため
// 呼び出し側は、この2文を独立した db.batch() として実行し、bump の返り値で
// 「勝った」ことを確認した後にのみ、別の呼び出しで newRows を INSERT する。
export function buildReviewScheduleClaimStatements(
	db: Db,
	memoId: string,
	expectedVersion: number
) {
	const notArchived = memoIsNotArchived(db, memoId);
	const deleteStatement = db
		.delete(reviews)
		.where(
			and(
				eq(reviews.memoId, memoId),
				isNull(reviews.completedAt),
				reviewScheduleVersionMatches(db, memoId, expectedVersion),
				notArchived
			)
		);
	const bumpStatement = db
		.update(reviewSchedules)
		.set({ version: sql`${reviewSchedules.version} + 1` })
		.where(
			and(
				eq(reviewSchedules.memoId, memoId),
				eq(reviewSchedules.version, expectedVersion),
				notArchived
			)
		)
		.returning({ memoId: reviewSchedules.memoId });
	return { deleteStatement, bumpStatement };
}

// メモ1件分の claim を実行し、勝敗を返す（changeMemoPreset 向け）。対象メモが
// 複数ありうる updateCustomPresetIntervals は、全メモ分の claim を1つの
// db.batch() にまとめて発行したいため、代わりに buildReviewScheduleClaimStatements を
// 直接使う（Issue #85）。
export async function claimReviewSchedule(
	db: Db,
	memoId: string,
	expectedVersion: number
): Promise<boolean> {
	const { deleteStatement, bumpStatement } = buildReviewScheduleClaimStatements(
		db,
		memoId,
		expectedVersion
	);
	const [, bumpedRows] = await db.batch([deleteStatement, bumpStatement]);
	return bumpedRows.length > 0;
}

// planReviewRecalculation（単一メモ）が返す計画を実際に適用する: claim に勝った
// 場合にのみ newRows を INSERT する。updateCustomPresetIntervals（複数メモの claim を
// 1つの db.batch() にまとめたい）は、代わりに buildReviewScheduleClaimStatements を
// 直接使う。changeMemoPreset・回帰テストの両方がこのヘルパー経由で計画を適用する
// （Issue #85）。
export async function commitReviewRecalculation(
	db: Db,
	memoId: string,
	plan: ReviewRecalculationPlan
): Promise<void> {
	const won = await claimReviewSchedule(db, memoId, plan.expectedVersion);
	if (!won) {
		throw new ConflictError('メモの復習予定が同時に更新されました。もう一度お試しください。');
	}
	if (plan.newRows.length === 0) return;
	try {
		await db.insert(reviews).values(plan.newRows);
	} catch (err) {
		// claim に勝った直後・この INSERT 実行前のごく狭い窓に、別の書き込みが同じ
		// memoId に対して先に同じ step 番号を使ってしまった場合の backstop（#82 節が
		// 記録する残存レースと同種、完全な排除はできない）。
		if (isUniqueConstraintViolation(err, 'reviews.step')) {
			throw new ConflictError('メモの復習予定が同時に更新されました。もう一度お試しください。');
		}
		throw err;
	}
}

// メモ1件分の未完了 reviews を、新しい intervals に基づいて作り直すための
// DELETE/INSERT 文を組み立てる（実行はしない）。changeMemoPreset（#82、常に1件のみ
// 対象）向け。対象メモが複数ありうる updateCustomPresetIntervals（#84）は、代わりに
// loadReviewRecalculationInputs で一括取得してから計算する。
export async function planReviewRecalculation(
	db: Db,
	memoId: string,
	intervals: readonly number[]
): Promise<ReviewRecalculationPlan> {
	const memoRows = await db
		.select({ createdAt: memos.createdAt })
		.from(memos)
		.where(eq(memos.id, memoId))
		.limit(1)
		.all();
	const memo = memoRows[0];
	if (!memo) throw new NotFoundError('memo not found');

	const scheduleRows = await db
		.select({ version: reviewSchedules.version })
		.from(reviewSchedules)
		.where(eq(reviewSchedules.memoId, memoId))
		.limit(1)
		.all();
	// createMemo とマイグレーションのバックフィルにより review_schedules 行は通常
	// メモと1:1で存在するが、その前提が崩れた場合（ensureReviewScheduleExists の
	// コメントを参照）は治癒してから version 0 として扱う。治癒しないまま
	// expectedVersion だけを 0 にフォールバックすると、後続の claim の bump 文
	// （`WHERE memo_id = ? AND version = 0`）が対象行の不在によって恒久的に
	// 0件のままになり、このメモの再計算が永久に失敗し続ける。
	const scheduleRow = scheduleRows[0];
	if (!scheduleRow) {
		await ensureReviewScheduleExists(db, memoId);
	}
	const expectedVersion = scheduleRow?.version ?? 0;

	const latestCompletedRows = await db
		.select({ step: reviews.step, completedAt: reviews.completedAt })
		.from(reviews)
		.where(and(eq(reviews.memoId, memoId), isNotNull(reviews.completedAt)))
		.orderBy(desc(reviews.step))
		.limit(1)
		.all();

	const incompleteRows = await db
		.select({ id: reviews.id })
		.from(reviews)
		.where(and(eq(reviews.memoId, memoId), isNull(reviews.completedAt)))
		.all();

	const latestCompletedRow = latestCompletedRows[0];
	const { affectedCount, newRows } = computeReviewRecalculation(
		memoId,
		{
			createdAt: memo.createdAt,
			// isNotNull(reviews.completedAt) が WHERE 句に入っているため completedAt は
			// 必ず non-null（drizzle の列型が反映していないだけ）。
			latestCompleted: latestCompletedRow && {
				step: latestCompletedRow.step,
				completedAt: latestCompletedRow.completedAt as Date
			},
			incompleteCount: incompleteRows.length,
			version: expectedVersion
		},
		intervals
	);

	return { affectedCount, newRows, expectedVersion };
}

// updateCustomPresetIntervals・previewPresetIntervalsUpdate（#84）向け。対象メモ数に
// 依らず常に一定数のクエリ集合（チャンク分割込み。#84 時点は3、Issue #85 で
// version 取得を追加し4）で完了する点が、1メモにつき3 SELECT を発行する
// planReviewRecalculation との違い。戻り値の Map は対象メモ数より少ないことがある
// （後述）ため、呼び出し側は memoIds の各要素に対して `.get(memoId)` が undefined に
// なり得ることを前提にする。
export async function loadReviewRecalculationInputs(
	db: Db,
	memoIds: readonly string[]
): Promise<Map<string, MemoRecalcInputs>> {
	if (memoIds.length === 0) return new Map();

	const [createdAtRows, completedRows, incompleteCountRows, scheduleVersionRows] =
		await Promise.all([
			queryInChunks(memoIds, (ids) =>
				db
					.select({ id: memos.id, createdAt: memos.createdAt })
					.from(memos)
					.where(inArray(memos.id, ids))
					.all()
			),
			queryInChunks(memoIds, (ids) =>
				db
					.select({ memoId: reviews.memoId, step: reviews.step, completedAt: reviews.completedAt })
					.from(reviews)
					.where(and(inArray(reviews.memoId, ids), isNotNull(reviews.completedAt)))
					.all()
			),
			// GROUP BY はあるが bind は inArray 1つのみ（他に条件を持たない）ため、
			// db-chunk.ts の D1_MAX_BIND_PARAMS チャンクサイズがそのまま使える。
			queryInChunks(memoIds, (ids) =>
				db
					.select({ memoId: reviews.memoId, count: count() })
					.from(reviews)
					.where(and(inArray(reviews.memoId, ids), isNull(reviews.completedAt)))
					.groupBy(reviews.memoId)
					.all()
			),
			// Issue #85: claim（buildReviewScheduleClaimStatements）に渡す expectedVersion。
			queryInChunks(memoIds, (ids) =>
				db
					.select({ memoId: reviewSchedules.memoId, version: reviewSchedules.version })
					.from(reviewSchedules)
					.where(inArray(reviewSchedules.memoId, ids))
					.all()
			)
		]);

	// 完了済み行のうち、メモごとに最大 step の1行だけを残す。SQL 側で
	// max(step)・max(completedAt) を別々に集約しない理由: 「最新の完了済み
	// ステップの completedAt」は常に「同じ行の completedAt」でなければならないが、
	// それは step と completedAt が単調に対応するという #17 の不変条件に依存した
	// 前提であり、別々の集約はこの前提を検証せず、#82 より前の不整合な既存データ
	// （memos.ts の changeMemoPreset コメント参照）に対して誤った baseTime を返しうる
	// （advisor 指摘）。JS 側で「同じ行から取った」ことを保証する。
	const latestCompletedMap = new Map<string, { step: number; completedAt: Date }>();
	for (const row of completedRows) {
		const current = latestCompletedMap.get(row.memoId);
		if (!current || row.step > current.step) {
			// isNotNull(reviews.completedAt) が WHERE 句に入っているため completedAt は
			// 必ず non-null（drizzle の列型が反映していないだけ）。
			latestCompletedMap.set(row.memoId, { step: row.step, completedAt: row.completedAt as Date });
		}
	}
	const incompleteCountMap = new Map(incompleteCountRows.map((row) => [row.memoId, row.count]));
	const versionMap = new Map(scheduleVersionRows.map((row) => [row.memoId, row.version]));

	// review_schedules 行が無いメモ（ensureReviewScheduleExists のコメントを参照）を
	// ここで治癒する。治癒しないまま version だけを 0 にフォールバックすると、
	// 後続の claim の bump 文が対象行の不在によって恒久的に0件のままになり、
	// このメモの再計算が永久に失敗し続ける。
	const missingScheduleMemoIds = createdAtRows
		.map((row) => row.id)
		.filter((id) => !versionMap.has(id));
	if (missingScheduleMemoIds.length > 0) {
		// この INSERT は1行につき memo_id・version の2列を bind するため、
		// queryInChunks の既定（1 id = 1 bind）のままだと51件以上の欠落で
		// `too many SQL variables` になる（実機で再現・正確性レビューで指摘）。
		// bindsPerItem: 2 を渡してチャンクサイズを半分にする。
		await queryInChunks(
			missingScheduleMemoIds,
			async (ids) => {
				await db
					.insert(reviewSchedules)
					.values(ids.map((memoId) => ({ memoId, version: 0 })))
					.onConflictDoNothing();
				return [];
			},
			2
		);
	}

	// memos 側から見つかった id だけを結果に含める。このメモ実装に delete-memo
	// 機能は無く、対象は必ず collectAffectedMemoIds が直前に返した非アーカイブ
	// メモの id であるため理屈上は常に全件見つかるが、万一見つからなければ
	// 「対象から静かに除外する」（呼び出し元は Map.get が undefined を返す
	// memoId をスキップする）方を選んだ。呼び出し元にとっては claim（Issue #85）が
	// 除外する「途中でアーカイブ・変更されたメモ」と同じ扱いになる。
	const inputs = new Map<string, MemoRecalcInputs>();
	for (const row of createdAtRows) {
		inputs.set(row.id, {
			createdAt: row.createdAt,
			latestCompleted: latestCompletedMap.get(row.id),
			incompleteCount: incompleteCountMap.get(row.id) ?? 0,
			version: versionMap.get(row.id) ?? 0
		});
	}
	return inputs;
}
