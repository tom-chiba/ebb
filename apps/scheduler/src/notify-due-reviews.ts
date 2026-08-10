import {
	and,
	alias,
	asc,
	eq,
	inArray,
	isNull,
	lt,
	lte,
	memos,
	pushSubscriptions,
	reviews,
	notExists,
	type Db
} from '@ebb/db';
import {
	sendPush,
	type PushSendResult,
	type PushSubscriptionRecord,
	type VapidConfig
} from '@ebb/push';

// SELECT に掛ける緩い上限。実際の CPU 予算は SEND_BUDGET（送信回数）であり、これは
// 「クエリ・メモリを一定以上肥大化させない」ための副次的な上限に過ぎない。
// テストが直接この値を参照できるよう export する。
export const REVIEW_QUERY_LIMIT = 50;

// 1回の cron 実行で許容する sendPush 呼び出し回数の上限。CPU を消費するのは
// review の件数ではなく sendPush の呼び出し回数（review × その所有者の購読数。
// #19 でユーザーは複数デバイスから購読できる）であるため、予算はこちらに掛ける。
//
// Free プランは CPU 10ms/呼び出し（Cron Trigger も同じ制限であることを
// developers.cloudflare.com/workers/platform/limits/ で確認済み）で、Web Push
// 1通ごとに ECDSA 署名 + ECDH 鍵合意 + AES-GCM 暗号化が走る。CPU 実測は
// Issue #21 の完了条件に含めず、保守的な値を採用することをユーザー確認済み。
export const SEND_BUDGET = 5;

export type NotifyDueReviewsSummary = {
	reviewsSelected: number;
	reviewsProcessed: number;
	// 送信予算（SEND_BUDGET）不足により今回処理しなかった件数。本番デプロイ後の
	// Workers Logs での SEND_BUDGET 調整判断に使う値のため、reviewsFailed
	// （予期しない例外）とは別カウンタにする。合流させると、ログの
	// deferred=N だけでは「健全なスロットリング」か「DB 更新等の例外」かを
	// 区別できず、調整判断を誤らせる（設計レビューで指摘・修正）。
	reviewsDeferred: number;
	// 同時実行が先に claim したため、この実行では送信しなかった件数。
	reviewsContended: number;
	// review 単位の予期しない例外（例: notifiedAt の UPDATE 失敗）により
	// 今回処理し切れなかった件数。
	reviewsFailed: number;
	sendsAttempted: number;
	sendsSucceeded: number;
	sendsFailed: number;
};

type DueReviewRow = {
	id: string;
	memoId: string;
	memoTitle: string;
	userId: string;
};

async function selectDueReviews(db: Db, now: Date): Promise<DueReviewRow[]> {
	const earlierReviews = alias(reviews, 'earlier_reviews');
	const hasEarlierPendingStep = db
		.select({ id: earlierReviews.id })
		.from(earlierReviews)
		.where(
			and(
				eq(earlierReviews.memoId, reviews.memoId),
				isNull(earlierReviews.completedAt),
				lt(earlierReviews.step, reviews.step)
			)
		);
	return (
		db
			.select({
				id: reviews.id,
				memoId: reviews.memoId,
				memoTitle: memos.title,
				userId: memos.userId
			})
			.from(reviews)
			.innerJoin(memos, eq(reviews.memoId, memos.id))
			.where(
				and(
					lte(reviews.scheduledAt, now),
					isNull(reviews.completedAt),
					isNull(reviews.notifiedAt),
					notExists(hasEarlierPendingStep),
					// アーカイブ済みメモの未完了 reviews は archiveMemo が削除するため理屈上は
					// 発生しないが、apps/web の listDueReviews と同じ理由でここでも明示的に
					// 除外し、その不変条件に依存しない。
					isNull(memos.archivedAt)
				)
			)
			// scheduledAt はミリ秒精度で同時刻の行が起こり得るため、id を tie-breaker にして
			// 「どの review が今回の SEND_BUDGET を使うか」を実行ごとに安定させる
			// （apps/web の listDueReviews と同じ理由）。
			// 未試行（notificationAttemptedAt=NULL）を retryable の再試行より先に回す。
			// これにより古い失敗行が SEND_BUDGET を毎回独占しても、新しい未試行行が
			// 永久に飢餓しない。各グループ内は従来どおり scheduledAt, id で安定化する。
			.orderBy(asc(reviews.notificationAttemptedAt), asc(reviews.scheduledAt), asc(reviews.id))
			.limit(REVIEW_QUERY_LIMIT)
	);
}

async function selectSubscriptionsByUserId(
	db: Db,
	userIds: string[]
): Promise<Map<string, PushSubscriptionRecord[]>> {
	const byUserId = new Map<string, PushSubscriptionRecord[]>();
	if (userIds.length === 0) return byUserId;

	const rows = await db
		.select({
			userId: pushSubscriptions.userId,
			endpoint: pushSubscriptions.endpoint,
			p256dh: pushSubscriptions.p256dh,
			auth: pushSubscriptions.auth
		})
		.from(pushSubscriptions)
		.where(inArray(pushSubscriptions.userId, userIds));

	// グルーピング後は userId は Map のキーにのみ必要で、値（sendPush に渡す
	// PushSubscriptionRecord）には含めない。
	for (const { userId, ...subscription } of rows) {
		const list = byUserId.get(userId) ?? [];
		list.push(subscription);
		byUserId.set(userId, list);
	}
	return byUserId;
}

// review 1件についての送信結果から notifiedAt を立てるべきかを判定する。
// 「二度届かない」ことを「全端末に必ず届く」より優先する: 1件でも sent なら立てる
// （他端末が一時的失敗でも、その端末だけ今回は取りこぼす。立てないと、成功済み端末に
// 毎分重複送信し続けることになり、1件の欠落より遥かに害が大きい）。
// 全滅かつ一部が一時的失敗（retryable）なら立てない。次の cron 実行が自然に再送する
// （packages/push が単一購読前提で文書化した設計を、マルチ購読へ拡張したもの）。
// 購読が0件の場合も立てる（送るあて先が無いので送信予算 SEND_BUDGET は消費しないが、
// 立てなければ毎回の SELECT で選ばれ続け、REVIEW_QUERY_LIMIT の枠を無駄に占有する。
// 通知の許可を得ていない間に期限が来たメモは、その後許可しても通知されない
// トレードオフを受け入れている）。
function shouldMarkNotified(outcomes: PushSendResult['outcome'][]): boolean {
	if (outcomes.length === 0) return true;
	const anySent = outcomes.some((outcome) => outcome === 'sent');
	const anyRetryable = outcomes.some((outcome) => outcome === 'retryable');
	return anySent || !anyRetryable;
}

// 期限到来かつ未完了かつ未通知の reviews を取得し、各所有者の購読へ Web Push を送る。
export async function notifyDueReviews(
	db: Db,
	vapid: VapidConfig,
	now = new Date()
): Promise<NotifyDueReviewsSummary> {
	const dueReviews = await selectDueReviews(db, now);
	const subscriptionsByUserId = await selectSubscriptionsByUserId(db, [
		...new Set(dueReviews.map((review) => review.userId))
	]);

	const summary: NotifyDueReviewsSummary = {
		reviewsSelected: dueReviews.length,
		reviewsProcessed: 0,
		reviewsDeferred: 0,
		reviewsContended: 0,
		reviewsFailed: 0,
		sendsAttempted: 0,
		sendsSucceeded: 0,
		sendsFailed: 0
	};

	let remainingBudget = SEND_BUDGET;

	for (const review of dueReviews) {
		const subscriptions = subscriptionsByUserId.get(review.userId) ?? [];

		// この review だけ予算に収まらない。scheduledAt の古い順に処理しているため、
		// 次回の cron 実行に回して他の（予算に収まる）review の処理は続ける。
		// break にすると、1ユーザーの購読数が SEND_BUDGET を超える review が一度
		// 先頭に来た時点で以後の全 cron 実行が毎回そこで停止し、それより新しい
		// 他ユーザーの通知まで永久に止まってしまう（正確性レビューで指摘・修正）。
		// continue であれば、そのユーザーの review だけが処理されない
		// （既知の限界。実運用で起こり得るデバイス数を大きく超える値のため対応は
		// 行わない）に留まり、他ユーザーの通知は妨げない。
		if (subscriptions.length > remainingBudget) {
			summary.reviewsDeferred += 1;
			continue;
		}

		try {
			// 外部送信の前に notifiedAt を原子的な claim として立てる。同じ review を
			// 選んだ並行 cron のうち、UPDATE に勝った1実行だけが sendPush へ進む。
			// retryable で全滅した場合は下で notifiedAt を戻し、次回に再試行する。
			const claimed = await db
				.update(reviews)
				.set({ notifiedAt: now, notificationAttemptedAt: now })
				.where(and(eq(reviews.id, review.id), isNull(reviews.notifiedAt)))
				.returning({ id: reviews.id });
			if (claimed.length === 0) {
				summary.reviewsContended += 1;
				continue;
			}

			const outcomes: PushSendResult['outcome'][] = [];
			for (const subscription of subscriptions) {
				summary.sendsAttempted += 1;
				try {
					const result = await sendPush(
						subscription,
						{ memoId: review.memoId, title: review.memoTitle, url: `/app/reviews/${review.id}` },
						vapid
					);
					outcomes.push(result.outcome);
					if (result.outcome === 'sent') {
						summary.sendsSucceeded += 1;
					} else {
						summary.sendsFailed += 1;
					}
				} catch (err) {
					// sendPush は例外を投げない設計（packages/push）だが、呼び出し側の想定外の
					// 例外がここで発生しても他の送信・他の review の処理を止めない。
					console.error(`[scheduler] sendPush で予期しない例外 (review=${review.id}):`, err);
					outcomes.push('retryable');
					summary.sendsFailed += 1;
				}
			}
			remainingBudget -= subscriptions.length;

			if (!shouldMarkNotified(outcomes)) {
				await db
					.update(reviews)
					.set({ notifiedAt: null })
					.where(and(eq(reviews.id, review.id), eq(reviews.notifiedAt, now)));
			}
			summary.reviewsProcessed += 1;
		} catch (err) {
			// review 単位で失敗を握り、残りの review の処理を継続する
			// （受け入れ条件: 1件の送信が失敗しても残りの送信は続行される）。
			// claim 前の失敗なら notifiedAt は立たない。claim 後の解放 UPDATE 自体が
			// 失敗した場合は二重送信防止を優先して claim を維持する。
			// reviewsDeferred（予算不足）や reviewsContended（並行実行）とは別に数える。
			console.error(`[scheduler] review の通知処理に失敗 (review=${review.id}):`, err);
			summary.reviewsFailed += 1;
		}
	}

	return summary;
}
