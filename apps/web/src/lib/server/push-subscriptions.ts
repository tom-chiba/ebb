import { and, eq, pushSubscriptions, type Db } from '@ebb/db';
import { ValidationError } from './errors';

// endpoint はブラウザ（正確には push service）が発行する一意な URL のため、
// 同じユーザーの複数デバイスからそれぞれ別の endpoint で購読できる
// （#19 の受け入れ条件: 同じユーザーの複数デバイスに対応する）。
// endpoint は pushSubscriptions テーブルでグローバルに unique（別ユーザーの
// アカウントで再ログインした同一デバイスが購読し直した場合は、以前の所有者の行を
// このユーザーのものへ上書きする）。
export async function savePushSubscription(
	db: Db,
	userId: string,
	endpoint: string,
	p256dh: string,
	auth: string
): Promise<void> {
	if (endpoint.length === 0 || p256dh.length === 0 || auth.length === 0) {
		throw new ValidationError('endpoint, p256dh, auth はすべて必須です');
	}
	await db
		.insert(pushSubscriptions)
		.values({ userId, endpoint, p256dh, auth })
		.onConflictDoUpdate({
			target: pushSubscriptions.endpoint,
			set: { userId, p256dh, auth, lastUsedAt: new Date() }
		});
}

// このユーザー自身が所有する購読のみ削除できる（他ユーザーの endpoint を指定しても
// 何も起きない）。戻り値で実際に削除された件数を返し、呼び出し側が
// 「本当に削除できたか」を確認できるようにする（#17 のバナー件数ズレと同型の
// 「実際には起きていない操作を成功として報告する」問題を避けるため）。
export async function deletePushSubscription(
	db: Db,
	userId: string,
	endpoint: string
): Promise<{ deletedCount: number }> {
	const deleted = await db
		.delete(pushSubscriptions)
		.where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)))
		.returning({ id: pushSubscriptions.id });
	return { deletedCount: deleted.length };
}
