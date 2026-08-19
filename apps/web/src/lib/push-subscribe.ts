import { deserialize } from '$app/forms';

// 現在ページのフォームアクションへ POST し、結果を deserialize するだけの薄いヘルパー
// （$app/forms の deserialize は SvelteKit のアクション結果専用のシリアライズ形式を
// パースするため、呼び出し側で自前実装しない）。action は現在の URL からの相対パス
// （例: '?/subscribePush'）で、ルートごとに異なるアクションを指すことを前提にしている。
// 成功可否の判定・result.data の型ガードは呼び出し側の責務のまま残す
// （purposefully returns the raw ActionResult; settings/onboarding で success 判定や
// data の中身が異なるため）。
//
// 呼び出し側で `applyAction`（$app/forms）は使わないこと。`type: 'error'`
// （未処理例外による500）の結果を最寄りのエラーページへの全画面遷移として扱うため、
// ユーザー操作なしで onMount から実行されるバックグラウンド呼び出し
// （PushNotificationSettings の refreshSubscriptionState 等）がサーバー側の
// 一時的な失敗だけで画面全体をエラーページに差し替えてしまう
// （正確性レビューで指摘、settings #19）。
export async function postFormAction(action: string, body: FormData) {
	const response = await fetch(action, { method: 'POST', body });
	return deserialize(await response.text());
}

// pushManager.subscribe() が返した購読を保存用アクションへ送る共通処理
// （settings/#19・onboarding/#24 で重複していた）。savePushSubscription は endpoint に
// 対する upsert（$lib/server/push-subscriptions.ts 参照）のため、この呼び出しは常に
// 「今ログイン中のユーザーがこの endpoint の所有者になる」ことを意味する。
export async function submitPushSubscription(
	action: string,
	subscription: PushSubscription
): Promise<boolean> {
	const json = subscription.toJSON();
	if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
		throw new Error('購読情報の取得に失敗しました');
	}
	const body = new FormData();
	body.set('endpoint', json.endpoint);
	body.set('p256dh', json.keys.p256dh);
	body.set('auth', json.keys.auth);
	const result = await postFormAction(action, body);
	return result.type === 'success';
}

// pushManager.subscribe() の applicationServerKey は Uint8Array<ArrayBuffer> を
// 要求するため、VAPID 公開鍵の base64url 文字列をここで変換する（#8/#19 で共通利用）。
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
	const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
	const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(base64);
	// atob 直後の文字列長からアロケートすると Uint8Array<ArrayBuffer> になる
	// （Uint8Array.from は ArrayBufferLike のままで applicationServerKey の型に合わない）
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) {
		bytes[i] = raw.charCodeAt(i);
	}
	return bytes;
}

// 許可ダイアログ〜購読取得までの、settings（#19）・onboarding（#24）の両方で同一の
// ブラウザ API 呼び出し列。呼び出し元ごとに異なる状態表示・エラーメッセージ・
// サーバーへの保存方法（フォームアクションのパスがルートごとに違う）は呼び出し元に残す。
// 許可されなかった場合は null を返す（呼び出し元がそれぞれの文言で案内する）。
export async function requestPushSubscription(
	vapidPublicKey: string
): Promise<PushSubscription | null> {
	const permission = await Notification.requestPermission();
	if (permission !== 'granted') return null;

	// SvelteKit がページ読み込み時に自動で Service Worker を登録するため、
	// ここでは登録済みのものを待つだけでよい（自前で register() は呼ばない。
	// docs/design-decisions.md の #9 節を参照）。
	const registration = await navigator.serviceWorker.ready;
	return registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
	});
}

// 通知が無効なまま使っているユーザーへの控えめなリマインド（#24）表示可否の判定。
// 一度拒否した（denied）ユーザーへは、設定画面に既にある案内と重複するため出さない。
// 'granted' でもブラウザ側の購読が無い場合（購読の 410 Gone による削除など、
// docs/design-decisions.md 要注意点9）は「無効なまま」とみなしてリマインドする。
// サーバー上の購読レコードが同じ endpoint を指しているかまでは確認しない
// （所有権の再確認はユーザーが実際に有効化ボタンを押したときにのみ行う、既存方針と同じ）。
export async function needsPushReminder(): Promise<boolean> {
	if (typeof Notification === 'undefined') return false;
	// Firefox のプライベートウィンドウ等、Notification は存在するが serviceWorker が
	// 使えない環境で `navigator.serviceWorker.ready` を呼ぶと例外になる。
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
	if (Notification.permission === 'denied') return false;
	if (Notification.permission !== 'granted') return true;
	const registration = await navigator.serviceWorker.ready;
	const subscription = await registration.pushManager.getSubscription();
	return subscription === null;
}
