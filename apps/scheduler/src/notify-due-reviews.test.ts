import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createDb,
	eq,
	intervalPresets,
	memos,
	pushSubscriptions,
	reviews,
	user,
	type Db
} from '@ebb/db';
import type { PushSendResult, VapidConfig } from '@ebb/push';
import { createTestUser } from '../test/test-helpers';
import {
	claimDueReview,
	notifyDueReviews,
	REVIEW_QUERY_LIMIT,
	SEND_BUDGET
} from './notify-due-reviews';

const { sendPush } = vi.hoisted(() => ({ sendPush: vi.fn() }));
vi.mock('@ebb/push', () => ({ sendPush }));

const vapid: VapidConfig = {
	subject: 'mailto:test@example.com',
	publicKey: 'pub',
	privateKey: 'priv'
};

let db: Db;

beforeEach(async () => {
	db = createDb(env.DB);
	sendPush.mockReset();
	sendPush.mockResolvedValue({ outcome: 'sent' } satisfies PushSendResult);
});

// vitest-pool-workers は storage をテストファイル単位で隔離する（it 単位ではない。
// developers.cloudflare.com で確認済み）。各テストが notifyDueReviews で全件スキャンする
// ため、前のテストが残した「未完了・未通知」の review が後続テストの結果を汚染する。
// 明示的に全テーブルを空にして各 it を独立させる。
afterEach(async () => {
	await db.delete(reviews);
	await db.delete(pushSubscriptions);
	await db.delete(memos);
	await db.delete(intervalPresets);
	await db.delete(user);
});

async function createPreset(userId: string) {
	const [preset] = await db
		.insert(intervalPresets)
		.values({ userId, name: 'preset', intervals: [1] })
		.returning();
	if (!preset) throw new Error('fixture setup failed');
	return preset.id;
}

// scheduledAt を過去にした未完了・未通知の review を1件持つメモを作る。
async function createDueMemoWithReview(
	userId: string,
	overrides: { title?: string; scheduledAt?: Date; completedAt?: Date; notifiedAt?: Date } = {}
) {
	const presetId = await createPreset(userId);
	const [memo] = await db
		.insert(memos)
		.values({ userId, title: overrides.title ?? 'memo', content: 'c', intervalPresetId: presetId })
		.returning();
	if (!memo) throw new Error('fixture setup failed');
	const [review] = await db
		.insert(reviews)
		.values({
			memoId: memo.id,
			step: 0,
			scheduledAt: overrides.scheduledAt ?? new Date(Date.now() - 1000),
			completedAt: overrides.completedAt,
			notifiedAt: overrides.notifiedAt
		})
		.returning();
	if (!review) throw new Error('fixture setup failed');
	return { memo, review };
}

// 同じメモに複数の未完了 review（step）を直接作る。createDueMemoWithReview は
// 常に step 0 を1件しか作らないため、最小未完了 step 以外が選ばれないことを
// 確認するテスト用に使う。
async function addReview(
	memoId: string,
	step: number,
	overrides: { scheduledAt?: Date; completedAt?: Date } = {}
) {
	const [review] = await db
		.insert(reviews)
		.values({
			memoId,
			step,
			scheduledAt: overrides.scheduledAt ?? new Date(Date.now() - 1000),
			completedAt: overrides.completedAt
		})
		.returning();
	if (!review) throw new Error('fixture setup failed');
	return review;
}

async function addSubscription(userId: string, endpoint: string) {
	await db.insert(pushSubscriptions).values({ userId, endpoint, p256dh: 'p256dh', auth: 'auth' });
}

async function reload(reviewId: string) {
	const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
	if (!row) throw new Error('review disappeared');
	return row;
}

describe('notifyDueReviews', () => {
	it('期限到来かつ未完了かつ未通知の review だけを対象にする', async () => {
		const userId = await createTestUser(db);
		const { review: due } = await createDueMemoWithReview(userId);
		const { review: notYetDue } = await createDueMemoWithReview(userId, {
			scheduledAt: new Date(Date.now() + 60_000)
		});
		const { review: alreadyCompleted } = await createDueMemoWithReview(userId, {
			completedAt: new Date()
		});
		const { review: alreadyNotified } = await createDueMemoWithReview(userId, {
			notifiedAt: new Date()
		});
		await addSubscription(userId, 'https://push.example/a');

		const summary = await notifyDueReviews(db, vapid);

		expect(summary.reviewsSelected).toBe(1);
		expect(sendPush).toHaveBeenCalledTimes(1);
		expect((await reload(due.id)).notifiedAt).not.toBeNull();
		expect((await reload(notYetDue.id)).notifiedAt).toBeNull();
		expect((await reload(alreadyCompleted.id)).notifiedAt).toBeNull();
		expect((await reload(alreadyNotified.id)).notifiedAt).toEqual(alreadyNotified.notifiedAt);
	});

	it('アーカイブ済みメモの review は対象にしない', async () => {
		// archiveMemo 経由なら未完了 reviews は削除されるため理屈上は発生しないが、
		// apps/web/src/lib/server/reviews.test.ts の listDueReviews のテストと同じ
		// パターンで、その不変条件に依存していないこと自体を直接確認する。
		const userId = await createTestUser(db);
		const { memo, review } = await createDueMemoWithReview(userId);
		await db.update(memos).set({ archivedAt: new Date() }).where(eq(memos.id, memo.id));
		await addSubscription(userId, 'https://push.example/a');

		const summary = await notifyDueReviews(db, vapid);

		expect(summary.reviewsSelected).toBe(0);
		expect(sendPush).not.toHaveBeenCalled();
		expect((await reload(review.id)).notifiedAt).toBeNull();
	});

	it('memoId・タイトル・復習ページへの URL を payload に渡す', async () => {
		const userId = await createTestUser(db);
		const { memo, review } = await createDueMemoWithReview(userId, { title: '復習タイトル' });
		await addSubscription(userId, 'https://push.example/a');

		await notifyDueReviews(db, vapid);

		expect(sendPush).toHaveBeenCalledWith(
			expect.objectContaining({ endpoint: 'https://push.example/a' }),
			{ memoId: memo.id, title: '復習タイトル', url: `/app/reviews/${review.id}` },
			vapid
		);
	});

	it('同じユーザーの複数購読すべてに送信する', async () => {
		const userId = await createTestUser(db);
		await createDueMemoWithReview(userId);
		await addSubscription(userId, 'https://push.example/a');
		await addSubscription(userId, 'https://push.example/b');

		const summary = await notifyDueReviews(db, vapid);

		expect(sendPush).toHaveBeenCalledTimes(2);
		expect(summary.sendsAttempted).toBe(2);
		expect(summary.sendsSucceeded).toBe(2);
	});

	it('購読が0件の review も notifiedAt を立てる（送り先が無いので再送しても無駄）', async () => {
		const userId = await createTestUser(db);
		const { review } = await createDueMemoWithReview(userId);

		const summary = await notifyDueReviews(db, vapid);

		expect(sendPush).not.toHaveBeenCalled();
		expect(summary.reviewsProcessed).toBe(1);
		expect((await reload(review.id)).notifiedAt).not.toBeNull();
	});

	it('retryable でも claim を維持し、次回に重複送信しない', async () => {
		sendPush.mockResolvedValue({ outcome: 'retryable' } satisfies PushSendResult);
		const userId = await createTestUser(db);
		const { review } = await createDueMemoWithReview(userId);
		await addSubscription(userId, 'https://push.example/a');

		await notifyDueReviews(db, vapid);
		await notifyDueReviews(db, vapid, new Date(Date.now() + 1000));

		expect(sendPush).toHaveBeenCalledTimes(1);
		expect((await reload(review.id)).notifiedAt).not.toBeNull();
		expect((await reload(review.id)).notificationAttemptedAt).not.toBeNull();
	});

	it('claim 時点で完了済みまたは期限前になった review を取得しない', async () => {
		const userId = await createTestUser(db);
		const { review: completed } = await createDueMemoWithReview(userId);
		const { review: rescheduled } = await createDueMemoWithReview(userId);
		const now = new Date();
		await db.update(reviews).set({ completedAt: now }).where(eq(reviews.id, completed.id));
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(now.getTime() + 60_000) })
			.where(eq(reviews.id, rescheduled.id));

		expect(await claimDueReview(db, completed.id, now)).toEqual([]);
		expect(await claimDueReview(db, rescheduled.id, now)).toEqual([]);
		expect((await reload(completed.id)).notifiedAt).toBeNull();
		expect((await reload(rescheduled.id)).notifiedAt).toBeNull();
	});

	it('並行実行でも同じ review への sendPush は1回だけ呼ぶ', async () => {
		const userId = await createTestUser(db);
		const { review } = await createDueMemoWithReview(userId);
		await addSubscription(userId, 'https://push.example/concurrent');
		sendPush.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { outcome: 'sent' } satisfies PushSendResult;
		});
		const now = new Date();

		const summaries = await Promise.all([
			notifyDueReviews(db, vapid, now),
			notifyDueReviews(db, vapid, now)
		]);

		expect(sendPush).toHaveBeenCalledTimes(1);
		expect(summaries.reduce((sum, summary) => sum + summary.sendsAttempted, 0)).toBe(1);
		expect((await reload(review.id)).notifiedAt).not.toBeNull();
	});

	it('1件でも sent なら notifiedAt を立てる（他端末が retryable でも重複送信より優先）', async () => {
		sendPush
			.mockResolvedValueOnce({ outcome: 'sent' } satisfies PushSendResult)
			.mockResolvedValueOnce({ outcome: 'retryable' } satisfies PushSendResult);
		const userId = await createTestUser(db);
		const { review } = await createDueMemoWithReview(userId);
		await addSubscription(userId, 'https://push.example/a');
		await addSubscription(userId, 'https://push.example/b');

		await notifyDueReviews(db, vapid);

		expect((await reload(review.id)).notifiedAt).not.toBeNull();
	});

	it('全滅かつ全部が terminal（sent でも retryable でもない）なら notifiedAt を立てる', async () => {
		sendPush.mockResolvedValue({ outcome: 'expired' } satisfies PushSendResult);
		const userId = await createTestUser(db);
		const { review } = await createDueMemoWithReview(userId);
		await addSubscription(userId, 'https://push.example/a');

		const summary = await notifyDueReviews(db, vapid);

		expect((await reload(review.id)).notifiedAt).not.toBeNull();
		expect(summary.sendsFailed).toBe(1);
		expect(summary.sendsSucceeded).toBe(0);
	});

	it('404/410 で失効した購読を DB から削除する', async () => {
		sendPush.mockResolvedValue({ outcome: 'expired' } satisfies PushSendResult);
		const userId = await createTestUser(db);
		await createDueMemoWithReview(userId);
		await addSubscription(userId, 'https://push.example/expired');

		const summary = await notifyDueReviews(db, vapid);

		const subscriptions = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, 'https://push.example/expired'));
		expect(subscriptions).toHaveLength(0);
		expect(summary.expiredSubscriptions).toBe(1);
		expect(summary.expiredSubscriptionsDeleted).toBe(1);
		expect(summary.subscriptionCleanupFailed).toBe(0);
	});

	it('失効を検出した購読には同じ cron 内の別 review を再送しない', async () => {
		sendPush.mockResolvedValue({ outcome: 'expired' } satisfies PushSendResult);
		const userId = await createTestUser(db);
		await createDueMemoWithReview(userId, { scheduledAt: new Date(Date.now() - 2000) });
		await createDueMemoWithReview(userId, { scheduledAt: new Date(Date.now() - 1000) });
		await addSubscription(userId, 'https://push.example/expired');

		const summary = await notifyDueReviews(db, vapid);

		expect(sendPush).toHaveBeenCalledTimes(1);
		expect(summary.reviewsProcessed).toBe(2);
		expect(summary.expiredSubscriptions).toBe(1);
		expect(summary.expiredSubscriptionsDeleted).toBe(1);
	});

	it.each([
		{ outcome: 'sent' },
		{ outcome: 'retryable' },
		{ outcome: 'invalid' },
		{ outcome: 'rejected', status: 403 }
	] satisfies PushSendResult[])('$outcome の購読は削除しない', async (result) => {
		sendPush.mockResolvedValue(result);
		const userId = await createTestUser(db);
		await createDueMemoWithReview(userId);
		await addSubscription(userId, `https://push.example/${result.outcome}`);

		const summary = await notifyDueReviews(db, vapid);

		const subscriptions = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, `https://push.example/${result.outcome}`));
		expect(subscriptions).toHaveLength(1);
		expect(summary.expiredSubscriptions).toBe(0);
		expect(summary.expiredSubscriptionsDeleted).toBe(0);
	});

	it('送信中に同じ endpoint が再購読された場合は、新しい鍵を後続 review の送信に使う', async () => {
		const userId = await createTestUser(db);
		await createDueMemoWithReview(userId, { scheduledAt: new Date(Date.now() - 2000) });
		await createDueMemoWithReview(userId, { scheduledAt: new Date(Date.now() - 1000) });
		await addSubscription(userId, 'https://push.example/renewed');
		sendPush
			.mockImplementationOnce(async () => {
				await db
					.update(pushSubscriptions)
					.set({ p256dh: 'renewed-p256dh', auth: 'renewed-auth' })
					.where(eq(pushSubscriptions.endpoint, 'https://push.example/renewed'));
				return { outcome: 'expired' } satisfies PushSendResult;
			})
			.mockResolvedValueOnce({ outcome: 'sent' } satisfies PushSendResult);

		const summary = await notifyDueReviews(db, vapid);

		const [subscription] = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, 'https://push.example/renewed'));
		expect(subscription).toMatchObject({ p256dh: 'renewed-p256dh', auth: 'renewed-auth' });
		expect(sendPush).toHaveBeenCalledTimes(2);
		expect(sendPush).toHaveBeenNthCalledWith(
			2,
			{
				endpoint: 'https://push.example/renewed',
				p256dh: 'renewed-p256dh',
				auth: 'renewed-auth'
			},
			expect.any(Object),
			vapid
		);
		expect(summary.expiredSubscriptions).toBe(1);
		expect(summary.expiredSubscriptionsDeleted).toBe(0);
		expect(summary.sendsSucceeded).toBe(1);
	});

	it('失効購読の削除に失敗しても残りの送信を続け、削除失敗を別に集計する', async () => {
		sendPush
			.mockResolvedValueOnce({ outcome: 'expired' } satisfies PushSendResult)
			.mockResolvedValueOnce({ outcome: 'sent' } satisfies PushSendResult);
		const userId = await createTestUser(db);
		await createDueMemoWithReview(userId);
		await addSubscription(userId, 'https://push.example/expired');
		await addSubscription(userId, 'https://push.example/healthy');
		const deleteSpy = vi.spyOn(db, 'delete').mockImplementationOnce(() => {
			throw new Error('db down');
		});

		const summary = await notifyDueReviews(db, vapid);
		deleteSpy.mockRestore();

		expect(sendPush).toHaveBeenCalledTimes(2);
		expect(summary.sendsFailed).toBe(1);
		expect(summary.sendsSucceeded).toBe(1);
		expect(summary.subscriptionCleanupFailed).toBe(1);
	});

	it('sendPush が例外を投げても他の送信・他の review の処理を止めない', async () => {
		const userA = await createTestUser(db);
		const userB = await createTestUser(db);
		const { review: reviewA } = await createDueMemoWithReview(userA, {
			scheduledAt: new Date(Date.now() - 2000)
		});
		const { review: reviewB } = await createDueMemoWithReview(userB, {
			scheduledAt: new Date(Date.now() - 1000)
		});
		await addSubscription(userA, 'https://push.example/a');
		await addSubscription(userB, 'https://push.example/b');
		sendPush.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({
			outcome: 'sent'
		} satisfies PushSendResult);

		const summary = await notifyDueReviews(db, vapid);

		expect(sendPush).toHaveBeenCalledTimes(2);
		expect(summary.reviewsProcessed).toBe(2);
		expect(summary.sendsFailed).toBe(1);
		expect(summary.sendsSucceeded).toBe(1);
		// 応答喪失後の再送で重複しないよう、予期しない例外でも一度送信を試行した
		// review の claim は維持する。
		expect((await reload(reviewA.id)).notifiedAt).not.toBeNull();
		expect((await reload(reviewB.id)).notifiedAt).not.toBeNull();
	});

	it('送信予算を使い切ったら残りの review は次回に回す（部分送信しない）', async () => {
		// 2件購読 x 3ユーザー = 6件は SEND_BUDGET を超える。
		const perUserSubscriptions = 2;
		const userCount = Math.ceil(SEND_BUDGET / perUserSubscriptions) + 1;
		const users = await Promise.all(Array.from({ length: userCount }, () => createTestUser(db)));
		const dueReviews = [];
		for (const [i, userId] of users.entries()) {
			const { review } = await createDueMemoWithReview(userId, {
				scheduledAt: new Date(Date.now() - (userCount - i) * 1000)
			});
			dueReviews.push(review);
			await addSubscription(userId, `https://push.example/${userId}-1`);
			await addSubscription(userId, `https://push.example/${userId}-2`);
		}

		const summary = await notifyDueReviews(db, vapid);

		const processedCount = Math.floor(SEND_BUDGET / perUserSubscriptions);
		expect(summary.sendsAttempted).toBe(processedCount * perUserSubscriptions);
		expect(summary.reviewsProcessed).toBe(processedCount);
		expect(summary.reviewsDeferred).toBe(userCount - processedCount);
		for (let i = 0; i < processedCount; i++) {
			expect((await reload(dueReviews[i]!.id)).notifiedAt).not.toBeNull();
		}
		for (let i = processedCount; i < userCount; i++) {
			expect((await reload(dueReviews[i]!.id)).notifiedAt).toBeNull();
		}
	});

	it('購読数が SEND_BUDGET とちょうど一致する場合は処理される（境界値）', async () => {
		const userId = await createTestUser(db);
		const { review } = await createDueMemoWithReview(userId);
		await Promise.all(
			Array.from({ length: SEND_BUDGET }, (_, i) =>
				addSubscription(userId, `https://push.example/boundary-${i}`)
			)
		);

		const summary = await notifyDueReviews(db, vapid);

		expect(summary.sendsAttempted).toBe(SEND_BUDGET);
		expect(summary.reviewsProcessed).toBe(1);
		expect(summary.reviewsDeferred).toBe(0);
		expect((await reload(review.id)).notifiedAt).not.toBeNull();
	});

	it('scheduledAt が同時刻なら id 昇順で安定した順序になる（tie-breaker）', async () => {
		const sameTime = new Date(Date.now() - 1000);
		const userX = await createTestUser(db);
		const userY = await createTestUser(db);
		const { review: reviewX } = await createDueMemoWithReview(userX, { scheduledAt: sameTime });
		const { review: reviewY } = await createDueMemoWithReview(userY, { scheduledAt: sameTime });
		// どちらも SEND_BUDGET ぶんの購読を持たせ、budget 上どちらか1件しか処理できない
		// 状況を作る。tie-breaker が無いと順序が不定になり、どちらが処理されるか
		// テストで固定できない。
		await Promise.all(
			Array.from({ length: SEND_BUDGET }, (_, i) =>
				addSubscription(userX, `https://push.example/x-${i}`)
			)
		);
		await Promise.all(
			Array.from({ length: SEND_BUDGET }, (_, i) =>
				addSubscription(userY, `https://push.example/y-${i}`)
			)
		);

		await notifyDueReviews(db, vapid);

		const [winner, loser] = reviewX.id < reviewY.id ? [reviewX, reviewY] : [reviewY, reviewX];
		expect((await reload(winner.id)).notifiedAt).not.toBeNull();
		expect((await reload(loser.id)).notifiedAt).toBeNull();
	});

	it('review 単位の予期しない例外（例: notifiedAt の UPDATE 失敗）があっても他の review の処理は継続する', async () => {
		const userA = await createTestUser(db);
		const userB = await createTestUser(db);
		const { review: reviewA } = await createDueMemoWithReview(userA, {
			scheduledAt: new Date(Date.now() - 2000)
		});
		const { review: reviewB } = await createDueMemoWithReview(userB, {
			scheduledAt: new Date(Date.now() - 1000)
		});
		await addSubscription(userA, 'https://push.example/a');
		await addSubscription(userB, 'https://push.example/b');
		// sendPush 自体の例外は内側の try/catch（sendsFailed 加算）が拾うため、ここでは
		// それとは別の経路（DB 更新失敗）を検証する。scheduledAt 昇順で reviewA が
		// 先に処理されるため、1回目の db.update 呼び出しだけを失敗させる。
		const updateSpy = vi.spyOn(db, 'update').mockImplementationOnce(() => {
			throw new Error('db down');
		});

		const summary = await notifyDueReviews(db, vapid);

		expect(summary.reviewsFailed).toBe(1);
		expect(summary.reviewsProcessed).toBe(1);
		expect((await reload(reviewA.id)).notifiedAt).toBeNull();
		expect((await reload(reviewB.id)).notifiedAt).not.toBeNull();
		updateSpy.mockRestore();
	});

	it('予算に収まらない review があっても、それより新しい他ユーザーの review の処理は妨げない', async () => {
		// userA は SEND_BUDGET を超える購読数（常に予算不足と判定される）で最も古い。
		// userB は1購読のみで、userA より新しい。break だと userA で処理が止まり
		// userB が永久に処理されなくなる（正確性レビューで指摘・修正）。
		const userA = await createTestUser(db);
		const userB = await createTestUser(db);
		const { review: reviewA } = await createDueMemoWithReview(userA, {
			scheduledAt: new Date(Date.now() - 2000)
		});
		const { review: reviewB } = await createDueMemoWithReview(userB, {
			scheduledAt: new Date(Date.now() - 1000)
		});
		await Promise.all(
			Array.from({ length: SEND_BUDGET + 1 }, (_, i) =>
				addSubscription(userA, `https://push.example/over-budget-${i}`)
			)
		);
		await addSubscription(userB, 'https://push.example/b');

		const summary = await notifyDueReviews(db, vapid);

		expect(summary.reviewsDeferred).toBe(1);
		expect(summary.reviewsProcessed).toBe(1);
		expect((await reload(reviewA.id)).notifiedAt).toBeNull();
		expect((await reload(reviewB.id)).notifiedAt).not.toBeNull();
	});

	it('予算に恒久的に収まらない review が SELECT 上限を埋めても範囲外の他ユーザーを次回処理する', async () => {
		const overBudgetUser = await createTestUser(db);
		const normalUser = await createTestUser(db);
		const firstRun = new Date();
		for (let i = 0; i < REVIEW_QUERY_LIMIT; i++) {
			await createDueMemoWithReview(overBudgetUser, {
				scheduledAt: new Date(firstRun.getTime() - REVIEW_QUERY_LIMIT - i - 1000)
			});
		}
		await Promise.all(
			Array.from({ length: SEND_BUDGET + 1 }, (_, i) =>
				addSubscription(overBudgetUser, `https://push.example/blocker-${i}`)
			)
		);
		const { review: normalReview } = await createDueMemoWithReview(normalUser, {
			scheduledAt: new Date(firstRun.getTime() - 1)
		});
		await addSubscription(normalUser, 'https://push.example/normal');

		const firstSummary = await notifyDueReviews(db, vapid, firstRun);
		expect(firstSummary.reviewsSelected).toBe(REVIEW_QUERY_LIMIT);
		expect(firstSummary.reviewsDeferred).toBe(REVIEW_QUERY_LIMIT);
		expect(sendPush).not.toHaveBeenCalled();

		const secondSummary = await notifyDueReviews(db, vapid, new Date(firstRun.getTime() + 1000));
		expect(secondSummary.reviewsProcessed).toBe(1);
		expect(sendPush).toHaveBeenCalledWith(
			expect.objectContaining({ endpoint: 'https://push.example/normal' }),
			expect.anything(),
			vapid
		);
		expect((await reload(normalReview.id)).notifiedAt).not.toBeNull();
	});

	it('メモごとに最小の未完了 step の review だけを対象にする（#17 の不変条件）', async () => {
		const userId = await createTestUser(db);
		const presetId = await createPreset(userId);
		const [memo] = await db
			.insert(memos)
			.values({ userId, title: 'memo', content: 'c', intervalPresetId: presetId })
			.returning();
		if (!memo) throw new Error('fixture setup failed');
		// 長期間放置され、step 0（最小の未完了 step）と step 1 が両方期限到来・未通知。
		const step0 = await addReview(memo.id, 0, { scheduledAt: new Date(Date.now() - 2000) });
		const step1 = await addReview(memo.id, 1, { scheduledAt: new Date(Date.now() - 1000) });
		await addSubscription(userId, 'https://push.example/a');

		const summary = await notifyDueReviews(db, vapid);

		expect(summary.reviewsSelected).toBe(1);
		expect(sendPush).toHaveBeenCalledTimes(1);
		expect((await reload(step0.id)).notifiedAt).not.toBeNull();
		expect((await reload(step1.id)).notifiedAt).toBeNull();
	});

	it('step 0 が完了済みなら、期限到来した step 1 が最小未完了 step として選ばれる', async () => {
		// 実運用で最も普通に起こるケース（1回目の復習を終えた後、2回目が期限到来する）。
		// minPendingStepSubquery が isNull(completedAt) で絞らずに min(step) を取ると、
		// 完了済みの step 0 が含まれて minStep が常に 0 に固定され、step 1 が
		// 二度と選ばれなくなる（受入条件・テスト網羅性レビューで指摘）。
		const userId = await createTestUser(db);
		const presetId = await createPreset(userId);
		const [memo] = await db
			.insert(memos)
			.values({ userId, title: 'memo', content: 'c', intervalPresetId: presetId })
			.returning();
		if (!memo) throw new Error('fixture setup failed');
		await addReview(memo.id, 0, {
			scheduledAt: new Date(Date.now() - 5000),
			completedAt: new Date(Date.now() - 3000)
		});
		const step1 = await addReview(memo.id, 1, { scheduledAt: new Date(Date.now() - 1000) });
		await addSubscription(userId, 'https://push.example/a');

		const summary = await notifyDueReviews(db, vapid);

		expect(summary.reviewsSelected).toBe(1);
		expect(sendPush).toHaveBeenCalledTimes(1);
		expect((await reload(step1.id)).notifiedAt).not.toBeNull();
	});

	it('SELECT の上限（REVIEW_QUERY_LIMIT）を超える分は次回に回す', async () => {
		const userId = await createTestUser(db);
		// 購読を持たせず sendPush 呼び出しコストを避ける（この件数だと SEND_BUDGET の
		// 検証ではなく REVIEW_QUERY_LIMIT 自体の検証にしたいため）。
		for (let i = 0; i < REVIEW_QUERY_LIMIT + 1; i++) {
			await createDueMemoWithReview(userId, { scheduledAt: new Date(Date.now() - 1000 - i) });
		}

		const summary = await notifyDueReviews(db, vapid);

		expect(summary.reviewsSelected).toBe(REVIEW_QUERY_LIMIT);
	});
});
