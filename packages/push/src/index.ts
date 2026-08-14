// packages/db の行そのままの形（p256dh/auth をネストさせない）で受け取る。
export type PushSubscriptionRecord = {
	endpoint: string;
	p256dh: string;
	auth: string;
};

// 通知クリック時の遷移先（#22）と表示内容に必要な最小限。
export type PushPayload = {
	memoId: string;
	title: string;
	url: string;
};

export type VapidConfig = {
	subject: string;
	publicKey: string;
	privateKey: string;
};

// 成功（sent）/ 購読の失効（expired）/ 一時的な失敗（retryable）/ それ以外の2種類
// （invalid, rejected）。packages/push は packages/db に依存しない（docs/design-decisions.md）ため、
// 失効時の購読削除は呼び出し側の責務。expired は 404/410 のみを指す —
// 401/403（VAPID 鍵設定不正の可能性がある）を含めると、鍵の設定ミス1つで
// 全購読が誤って削除されかねないため、意図的に区別する。
// 「それ以外」は body/JWT の組み立て自体が失敗したか（`invalid`。subscription
// または VAPID 鍵のどちらの形式が不正なのかは区別しない）、push サービスが
// 404/408/410/429/5xx 以外のステータスを返したか（`rejected`。その送信固有の
// 問題）で区別する。`invalid` は「1件の購読だけがおかしい」場合と「VAPID
// 鍵の設定自体がおかしく全件が同じ理由で失敗する」場合の両方を含み得る
// （issue #20 が求める分類は3種類 + 成功のため、ここでは追加の判別子は設けない。
// 呼び出し側でその区別が必要になったら、VAPID 鍵はループの外側で一度だけ
// 検証するなど、呼び出し側で対処するのが妥当）。
export type PushSendResult =
	| { outcome: 'sent' }
	| { outcome: 'expired' }
	| { outcome: 'retryable' }
	| { outcome: 'invalid' }
	| { outcome: 'rejected'; status: number };

// base64url 文字列をデコードしたバイト長を返す。デコード不能（不正な base64）
// なら undefined を返す。
function decodedByteLength(base64Url: string): number | undefined {
	const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	try {
		return atob(padded).length;
	} catch {
		return undefined;
	}
}

// Web Push の共有シークレット（auth）のバイト長（RFC 8291 / 8292）。
const AUTH_SECRET_BYTE_LENGTH = 16;

const VAPID_ENV_KEYS = {
	subject: 'VAPID_SUBJECT',
	publicKey: 'VAPID_PUBLIC_KEY',
	privateKey: 'VAPID_PRIVATE_KEY'
} as const;

// readVapidConfig の引数型を VAPID_ENV_KEYS から導出する（キー名の重複を避ける）。
// index signature を持たない Cloudflare Workers の生成型（Env）をそのまま渡せるよう、
// 必要なキーだけを持つ形にする（Record<string, ...> は index signature を要求し、
// 生成型との構造的互換性が無くコンパイルエラーになる）。
type VapidEnvSource = Partial<Record<(typeof VAPID_ENV_KEYS)[keyof typeof VAPID_ENV_KEYS], string>>;

// 環境変数の名前をこの1箇所（VAPID_ENV_KEYS）に集約する。値そのものは
// エラーメッセージに含めない（不足しているキー名だけを報告する）。
export function readVapidConfig(env: VapidEnvSource): VapidConfig {
	const subject = env[VAPID_ENV_KEYS.subject];
	const publicKey = env[VAPID_ENV_KEYS.publicKey];
	const privateKey = env[VAPID_ENV_KEYS.privateKey];
	const missing = (
		[
			[VAPID_ENV_KEYS.subject, subject],
			[VAPID_ENV_KEYS.publicKey, publicKey],
			[VAPID_ENV_KEYS.privateKey, privateKey]
		] as const
	)
		.filter(([, value]) => !value)
		.map(([name]) => name);
	if (missing.length > 0) {
		throw new Error(`VAPID の環境変数が不足している: ${missing.join(', ')}`);
	}
	return { subject: subject!, publicKey: publicKey!, privateKey: privateKey! };
}

const textEncoder = new TextEncoder();

// RFC 8188 (aes128gcm) の record size。1レコードにしか対応しない実装だが、
// ヘッダには宣言が必須なため固定値を書く（参照実装 chat-with-nextjs-hono と同じ値）。
const AES_128_GCM_RECORD_SIZE = 4096;

function base64UrlToBytes(value: string): Uint8Array {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const raw = atob(padded);
	return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const length = parts.reduce((sum, part) => sum + part.length, 0);
	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

// crypto.subtle は ArrayBuffer を要求するため、Uint8Array のビュー範囲だけを
// 切り出す（他のバッファ領域を巻き込まないよう slice する）。
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function uint32BigEndian(value: number): Uint8Array {
	const result = new Uint8Array(4);
	new DataView(result.buffer).setUint32(0, value, false);
	return result;
}

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(salt),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, toArrayBuffer(ikm)));
}

// RFC 5869 の HKDF-Expand。ここで必要な出力長（16/12/32 バイト）は常に
// ハッシュ長（32 バイト）以下のため、常に1ブロック目だけを使えば足りる
// （2ブロック目以降の組み立ては実装しない）。
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(prk),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const block = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, toArrayBuffer(concatBytes(info, new Uint8Array([0x01]))))
	);
	return block.slice(0, length);
}

// RFC 8291（Message Encryption for Web Push）に沿った aes128gcm 暗号化。
// 参照実装: chat-with-nextjs-hono の apps/api/src/push.ts（#77 で実機検証済み）。
// @block65/webcrypto-web-push が実装する legacy な aesgcm（draft 版）は
// Android Chrome で FCM が受理しても端末に表示されないため、この自前実装に置き換えた。
async function encryptPayload(
	subscription: PushSubscriptionRecord,
	plaintext: string
): Promise<Uint8Array> {
	const receiverPublicKeyBytes = base64UrlToBytes(subscription.p256dh);
	const authSecret = base64UrlToBytes(subscription.auth);
	const receiverPublicKey = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(receiverPublicKeyBytes),
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[]
	);
	const senderKeyPair = (await crypto.subtle.generateKey(
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		['deriveBits']
	)) as CryptoKeyPair;
	const senderPublicKeyBytes = new Uint8Array(
		(await crypto.subtle.exportKey('raw', senderKeyPair.publicKey)) as ArrayBuffer
	);
	const sharedSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'ECDH', public: receiverPublicKey } as Parameters<typeof crypto.subtle.deriveBits>[0],
			senderKeyPair.privateKey,
			256
		)
	);

	const salt = crypto.getRandomValues(new Uint8Array(16));
	const authInfoKey = await hkdfExtract(authSecret, sharedSecret);
	const ikm = await hkdfExpand(
		authInfoKey,
		concatBytes(
			textEncoder.encode('WebPush: info\0'),
			receiverPublicKeyBytes,
			senderPublicKeyBytes
		),
		32
	);
	const prk = await hkdfExtract(salt, ikm);
	const contentEncryptionKeyBytes = await hkdfExpand(
		prk,
		textEncoder.encode('Content-Encoding: aes128gcm\0'),
		16
	);
	const nonce = await hkdfExpand(prk, textEncoder.encode('Content-Encoding: nonce\0'), 12);

	const contentEncryptionKey = await crypto.subtle.importKey(
		'raw',
		toArrayBuffer(contentEncryptionKeyBytes),
		{ name: 'AES-GCM' },
		false,
		['encrypt']
	);
	// 末尾 0x02 は RFC 8188 の「これが最後のレコード」を示すデリミタ。
	const record = concatBytes(textEncoder.encode(plaintext), new Uint8Array([0x02]));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: toArrayBuffer(nonce) },
			contentEncryptionKey,
			toArrayBuffer(record)
		)
	);

	// RFC 8188 のヘッダ形式: salt(16) | rs(4) | idlen(1) | keyid(idlen) | ciphertext
	return concatBytes(
		salt,
		uint32BigEndian(AES_128_GCM_RECORD_SIZE),
		new Uint8Array([senderPublicKeyBytes.length]),
		senderPublicKeyBytes,
		ciphertext
	);
}

function ecdsaSignatureToJose(signature: ArrayBuffer): Uint8Array {
	const bytes = new Uint8Array(signature);
	// crypto.subtle.sign({name: 'ECDSA'}) は既に IEEE P1363 (r|s 各32バイト) を返す
	// 環境がほとんどだが、DER (0x30 開始) を返す実装向けに変換もサポートする。
	if (bytes.length === 64) {
		return bytes;
	}
	if (bytes[0] !== 0x30) {
		throw new Error('サポート外の ECDSA 署名フォーマット');
	}
	let offset = 2;
	const rLength = bytes[offset + 1] ?? 0;
	const r = bytes.slice(offset + 2, offset + 2 + rLength);
	offset += 2 + rLength;
	const sLength = bytes[offset + 1] ?? 0;
	const s = bytes.slice(offset + 2, offset + 2 + sLength);
	return concatBytes(leftPad32(r), leftPad32(s));
}

function leftPad32(bytes: Uint8Array): Uint8Array {
	const withoutLeadingZero = bytes[0] === 0 ? bytes.slice(1) : bytes;
	if (withoutLeadingZero.length > 32) {
		throw new Error('不正な ECDSA 署名の整数値');
	}
	const result = new Uint8Array(32);
	result.set(withoutLeadingZero, 32 - withoutLeadingZero.length);
	return result;
}

async function importVapidPrivateKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
	const publicBytes = base64UrlToBytes(publicKey);
	// scripts/generate-vapid-keys.ts が exportKey('raw') で生成する非圧縮点形式
	// （0x04 プレフィックス + X(32) + Y(32) = 65 バイト）であることを前提にする。
	if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
		throw new Error('不正な VAPID 公開鍵');
	}
	return crypto.subtle.importKey(
		'jwk',
		{
			kty: 'EC',
			crv: 'P-256',
			x: bytesToBase64Url(publicBytes.slice(1, 33)),
			y: bytesToBase64Url(publicBytes.slice(33, 65)),
			d: privateKey.replace(/=+$/, ''),
			ext: false
		},
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign']
	);
}

function base64UrlEncodeJson(value: unknown): string {
	return bytesToBase64Url(textEncoder.encode(JSON.stringify(value)));
}

// RFC 8292（VAPID）の Authorization ヘッダに載せる ES256 JWT を生成する。
async function createVapidJwt(audience: string, vapid: VapidConfig): Promise<string> {
	const header = base64UrlEncodeJson({ typ: 'JWT', alg: 'ES256' });
	const claims = base64UrlEncodeJson({
		aud: audience,
		exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
		sub: vapid.subject
	});
	const input = `${header}.${claims}`;
	const key = await importVapidPrivateKey(vapid.publicKey, vapid.privateKey);
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		textEncoder.encode(input)
	);
	return `${input}.${bytesToBase64Url(ecdsaSignatureToJose(signature))}`;
}

// sendPush（送信・レスポンス判定）と debug/push の検証ページ（生のレスポンスを
// 見たい）の両方から使うため、リクエストの組み立てだけを切り出す。
export async function buildPushRequest(
	subscription: PushSubscriptionRecord,
	payload: PushPayload,
	vapid: VapidConfig
): Promise<{ url: string; init: RequestInit }> {
	// encryptPayload の戻り値は Uint8Array<ArrayBufferLike> だが、BodyInit は
	// Uint8Array<ArrayBuffer> を要求するため詰め替える（docs/web-push-spike.md で
	// 判明済みの罠。@block65/webcrypto-web-push の buildPushPayload でも同じ問題があった）。
	const body = new Uint8Array(await encryptPayload(subscription, JSON.stringify(payload)));
	const audience = new URL(subscription.endpoint).origin;
	const token = await createVapidJwt(audience, vapid);
	return {
		url: subscription.endpoint,
		init: {
			method: 'POST',
			headers: {
				authorization: `vapid t=${token}, k=${vapid.publicKey}`,
				'content-encoding': 'aes128gcm',
				'content-type': 'application/octet-stream',
				ttl: '2419200',
				urgency: 'normal'
			},
			body
		}
	};
}

// sendPush 自身はリトライしない。'retryable' の再試行可否は呼び出し側の配送保証に
// 委ねる。scheduler は Issue #21 の重複防止を優先し、送信試行後は再送しない。
export async function sendPush(
	subscription: PushSubscriptionRecord,
	payload: PushPayload,
	vapid: VapidConfig
): Promise<PushSendResult> {
	// sendPush が検証するのは「返す PushSendResult が不正確になり得る入力」だけで、
	// 内容（payload）は検証しない（design-decisions.md 参照）。endpoint（不正な URL
	// だと buildPushRequest 内の URL 解析が例外を投げる）と p256dh（壊れていれば
	// crypto.subtle.importKey が確実に例外を投げる）は、下の try/catch だけで
	// 既に invalid になるため明示的なチェックを置かない（5回目のレビューで
	// 指摘。起こり得ないシナリオへの防御的検証は書かない方針、ガードを外しても
	// 全テストが変わらず通ることを実測で確認済み）。
	//
	// 一方 auth は「デコード後バイト長が0でなければ」HKDF が例外を投げず、
	// 誤った長さの鍵のまま暗号化・送信まで進めてしまう（3回目のレビューで
	// 実測して発見。crypto.subtle.importKey('raw', ...) はゼロ長の鍵だけは
	// 例外を投げるが、15/17バイトのような非ゼロの誤長は素通りする）。
	// 復号できない通知を「送信成功」として報告してしまうため、auth だけは
	// デコード後のバイト長（16バイトの共有シークレット）で明示的に弾く。
	// これが唯一の防御線（"a" のような1文字はデコード後0バイトになり
	// try/catch でも捕まるが、それ以外の誤長は捕まらないため区別しない）。
	if (decodedByteLength(subscription.auth) !== AUTH_SECRET_BYTE_LENGTH) {
		return { outcome: 'invalid' };
	}

	let request: Awaited<ReturnType<typeof buildPushRequest>>;
	try {
		request = await buildPushRequest(subscription, payload, vapid);
	} catch {
		// subscription または VAPID 鍵の形式が不正。詳細は意図的に握り、
		// vapid（秘密鍵を含む）や署名済み VAPID JWT を一切メッセージに含めない。
		return { outcome: 'invalid' };
	}

	let response: Response;
	try {
		response = await fetch(request.url, request.init);
	} catch {
		return { outcome: 'retryable' };
	}

	if (response.ok) {
		return { outcome: 'sent' };
	}
	if (response.status === 404 || response.status === 410) {
		return { outcome: 'expired' };
	}
	if (response.status === 408 || response.status === 429 || response.status >= 500) {
		return { outcome: 'retryable' };
	}
	return { outcome: 'rejected', status: response.status };
}
