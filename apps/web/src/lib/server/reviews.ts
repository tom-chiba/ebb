import {
	and,
	asc,
	count,
	desc,
	eq,
	exists,
	gt,
	intervalPresets,
	isNotNull,
	isNull,
	lte,
	memos,
	reviews,
	sql,
	type BatchItem,
	type Db
} from '@ebb/db';
import { nextReviewAt } from '@ebb/core';
import { excerptOf } from './excerpt';
import { ConflictError, NotFoundError } from './errors';
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

// メモごとの「未完了の最小 step」を1行だけ持つサブクエリ。docs/schema.md が #17 に
// 委ねた不変条件（常に最小の未完了 step からのみ完了させる）の実装の核。
// due 判定（scheduledAt <= now）はこのサブクエリの外で行う。中に入れると
// 「期限が来ている行の中での最小 step」になり、期限前の若い step を飛ばして
// 期限切れの後続 step を表示しうる（advisor 指摘）。
// apps/scheduler/src/notify-due-reviews.ts も、相関 NOT EXISTS という別のSQL表現で
// 同じ不変条件を適用している（#21）。この条件を変更するときは両方を確認すること。
function minPendingStepSubquery(db: Db) {
	return db
		.select({
			memoId: reviews.memoId,
			minStep: sql<number>`min(${reviews.step})`.as('min_step')
		})
		.from(reviews)
		.where(isNull(reviews.completedAt))
		.groupBy(reviews.memoId)
		.as('min_pending_step');
}

export async function listDueReviews(db: Db, userId: string, options: ListOptions = {}) {
	const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
	const offset = normalizeOffset(options.offset);
	const now = new Date();

	const minPendingStep = minPendingStepSubquery(db);
	const joinMinStep = and(
		eq(reviews.memoId, minPendingStep.memoId),
		eq(reviews.step, minPendingStep.minStep)
	);
	// アーカイブ済みメモの未完了 reviews は archiveMemo が削除するため理屈上は
	// 発生しないが、その不変条件は archivedAt を書く経路が archiveMemo のみである
	// ことに依存している（docs/schema.md）。ここでも明示的に除外し、依存しない。
	const where = and(
		eq(memos.userId, userId),
		isNull(memos.archivedAt),
		lte(reviews.scheduledAt, now)
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
			.innerJoin(minPendingStep, joinMinStep)
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
			.innerJoin(minPendingStep, joinMinStep)
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

// 常に最小の未完了 step からのみ完了・閲覧できる（docs/schema.md が #17 に委ねた不変条件。
// #18 の再計算レシピが「完了済みステップ数を起点に」で成立することに依存している）。
// 一覧は常にこの条件を満たす行しか見せないため通常は到達しないが、review id を直接
// 指定した呼び出し（URL 直打ち等）に対する防御として、完了操作・詳細取得の両方で再検証する。
async function assertIsCurrentStep(db: Db, memoId: string, step: number) {
	const rows = await db
		.select({ minStep: sql<number>`min(${reviews.step})` })
		.from(reviews)
		.where(and(eq(reviews.memoId, memoId), isNull(reviews.completedAt)))
		.all();
	if (rows[0]?.minStep !== step) {
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
	// （完了済み + 未完了）で数える。updateMemo（#13）は intervalPresetId を変更しても
	// 既存の reviews 行を作り直さないため（#18 のスコープ、reviews.ts の completeReview
	// 節にある既存コメントと同じ前提）、プリセット変更後は intervals.length と実際の
	// reviews 行数がずれ得る。ヘッダーの「n 回目 / 全 m 回」は実際に画面遷移できる
	// ステップ数と一致させる必要があるため、reviews 側の実数を正とする。
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

export async function completeReview(db: Db, userId: string, id: string): Promise<CompletedReview> {
	const requestedAt = new Date();
	// reviews 自体は userId を持たないため、所有権の確認は memos との JOIN で行う。
	const rows = await db
		.select({
			id: reviews.id,
			memoId: reviews.memoId,
			memoTitle: memos.title,
			step: reviews.step,
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
				lte(reviews.scheduledAt, requestedAt)
			)
		)
		.limit(1)
		.all();
	const target = rows[0];
	if (!target) throw new NotFoundError('review not found');
	if (target.completedAt !== null) throw new ConflictError('review has already been completed');

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

	// intervalPresetId は updateMemo（#13）でこの reviews の生成後に変更されている
	// ことがあり、reviews 側のステップ数との整合性は検証されない（#18 のスコープ）。
	// 現在のプリセットの intervals が短くなっていて、残りステップの一部・全部を
	// 再計算できない（nextReviewAt が undefined を返す）場合、そのステップの
	// 再アンカリングだけをスキップする（scheduledAt はプリセット変更前の値のまま残る）。
	// この状態自体の解消は #18 の責務だが、#17 としては「対象ステップの完了」を
	// この不整合を理由に失敗させない。
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
		// 期限前に完了できないよう UPDATE 自体でも due 条件を再検証する。
		.where(
			and(eq(reviews.id, id), isNull(reviews.completedAt), lte(reviews.scheduledAt, completedAt))
		)
		.returning();

	// db.batch は静的に1件以上とわかるタプル型（BatchItem<'sqlite'> の非空配列）を
	// 要求するが、再アンカリング対象の件数は実行時にしか決まらない。completeCurrent が
	// 常に配列先頭にあるため実行時には常に1件以上になるが、可変長の spread を含む配列
	// リテラルが非空タプルであることは TypeScript の型システムでは静的に証明できない
	// ため、型注釈で表明する（db.batch の結果は先頭要素の completedRows のみ参照する）。
	const batchQueries: [typeof completeCurrent, ...BatchItem<'sqlite'>[]] = [
		completeCurrent,
		...reanchorUpdates.map((u) => u.query)
	];
	const [completedRows] = await db.batch(batchQueries);
	if (!completedRows[0]) {
		// 直前の存在確認と実際の UPDATE の間に、別リクエストが先に完了させた場合。
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

export interface ReviewRecalculationPlan {
	// このメモの現在の未完了 reviews 件数（= このプランの実行で削除・作り直される件数）。
	// 「N 件の予定が更新されます」のプレビューと実際の更新が同じ定義を共有するための値。
	affectedCount: number;
	// 呼び出し側が他のメモ分の statements・プリセット自体の UPDATE と合わせて
	// 1つの db.batch() にまとめて実行する（このプラン自体は実行しない）。
	statements: BatchItem<'sqlite'>[];
}

// メモ1件分の未完了 reviews を、新しい intervals に基づいて作り直すための
// DELETE/INSERT 文を組み立てる（実行はしない）。#18 の再計算レシピ
// （docs/schema.md の reviews 節、ユーザー承認済みの設計判断）:
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

	const latestCompletedRows = await db
		.select({ step: reviews.step, completedAt: reviews.completedAt })
		.from(reviews)
		.where(and(eq(reviews.memoId, memoId), isNotNull(reviews.completedAt)))
		.orderBy(desc(reviews.step))
		.limit(1)
		.all();
	const latestCompleted = latestCompletedRows[0];
	const completedCount = latestCompleted ? latestCompleted.step + 1 : 0;
	const baseTime = (latestCompleted && latestCompleted.completedAt) || memo.createdAt;

	const incompleteRows = await db
		.select({ id: reviews.id })
		.from(reviews)
		.where(and(eq(reviews.memoId, memoId), isNull(reviews.completedAt)))
		.all();

	const deleteStatement = db
		.delete(reviews)
		.where(and(eq(reviews.memoId, memoId), isNull(reviews.completedAt)));

	const newRows: (typeof reviews.$inferInsert)[] = [];
	for (let step = completedCount; step < intervals.length; step++) {
		const scheduledAt = nextReviewAt(baseTime, intervals, step);
		if (scheduledAt) newRows.push({ memoId, step, scheduledAt });
	}

	const statements: BatchItem<'sqlite'>[] = [deleteStatement];
	if (newRows.length > 0) statements.push(db.insert(reviews).values(newRows));

	return { affectedCount: incompleteRows.length, statements };
}
