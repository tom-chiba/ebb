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
