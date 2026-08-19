import {
	and,
	asc,
	count,
	eq,
	isCurrentPendingReview,
	isNull,
	lte,
	memos,
	reviews,
	type Db
} from '@ebb/db';
import { excerptOf } from '../excerpt';
import { clamp, normalizeOffset, type PaginationOptions } from '../pagination';

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
