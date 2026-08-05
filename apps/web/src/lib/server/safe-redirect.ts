// `redirectTo` はクエリパラメータ経由でユーザーが自由に指定できるため、そのまま
// `redirect()`/`callbackURL` に渡すとオープンリダイレクトになり得る。
// "/" で始まるかどうかの手書きチェックだけでは、ASCII タブ/改行を除去してから
// 解釈する WHATWG URL パーサーの挙動（例: "/\t/evil.com" → "//evil.com" → 外部オリジン）
// をブラウザ側の Location 解決と同じ形で防げない。ブラウザが実際に使うのと同じ
// URL パーサーにダミーのベース URL を渡し、解決後も origin が変わっていないパスのみを
// 同一オリジンへの遷移先として許可する。
const SAFE_BASE = 'https://safe-redirect.invalid';
// `SAFE_BASE` に将来パス等が付き origin と文字列表現がずれても比較が壊れないよう、
// 比較対象は `URL#origin` から導出する（`SAFE_BASE` の文字列と直接比較しない）。
const SAFE_ORIGIN = new URL(SAFE_BASE).origin;

export function toSafeRedirect(path: string | null, fallback: string): string {
	if (path) {
		try {
			const resolved = new URL(path, SAFE_BASE);
			if (resolved.origin === SAFE_ORIGIN) {
				return resolved.pathname + resolved.search + resolved.hash;
			}
		} catch {
			// path が URL として解析できない場合はフォールバックへ
		}
	}
	return fallback;
}
