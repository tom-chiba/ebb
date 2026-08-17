import {
	and,
	asc,
	eq,
	inArray,
	isCurrentPendingReview,
	isNull,
	lte,
	memos,
	pushSubscriptions,
	reviews,
	type Db
} from '@ebb/db';
import { sendPush, type PushSubscriptionRecord, type VapidConfig } from '@ebb/push';

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
	expiredSubscriptions: number;
	expiredSubscriptionsDeleted: number;
	subscriptionCleanupFailed: number;
};

type DueReviewRow = {
	id: string;
	memoId: string;
	memoTitle: string;
	userId: string;
};

type StoredPushSubscription = PushSubscriptionRecord & { id: string };

async function selectDueReviews(db: Db, now: Date): Promise<DueReviewRow[]> {
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
					isNull(reviews.notifiedAt),
					// メモごとの「現在の未完了 step」判定（@ebb/db の isCurrentPendingReview、
					// #83 で apps/web の listDueReviews 等と一元化した中核実装）。isNull(completedAt)
					// もこの述語に含まれる。
					isCurrentPendingReview(db),
					// アーカイブ済みメモの未完了 reviews は archiveMemo が削除するため理屈上は
					// 発生しないが、apps/web の listDueReviews と同じ理由でここでも明示的に
					// 除外し、その不変条件に依存しない。
					isNull(memos.archivedAt)
				)
			)
			// scheduledAt はミリ秒精度で同時刻の行が起こり得るため、id を tie-breaker にして
			// 「どの review が今回の SEND_BUDGET を使うか」を実行ごとに安定させる
			// （apps/web の listDueReviews と同じ理由）。
			// 未試行（notificationAttemptedAt=NULL）を予算不足で延期した行より先に回す。
			// これにより予算に恒久的に収まらない行が REVIEW_QUERY_LIMIT を埋めても、
			// 範囲外の未試行行が永久に飢餓しない。
			.orderBy(asc(reviews.notificationAttemptedAt), asc(reviews.scheduledAt), asc(reviews.id))
			.limit(REVIEW_QUERY_LIMIT)
	);
}

async function selectSubscriptionsByUserId(
	db: Db,
	userIds: string[]
): Promise<Map<string, StoredPushSubscription[]>> {
	const byUserId = new Map<string, StoredPushSubscription[]>();
	if (userIds.length === 0) return byUserId;

	const rows = await db
		.select({
			id: pushSubscriptions.id,
			userId: pushSubscriptions.userId,
			endpoint: pushSubscriptions.endpoint,
			p256dh: pushSubscriptions.p256dh,
			auth: pushSubscriptions.auth
		})
		.from(pushSubscriptions)
		.where(inArray(pushSubscriptions.userId, userIds));

	// グルーピング後は userId は Map のキーにのみ必要なので値には含めない。
	// id は失効時に送信前と同じ行だけを削除するため保持する。
	for (const { userId, ...subscription } of rows) {
		const list = byUserId.get(userId) ?? [];
		list.push(subscription);
		byUserId.set(userId, list);
	}
	return byUserId;
}

async function deleteExpiredSubscription(
	db: Db,
	subscription: StoredPushSubscription
): Promise<boolean> {
	const deleted = await db
		.delete(pushSubscriptions)
		.where(
			and(
				eq(pushSubscriptions.id, subscription.id),
				eq(pushSubscriptions.endpoint, subscription.endpoint),
				eq(pushSubscriptions.p256dh, subscription.p256dh),
				eq(pushSubscriptions.auth, subscription.auth)
			)
		)
		.returning({ id: pushSubscriptions.id });
	return deleted.length > 0;
}

// SELECT と UPDATE の間に完了・再計算が割り込んでも、古くなった候補を通知しないよう
// claim 時点で due 条件を再検証する。テストから競合窓を決定的に再現できるよう export する。
export async function claimDueReview(db: Db, reviewId: string, now: Date) {
	return db
		.update(reviews)
		.set({ notifiedAt: now, notificationAttemptedAt: now })
		.where(
			and(
				eq(reviews.id, reviewId),
				lte(reviews.scheduledAt, now),
				isNull(reviews.completedAt),
				isNull(reviews.notifiedAt)
			)
		)
		.returning({ id: reviews.id });
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
		sendsFailed: 0,
		expiredSubscriptions: 0,
		expiredSubscriptionsDeleted: 0,
		subscriptionCleanupFailed: 0
	};

	let remainingBudget = SEND_BUDGET;
	// selectSubscriptionsByUserId のスナップショットは DB から行を削除しても変わらない。
	// 同一 cron 内の別 review で失効 endpoint へ再送しないため、その場でも除外する。
	const expiredSubscriptionIds = new Set<string>();

	for (const review of dueReviews) {
		const subscriptions = (subscriptionsByUserId.get(review.userId) ?? []).filter(
			(subscription) => !expiredSubscriptionIds.has(subscription.id)
		);

		// この review だけ予算に収まらない。scheduledAt の古い順に処理しているため、
		// 次回の cron 実行に回して他の（予算に収まる）review の処理は続ける。
		// break にすると、1ユーザーの購読数が SEND_BUDGET を超える review が一度
		// 先頭に来た時点で以後の全 cron 実行が毎回そこで停止し、それより新しい
		// 他ユーザーの通知まで永久に止まってしまう（正確性レビューで指摘・修正）。
		// deferred 行にも試行日時を記録して SELECT の後方へ回す。これを行わないと、
		// 予算に恒久的に収まらない review が REVIEW_QUERY_LIMIT 件あるだけで SELECT 枠を
		// 毎回埋め、範囲外の他ユーザーまで永久に処理されなくなる。
		if (subscriptions.length > remainingBudget) {
			try {
				await db
					.update(reviews)
					.set({ notificationAttemptedAt: now })
					.where(
						and(
							eq(reviews.id, review.id),
							lte(reviews.scheduledAt, now),
							isNull(reviews.completedAt),
							isNull(reviews.notifiedAt)
						)
					);
				summary.reviewsDeferred += 1;
			} catch (err) {
				console.error(`[scheduler] deferred review の記録に失敗 (review=${review.id}):`, err);
				summary.reviewsFailed += 1;
			}
			continue;
		}

		try {
			// 外部送信の前に notifiedAt を原子的な claim として立てる。同じ review を
			// 選んだ並行 cron のうち、UPDATE に勝った1実行だけが sendPush へ進む。
			// Push サービスが受理した後に応答だけ失われるケースを呼び出し側では判別できない。
			// Issue #21 の「二度届かない」を優先し、送信を試行した後は retryable でも
			// claim を解除しない（at-most-once）。
			const claimed = await claimDueReview(db, review.id, now);
			if (claimed.length === 0) {
				summary.reviewsContended += 1;
				continue;
			}

			for (const subscription of subscriptions) {
				summary.sendsAttempted += 1;
				try {
					const pushSubscription: PushSubscriptionRecord = {
						endpoint: subscription.endpoint,
						p256dh: subscription.p256dh,
						auth: subscription.auth
					};
					const result = await sendPush(
						pushSubscription,
						{ memoId: review.memoId, title: review.memoTitle, url: `/reviews/${review.id}` },
						vapid
					);
					if (result.outcome === 'sent') {
						summary.sendsSucceeded += 1;
					} else {
						summary.sendsFailed += 1;
					}
					if (result.outcome === 'expired') {
						expiredSubscriptionIds.add(subscription.id);
						summary.expiredSubscriptions += 1;
						try {
							if (await deleteExpiredSubscription(db, subscription)) {
								summary.expiredSubscriptionsDeleted += 1;
							} else {
								// 送信中の再購読で鍵が更新されると、古い鍵を条件に含む DELETE は
								// 0件になる。cron 開始時の古いスナップショットを使い続けると、
								// 後続 review は送信対象0件のまま notifiedAt だけが立つため、
								// 現在の購読を読み直して次の review から新しい鍵を使う。
								const refreshed = await selectSubscriptionsByUserId(db, [review.userId]);
								subscriptionsByUserId.set(review.userId, refreshed.get(review.userId) ?? []);
								expiredSubscriptionIds.delete(subscription.id);
							}
						} catch (err) {
							// 配信結果の集計や残りの送信は、購読の後始末失敗とは分離する。
							// 次の cron で再び expired になれば削除を再試行できる。
							console.error(
								`[scheduler] 失効購読の削除に失敗 (subscription=${subscription.id}):`,
								err
							);
							summary.subscriptionCleanupFailed += 1;
						}
					}
				} catch (err) {
					// sendPush は例外を投げない設計（packages/push）だが、呼び出し側の想定外の
					// 例外がここで発生しても他の送信・他の review の処理を止めない。
					console.error(`[scheduler] sendPush で予期しない例外 (review=${review.id}):`, err);
					summary.sendsFailed += 1;
				}
			}
			remainingBudget -= subscriptions.length;

			summary.reviewsProcessed += 1;
		} catch (err) {
			// review 単位で失敗を握り、残りの review の処理を継続する
			// （受け入れ条件: 1件の送信が失敗しても残りの送信は続行される）。
			// claim 前の失敗なら notifiedAt は立たない。claim 後の失敗では
			// 二重送信防止を優先して claim を維持する。
			// reviewsDeferred（予算不足）や reviewsContended（並行実行）とは別に数える。
			console.error(`[scheduler] review の通知処理に失敗 (review=${review.id}):`, err);
			summary.reviewsFailed += 1;
		}
	}

	return summary;
}
