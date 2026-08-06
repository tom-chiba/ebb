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
