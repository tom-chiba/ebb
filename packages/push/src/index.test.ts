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
async function generateSubscriptionKeys(): Promise<{ p256dh: string; auth: string }> {
	const keyPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits'
	])) as CryptoKeyPair;
	const publicKeyBytes = new Uint8Array(
		(await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer
	);
	const authBytes = crypto.getRandomValues(new Uint8Array(16));
	return { p256dh: toBase64Url(publicKeyBytes), auth: toBase64Url(authBytes) };
}

describe('sendPush', () => {
	let vapid: VapidConfig;
	let subscription: PushSubscriptionRecord;

	beforeAll(async () => {
		vapid = await generateVapidConfig();
		const keys = await generateSubscriptionKeys();
		subscription = { endpoint: 'https://push.example.com/abc', ...keys };
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const payload = { memoId: 'memo-1', title: '復習の時間です', url: '/app/memos/memo-1' };

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
		expect(headers['content-encoding']).toBe('aesgcm');
		expect(headers.authorization).toMatch(/^WebPush /);
		// 送信されるボディは暗号化済みで、平文の JSON とは異なる
		// （少なくとも平文の title 文字列がそのまま出現しない）
		const bodyText = new TextDecoder().decode(init.body as Uint8Array);
		expect(bodyText).not.toContain(payload.title);
	});

	it.each([404, 410])('%i を返したら expired になる（リトライしない）', async (status) => {
		const fetchMock = mockFetchResolvedWith(status);
		const result = await sendPush(subscription, payload, vapid);
		expect(result).toEqual({ outcome: 'expired' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([429, 500, 503])(
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

	// auth は壊れていても例外を投げない（HKDF がダミーハッシュを返す）ため、
	// 下記2件が decodedByteLength ガードの唯一の防御線であり、実際に回帰を検出する
	// （ガードを外すと 'retryable' になって落ちることを実装時に確認済み）。
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
