const INTEGER_PATTERN = /^\d+$/;

// 非負整数のみ受け付ける。空文字・小数・指数表記・負数はすべて 'invalid' にする
// （D1 の LIMIT/OFFSET に小数を渡すとクエリごと 500 になるため、ここで弾く）。
export function parsePaginationParam(value: string | null): number | undefined | 'invalid' {
	if (value === null) return undefined;
	if (!INTEGER_PATTERN.test(value)) return 'invalid';
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

export interface PaginationOptions {
	limit?: number;
	offset?: number;
}

// listMemos（#13）と listDueReviews（#17）で共通の limit/offset クランプ処理。
export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

// offset は下限（0）だけをクランプする（limit と違い上限は無い）。clamp() と同じく
// 非有限値（NaN・Infinity）は 0 にフォールバックする。
export function normalizeOffset(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}
