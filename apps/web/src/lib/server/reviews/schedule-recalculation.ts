import {
	and,
	count,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	memos,
	reviews,
	reviewSchedules,
	sql,
	type Db
} from '@ebb/db';
import { nextReviewAt } from '@ebb/core';
import { queryInChunks } from '../db-chunk';
import { ConflictError, isUniqueConstraintViolation, NotFoundError } from '../errors';
import { memoIsNotArchived, reviewScheduleVersionMatches } from './policy';

// review_schedules は createMemo が memos・reviews と同じ db.batch() で必ず作るため
// 通常はメモと1:1で存在するが、migrate（新テーブル作成）から deploy（新しい
// createMemo への切り替え）が完了するまでの短い window（docs/design-decisions.md の
// #7 節: この順序前提）に、旧バージョンのコードで作られたメモは review_schedules
// 行を持たない。ensureReviewsExist（memos.ts、#16 の reviews 欠落治癒と同じ形）に
// 倣い、行が見つからなかった場合はここで治癒する。治癒しないと、この後の claim の
// bump 文（`WHERE memo_id = ? AND version = 0`）が対象行の不在によって恒久的に
// 0件のままになり、対象メモの review 完了・プリセット変更が永久に失敗し続ける
// （advisor 指摘、実機の D1 エラーではなく静的レビューで発見）。
export async function ensureReviewScheduleExists(db: Db, memoId: string): Promise<void> {
	await db.insert(reviewSchedules).values({ memoId, version: 0 }).onConflictDoNothing();
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
