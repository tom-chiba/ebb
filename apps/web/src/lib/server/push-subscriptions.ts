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

// このユーザー自身が所有する購読のみ削除する（他ユーザーの endpoint を指定しても
// 何も起きない）。「この endpoint はもう購読されていない」という状態を実現する
// 操作であり、対象行が最初から存在しない場合も目的の状態には既に達しているため
// 何も例外を投げない（削除対象が見つからないことをエラー扱いにすると、
// savePushSubscription が endpoint の所有権を別ユーザーへ付け替えた後にブラウザへ
// 購読が残ったままの端末からは二度と無効化できなくなる。正確性レビューで指摘）。
export async function deletePushSubscription(
	db: Db,
	userId: string,
	endpoint: string
): Promise<void> {
	await db
		.delete(pushSubscriptions)
		.where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)));
}
