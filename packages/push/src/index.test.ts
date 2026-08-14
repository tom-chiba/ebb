import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readVapidConfig, sendPush, type PushSubscriptionRecord, type VapidConfig } from './index';

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// scripts/generate-vapid-keys.ts と同じ手順で、テスト用の VAPID 鍵ペアを実際に生成する。
// ダミー文字列だと buildPushPayload 内の crypto.subtle.importKey が例外を投げ、
// 送信結果の分類ロジック（ステータスコード分岐）が一度も実行されないまま
// 全テストが 'invalid' で緑になってしまう。
async function generateVapidConfig(): Promise<VapidConfig> {
	const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
	const publicKeyBytes = new Uint8Array(
		(await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer
	);
	const privateKeyJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;
	if (!privateKeyJwk.d) {
		throw new Error('exportKey("jwk") で秘密鍵の d が取得できなかった');
	}
	return {
		subject: 'mailto:test@example.com',
		publicKey: toBase64Url(publicKeyBytes),
		privateKey: privateKeyJwk.d
	};
}

// ブラウザの pushManager.subscribe() が返す keys.p256dh / keys.auth と同じ形
// （p256dh は ECDH P-256 の raw 公開鍵、auth は 16 バイトの共有シークレット）を実際に生成する。
// privateKey は本来ブラウザ内に留まり外部には出てこないが、ラウンドトリップの復号
// テスト（「端末が実際に復号できるか」の唯一の代理検証）のためにここでは保持する。
async function generateSubscriptionKeys(): Promise<{
	p256dh: string;
	auth: string;
	privateKey: CryptoKey;
}> {
	const keyPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits'
	])) as CryptoKeyPair;
	const publicKeyBytes = new Uint8Array(
		(await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer
	);
	const authBytes = crypto.getRandomValues(new Uint8Array(16));
	return {
		p256dh: toBase64Url(publicKeyBytes),
		auth: toBase64Url(authBytes),
		privateKey: keyPair.privateKey
	};
}

function base64UrlToBytes(value: string): Uint8Array {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

// 実装の hkdfExpand / info 文字列を一切 import せず、RFC 8291 をこのテストで
// 独立に書き下す。実装と定数を共有すると、片方の info 文字列が間違っていても
// 両側で一致してテストが無意味に通ってしまう（アドバイザ指摘）。
async function independentHkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign'
	]);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

async function independentHkdfExpand(
	prk: Uint8Array,
	info: Uint8Array,
	length: number
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign'
	]);
	const infoAndCounter = new Uint8Array(info.length + 1);
	infoAndCounter.set(info, 0);
	infoAndCounter[info.length] = 0x01;
	const block = new Uint8Array(await crypto.subtle.sign('HMAC', key, infoAndCounter));
	return block.slice(0, length);
}

// 受信端末（Service Worker が動くブラウザ）が実際に行う復号を、実装のヘルパーを
// 一切使わずに独立実装し、平文が SW（apps/web/src/service-worker.ts）が期待する
// JSON と一致することを検証する。
async function decryptAes128GcmForTest(
	body: Uint8Array,
	receiverPrivateKey: CryptoKey,
	receiverPublicKeyBase64Url: string,
	authSecretBase64Url: string
): Promise<{ plaintext: string; recordSize: number; keyIdLength: number }> {
	const salt = body.slice(0, 16);
	const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
	const keyIdLength = body[20]!;
	const senderPublicKeyBytes = body.slice(21, 21 + keyIdLength);
	const ciphertext = body.slice(21 + keyIdLength);

	const senderPublicKey = await crypto.subtle.importKey(
		'raw',
		senderPublicKeyBytes,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[]
	);
	const sharedSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'ECDH', public: senderPublicKey } as Parameters<typeof crypto.subtle.deriveBits>[0],
			receiverPrivateKey,
			256
		)
	);

	const encoder = new TextEncoder();
	const authSecret = base64UrlToBytes(authSecretBase64Url);
	const receiverPublicKeyBytes = base64UrlToBytes(receiverPublicKeyBase64Url);

	const authInfoKey = await independentHkdfExtract(authSecret, sharedSecret);
	const ikm = await independentHkdfExpand(
		authInfoKey,
		new Uint8Array([
			...encoder.encode('WebPush: info\0'),
			...receiverPublicKeyBytes,
			...senderPublicKeyBytes
		]),
		32
	);
	const prk = await independentHkdfExtract(salt, ikm);
	const cekBytes = await independentHkdfExpand(
		prk,
		encoder.encode('Content-Encoding: aes128gcm\0'),
		16
	);
	const nonce = await independentHkdfExpand(prk, encoder.encode('Content-Encoding: nonce\0'), 12);

	const cek = await crypto.subtle.importKey('raw', cekBytes, { name: 'AES-GCM' }, false, [
		'decrypt'
	]);
	const decrypted = new Uint8Array(
		await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cek, ciphertext)
	);
	// 末尾は RFC 8188 の「最後のレコード」デリミタ 0x02
	if (decrypted[decrypted.length - 1] !== 0x02) {
		throw new Error('レコードデリミタ(0x02)が末尾にない');
	}
	const plaintext = new TextDecoder().decode(decrypted.slice(0, -1));
	return { plaintext, recordSize, keyIdLength };
}

describe('sendPush', () => {
	let vapid: VapidConfig;
	let subscription: PushSubscriptionRecord;
	let subscriptionPrivateKey: CryptoKey;

	beforeAll(async () => {
		vapid = await generateVapidConfig();
		const { privateKey, ...keys } = await generateSubscriptionKeys();
		subscription = { endpoint: 'https://push.example.com/abc', ...keys };
		subscriptionPrivateKey = privateKey;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const payload = { memoId: 'memo-1', title: '復習の時間です', url: '/memos/memo-1' };

	function mockFetchResolvedWith(status: number) {
		return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
	}

	it('2xx を返したら sent になり、暗号化済みの POST を送る', async () => {
		const fetchMock = mockFetchResolvedWith(201);
		const result = await sendPush(subscription, payload, vapid);
		expect(result).toEqual({ outcome: 'sent' });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [endpoint, init] = fetchMock.mock.calls[0]!;
		if (!init) {
			throw new Error('fetch の第2引数（RequestInit）が渡されていない');
		}
		expect(endpoint).toBe(subscription.endpoint);
		expect(init.method?.toLowerCase()).toBe('post');
		const headers = init.headers as Record<string, string>;
		expect(headers['content-encoding']).toBe('aes128gcm');
		expect(headers.authorization).toMatch(/^vapid /);
		expect(headers['content-type']).toBe('application/octet-stream');
		expect(headers.ttl).toBe('2419200');
		expect(headers.urgency).toBe('normal');
		// 送信されるボディは暗号化済みで、平文の JSON とは異なる
		// （少なくとも平文の title 文字列がそのまま出現しない）
		const bodyText = new TextDecoder().decode(init.body as Uint8Array);
		expect(bodyText).not.toContain(payload.title);
	});

	// 「FCM が2xxを返す」ことは実装の正しさを保証しない（#77 の発端そのもの
	// — legacy aesgcm でも FCM は受理していた）。唯一の信頼できる代理検証は、
	// 受信端末と同じ手順（実装のヘルパーは使わない独立実装）で実際に復号できること。
	it('送信したボディを受信側の手順で独立に復号すると、SW が期待する JSON と一致する', async () => {
		const fetchMock = mockFetchResolvedWith(201);
		await sendPush(subscription, payload, vapid);

		const [, init] = fetchMock.mock.calls[0]!;
		const body = init!.body as Uint8Array;
		const { plaintext, recordSize, keyIdLength } = await decryptAes128GcmForTest(
			body,
			subscriptionPrivateKey,
			subscription.p256dh,
			subscription.auth
		);

		expect(JSON.parse(plaintext)).toEqual(payload);
		expect(recordSize).toBe(4096);
		// idlen は 65（0x04 プレフィックス付き非圧縮点の ECDH 公開鍵長）
		expect(keyIdLength).toBe(65);
	});

	it('Authorization ヘッダの VAPID JWT が VAPID 公開鍵で正しく検証でき、aud/sub/exp が妥当', async () => {
		const fetchMock = mockFetchResolvedWith(201);
		await sendPush(subscription, payload, vapid);

		const [, init] = fetchMock.mock.calls[0]!;
		const headers = init!.headers as Record<string, string>;
		const authorization = headers.authorization;
		if (!authorization) {
			throw new Error('Authorization ヘッダが無い');
		}
		const match = authorization.match(/^vapid t=([^,]+), k=(.+)$/);
		if (!match) {
			throw new Error(`Authorization ヘッダの形式が不正: ${authorization}`);
		}
		const [, token, keyInHeader] = match as [string, string, string];
		expect(keyInHeader).toBe(vapid.publicKey);

		const [headerPart, claimsPart, signaturePart] = token.split('.');
		const publicKeyBytes = base64UrlToBytes(vapid.publicKey);
		const verifyKey = await crypto.subtle.importKey(
			'jwk',
			{
				kty: 'EC',
				crv: 'P-256',
				x: toBase64Url(publicKeyBytes.slice(1, 33)),
				y: toBase64Url(publicKeyBytes.slice(33, 65)),
				ext: true
			},
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify']
		);
		const signatureValid = await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			verifyKey,
			base64UrlToBytes(signaturePart!),
			new TextEncoder().encode(`${headerPart}.${claimsPart}`)
		);
		expect(signatureValid).toBe(true);

		const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(claimsPart!)));
		expect(claims.aud).toBe(new URL(subscription.endpoint).origin);
		expect(claims.sub).toBe(vapid.subject);
		expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	it.each([404, 410])('%i を返したら expired になる（リトライしない）', async (status) => {
		const fetchMock = mockFetchResolvedWith(status);
		const result = await sendPush(subscription, payload, vapid);
		expect(result).toEqual({ outcome: 'expired' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([408, 429, 500, 503])(
		'%i を返したら retryable になる（自身はリトライしない）',
		async (status) => {
			const fetchMock = mockFetchResolvedWith(status);
			const result = await sendPush(subscription, payload, vapid);
			expect(result).toEqual({ outcome: 'retryable' });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	);

	it('fetch が例外を投げたら retryable になる（ネットワークエラー、リトライしない）', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
		const result = await sendPush(subscription, payload, vapid);
		expect(result).toEqual({ outcome: 'retryable' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([400, 401, 403, 413])(
		'%i(404/410以外) を返したら status 付きの rejected になる',
		async (status) => {
			mockFetchResolvedWith(status);
			const result = await sendPush(subscription, payload, vapid);
			expect(result).toEqual({ outcome: 'rejected', status });
		}
	);

	// fetch を呼ばないことを確認するテストは、ガードが将来バイパスされても
	// 実ネットワークへ到達しないよう、パススルーではなく例外を投げるモックを使う。
	function mockFetchThrowsIfCalled() {
		return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
			throw new Error('fetch は呼ばれないはず');
		});
	}

	it('subscription の形式が不正なら fetch を呼ばずに invalid になる', async () => {
		const fetchMock = mockFetchThrowsIfCalled();
		const invalidSubscription: PushSubscriptionRecord = {
			...subscription,
			p256dh: 'not-a-valid-ec-public-key'
		};
		const result = await sendPush(invalidSubscription, payload, vapid);
		expect(result).toEqual({ outcome: 'invalid' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// endpoint・p256dh は明示的なガードを置かなくても、buildPushPayload の
	// try/catch（不正な URL・不正な EC 鍵はどちらも例外）で invalid になる
	// （5回目のレビュー指摘。起こり得ないシナリオへの防御的検証は書かない方針の
	// ため、ここでは auth だけを明示的にガードする）。
	it('subscription.endpoint が空文字なら fetch を呼ばずに invalid になる', async () => {
		const fetchMock = mockFetchThrowsIfCalled();
		const result = await sendPush({ ...subscription, endpoint: '' }, payload, vapid);
		expect(result).toEqual({ outcome: 'invalid' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('subscription.auth が空文字なら fetch を呼ばずに invalid になる', async () => {
		const fetchMock = mockFetchThrowsIfCalled();
		const result = await sendPush({ ...subscription, auth: '' }, payload, vapid);
		expect(result).toEqual({ outcome: 'invalid' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// auth は非ゼロの誤長（15/17バイト等）だと HKDF が例外を投げず素通りするため、
	// 下記2件が decodedByteLength ガードの唯一の防御線であり、実際に回帰を検出する
	// （ガードを外すと 'retryable' になって落ちることを実装時に確認済み。1文字
	// （デコード後0バイト）の方は importKey が例外を投げるため try/catch でも
	// 捕まるが、ガードを区別せず一律に弾く設計であることを確認する目的で残す）。
	it('subscription.auth が1文字（デコード後0バイト）でも fetch を呼ばずに invalid になる', async () => {
		const fetchMock = mockFetchThrowsIfCalled();
		const result = await sendPush({ ...subscription, auth: 'a' }, payload, vapid);
		expect(result).toEqual({ outcome: 'invalid' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('subscription.auth がデコードできても16バイトでなければ invalid になる', async () => {
		const fetchMock = mockFetchThrowsIfCalled();
		// 末尾2文字を削ると22文字→20文字（%4==0）になり、デコード自体は成功する
		// （15バイトになり、16バイトという期待値からずれる）
		const truncated = subscription.auth.slice(0, -2);
		const result = await sendPush({ ...subscription, auth: truncated }, payload, vapid);
		expect(result).toEqual({ outcome: 'invalid' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('VAPID 鍵の形式が不正でも例外を投げずに invalid になる（秘密鍵が漏れる経路を塞ぐ）', async () => {
		const fetchMock = mockFetchThrowsIfCalled();
		const invalidVapid: VapidConfig = { ...vapid, privateKey: 'not-a-valid-vapid-private-key' };
		await expect(sendPush(subscription, payload, invalidVapid)).resolves.toEqual({
			outcome: 'invalid'
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// payload の各フィールドは意図的にバリデーションしない（呼び出し側の責務）。
	// 空文字でも push サービスへはそのまま送られることを確認する。
	it('payload の各フィールドが空文字でもバリデーションせず送信する', async () => {
		mockFetchResolvedWith(201);
		const result = await sendPush(subscription, { memoId: '', title: '', url: '' }, vapid);
		expect(result).toEqual({ outcome: 'sent' });
	});
});

describe('readVapidConfig', () => {
	it('全て揃っていれば VapidConfig を返す', () => {
		const config = readVapidConfig({
			VAPID_SUBJECT: 'mailto:test@example.com',
			VAPID_PUBLIC_KEY: 'pub',
			VAPID_PRIVATE_KEY: 'priv'
		});
		expect(config).toEqual({
			subject: 'mailto:test@example.com',
			publicKey: 'pub',
			privateKey: 'priv'
		});
	});

	it('全て欠けていれば3つのキー名すべてを含むエラーを投げる', () => {
		expect(() => readVapidConfig({})).toThrowError(
			/VAPID_SUBJECT.*VAPID_PUBLIC_KEY.*VAPID_PRIVATE_KEY/
		);
	});

	it('空文字も欠落として扱う', () => {
		expect(() =>
			readVapidConfig({ VAPID_SUBJECT: '', VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' })
		).toThrowError(/VAPID_SUBJECT/);
	});

	it('不足しているキー名を含むエラーを投げる（値そのものは含めない）', () => {
		expect(() =>
			readVapidConfig({
				VAPID_SUBJECT: 'mailto:test@example.com',
				VAPID_PRIVATE_KEY: 'secret-value'
			})
		).toThrowError(/VAPID_PUBLIC_KEY/);

		let thrown: unknown;
		try {
			readVapidConfig({
				VAPID_SUBJECT: 'mailto:test@example.com',
				VAPID_PRIVATE_KEY: 'secret-value'
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).not.toContain('secret-value');
	});
});
