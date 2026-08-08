import {
	and,
	asc,
	eq,
	inArray,
	isNull,
	lte,
	memos,
	pushSubscriptions,
	reviews,
	sql,
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
// 1通ごとに ECDSA 署名 + ECDH 鍵合意 + AES-GCM 暗号化が走る。#8/#20 は
// 本番デプロイ後の実測（Workers Logs）をこの Issue に申し送っていたが未実施のため、
// ここでは保守的な仮値を置く。本番デプロイ後に実測し、必要なら調整すること。
export const SEND_BUDGET = 5;

export type NotifyDueReviewsSummary = {
	reviewsSelected: number;
	reviewsProcessed: number;
	reviewsDeferred: number;
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

type SubscriptionRow = PushSubscriptionRecord & { userId: string };

// メモごとの「未完了の最小 step」を1行だけ持つサブクエリ。apps/web の
// listDueReviews（apps/web/src/lib/server/reviews.ts）と同じ不変条件
// （#17 が確定させた「常に最小の未完了 step からのみ通知・操作できる」）をここでも
// 適用する。reviews はメモ作成時に全 step 分が一括生成されるため、ユーザーが長期間
// 操作しないと同じメモの複数 step が同時に期限到来・未通知になり得る。この
// サブクエリを経由しないと、非最小 step にも通知が送られ、その通知の遷移先
// `/app/reviews/{id}` を開くと `getDueReviewDetail` の `assertIsCurrentStep` が
// `ConflictError` になる（設計レビューで指摘）。
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

async function selectDueReviews(db: Db, now: Date): Promise<DueReviewRow[]> {
	const minPendingStep = minPendingStepSubquery(db);
	const joinMinStep = and(
		eq(reviews.memoId, minPendingStep.memoId),
		eq(reviews.step, minPendingStep.minStep)
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
			.innerJoin(minPendingStep, joinMinStep)
			.innerJoin(memos, eq(reviews.memoId, memos.id))
			.where(
				and(
					lte(reviews.scheduledAt, now),
					isNull(reviews.completedAt),
					isNull(reviews.notifiedAt),
					// アーカイブ済みメモの未完了 reviews は archiveMemo が削除するため理屈上は
					// 発生しないが、apps/web の listDueReviews と同じ理由でここでも明示的に
					// 除外し、その不変条件に依存しない。
					isNull(memos.archivedAt)
				)
			)
			// scheduledAt はミリ秒精度で同時刻の行が起こり得るため、id を tie-breaker にして
			// 「どの review が今回の SEND_BUDGET を使うか」を実行ごとに安定させる
			// （apps/web の listDueReviews と同じ理由）。
			.orderBy(asc(reviews.scheduledAt), asc(reviews.id))
			.limit(REVIEW_QUERY_LIMIT)
	);
}

async function selectSubscriptionsByUserId(
	db: Db,
	userIds: string[]
): Promise<Map<string, SubscriptionRow[]>> {
	const byUserId = new Map<string, SubscriptionRow[]>();
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

	for (const row of rows) {
		const list = byUserId.get(row.userId) ?? [];
		list.push(row);
		byUserId.set(row.userId, list);
	}
	return byUserId;
}

// review 1件についての送信結果から notifiedAt を立てるべきかを判定する。
// 「二度届かない」ことを「全端末に必ず届く」より優先する: 1件でも sent なら立てる
// （他端末が一時的失敗でも、その端末だけ今回は取りこぼす。立てないと、成功済み端末に
// 毎分重複送信し続けることになり、1件の欠落より遥かに害が大きい）。
// 全滅かつ一部が一時的失敗（retryable）なら立てない。次の cron 実行が自然に再送する
// （packages/push が単一購読前提で文書化した設計を、マルチ購読へ拡張したもの）。
// 購読が0件の場合も立てる（送るあて先が無く、立てなければ二度と再送されないまま
// 毎回この review を予算から消費し続ける）。
function shouldMarkNotified(outcomes: PushSendResult['outcome'][]): boolean {
	if (outcomes.length === 0) return true;
	const anySent = outcomes.some((outcome) => outcome === 'sent');
	const anyRetryable = outcomes.some((outcome) => outcome === 'retryable');
	return anySent || !anyRetryable;
}

// 期限到来かつ未完了かつ未通知の reviews を取得し、各所有者の購読へ Web Push を送る。
// cron の重複実行があれば同じ行を2つの実行が同時に SELECT し得るが、対策（ロック等）は
// 設けない。「送信後にマークする」= at-least-once を意図的に受容する
// （notifiedAt の UPDATE に付けた `isNull` 条件は clobber 防止のみで、二重送信そのものは防げない）。
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

			if (shouldMarkNotified(outcomes)) {
				await db
					.update(reviews)
					.set({ notifiedAt: now })
					.where(and(eq(reviews.id, review.id), isNull(reviews.notifiedAt)));
			}
			summary.reviewsProcessed += 1;
		} catch (err) {
			// review 単位で失敗を握り、残りの review の処理を継続する
			// （受け入れ条件: 1件の送信が失敗しても残りの送信は続行される）。
			// notifiedAt は立たないため次回の cron 実行が再試行する（reviewsDeferred と
			// 同じ「今回は処理し切れなかった」扱いにし、reviewsSelected ===
			// reviewsProcessed + reviewsDeferred を常に保つ）。
			console.error(`[scheduler] review の通知処理に失敗 (review=${review.id}):`, err);
			summary.reviewsDeferred += 1;
		}
	}

	return summary;
}
