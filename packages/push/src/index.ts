import { buildPushPayload, type VapidKeys } from '@block65/webcrypto-web-push';

// packages/db の行そのままの形（p256dh/auth をネストさせない）で受け取る。
// @block65/webcrypto-web-push が要求する { keys: { p256dh, auth } } への変換は
// この関数の内部で行い、呼び出し側（apps/scheduler 等）に押し付けない。
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
// 「それ以外」は buildPushPayload 自体が失敗したか（`invalid`。subscription
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

// sendPush 自身はリトライしない。'retryable' の再試行可否は呼び出し側の配送保証に
// 委ねる。scheduler は Issue #21 の重複防止を優先し、送信試行後は再送しない。
export async function sendPush(
	subscription: PushSubscriptionRecord,
	payload: PushPayload,
	vapid: VapidConfig
): Promise<PushSendResult> {
	// sendPush が検証するのは「返す PushSendResult が不正確になり得る入力」だけで、
	// 内容（payload）は検証しない（design-decisions.md 参照）。endpoint（不正な URL
	// だと buildPushPayload 内の URL 解析が例外を投げる）と p256dh（壊れていれば
	// crypto.subtle.importKey が確実に例外を投げる）は、下の try/catch だけで
	// 既に invalid になるため明示的なチェックを置かない（5回目のレビューで
	// 指摘。起こり得ないシナリオへの防御的検証は書かない方針、ガードを外しても
	// 全テストが変わらず通ることを実測で確認済み）。
	//
	// 一方 auth は @block65/webcrypto-web-push の HKDF 実装がデコード後バイト長
	// 0 でも例外を投げずダミーハッシュで暗号化・送信まで進めてしまうため
	// （3回目のレビューで実測して発見）、"a" のような短い1文字（デコード後0バイト）
	// でも文字列としては空文字ではなく、try/catch では捕まらない。復号できない
	// 通知を「送信成功」として報告してしまうため、auth だけはデコード後のバイト長
	// （16バイトの共有シークレット）で明示的に弾く。これが唯一の防御線。
	if (decodedByteLength(subscription.auth) !== AUTH_SECRET_BYTE_LENGTH) {
		return { outcome: 'invalid' };
	}

	const vapidKeys: VapidKeys = vapid;

	let built: Awaited<ReturnType<typeof buildPushPayload>>;
	try {
		built = await buildPushPayload(
			{ data: payload },
			{
				endpoint: subscription.endpoint,
				expirationTime: null,
				keys: { p256dh: subscription.p256dh, auth: subscription.auth }
			},
			vapidKeys
		);
	} catch {
		// subscription または VAPID 鍵の形式が不正。詳細は意図的に握り、
		// vapid（秘密鍵を含む）や built.headers（署名済み VAPID JWT を含む）を
		// 一切メッセージに含めない。
		return { outcome: 'invalid' };
	}

	// buildPushPayload が返す body は Uint8Array<ArrayBufferLike> だが、
	// BodyInit は Uint8Array<ArrayBuffer> を要求するため詰め替える
	// （docs/web-push-spike.md で判明済みの罠）。
	const body = new Uint8Array(built.body);

	let response: Response;
	try {
		response = await fetch(subscription.endpoint, { ...built, body });
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
