const INTEGER_PATTERN = /^\d+$/;

// 非負整数のみ受け付ける。空文字・小数・指数表記・負数はすべて 'invalid' にする
// （D1 の LIMIT/OFFSET に小数を渡すとクエリごと 500 になるため、ここで弾く）。
export function parsePaginationParam(value: string | null): number | undefined | 'invalid' {
	if (value === null) return undefined;
	if (!INTEGER_PATTERN.test(value)) return 'invalid';
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}
