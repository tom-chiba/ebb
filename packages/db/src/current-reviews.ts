import { and, eq, isNull, lt, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { reviews } from './schema';
import type { Db } from './index';

// メモごとの「未完了の最小 step」判定条件（#83）。docs/schema.md が #17 に委ねた
// 不変条件（常に最小の未完了 step からのみ完了・通知・表示する）の中核実装で、
// Web一覧（listDueReviews）・メモ一覧（listMemosForBrowse）・メモ詳細
// （getCurrentPendingReview）・scheduler（notify-due-reviews）が共通で使う。
//
// due 判定（scheduledAt <= now）はこの述語の外で行うこと。中に入れると「期限が
// 来ている行の中での最小 step」になり、期限前の若い step を飛ばして期限切れの
// 後続 step を current 扱いしてしまう（advisor 指摘）。
//
// 相関先は alias されていない reviews テーブルそのもの。呼び出し側が outer query で
// reviews を alias している場合、この関数はその alias とは相関しないため使えない。
export function isCurrentPendingReview(db: Db) {
	const earlier = alias(reviews, 'earlier_pending_reviews');
	return and(
		isNull(reviews.completedAt),
		notExists(
			db
				.select({ id: earlier.id })
				.from(earlier)
				.where(
					and(
						eq(earlier.memoId, reviews.memoId),
						isNull(earlier.completedAt),
						lt(earlier.step, reviews.step)
					)
				)
		)
	);
}
