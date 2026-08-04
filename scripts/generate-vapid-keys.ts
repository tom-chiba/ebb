// VAPID 鍵ペア（ECDSA P-256）を生成し、環境変数として設定できる形式で出力する。
// 実行: node scripts/generate-vapid-keys.ts

export {};

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
	'sign',
	'verify',
]);

const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

if (!privateKeyJwk.d) {
	throw new Error('exportKey("jwk") で秘密鍵の d が取得できなかった');
}

console.log(`VAPID_PUBLIC_KEY=${toBase64Url(publicKeyBytes)}`);
console.log(`VAPID_PRIVATE_KEY=${privateKeyJwk.d}`);
