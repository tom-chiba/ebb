import { fail } from '@sveltejs/kit';
import { ConflictError, NotFoundError, ValidationError } from './errors';

// ValidationError/NotFoundError/ConflictError をフォームアクションの fail() へ変換する。
// handleDomainError（$lib/server/errors）は SvelteKit の error() で投げる前提
// （load・+server.ts 向け）のため、フォームアクションではここで別途変換する。
// settings・プリセット追加・プリセット編集の各ルートから使う共通ヘルパーのため、
// NotFoundError のメッセージは呼び出し側が対象ドメインに応じて渡す。
// action・extra をジェネリクスで受けることで、fail() の返り値がリテラル型
// （action）と実際のプロパティ（extra の各キー）を保持する。string/Record<string,
// unknown> に広げると、+page.svelte 側の `'name' in form` 等の判別が `unknown` に
// しか narrowing できなくなり、型ガードが実質的に機能しなくなる。
export function formActionFail<A extends string, E extends Record<string, unknown>>(
	err: unknown,
	action: A,
	extra: E,
	notFoundMessage = '見つかりません'
) {
	if (err instanceof ValidationError) {
		return fail(400, { action, message: err.message, ...extra });
	}
	if (err instanceof NotFoundError) {
		return fail(404, { action, message: notFoundMessage, ...extra });
	}
	if (err instanceof ConflictError) {
		return fail(409, { action, message: err.message, ...extra });
	}
	throw err;
}

// プリセット系アクション専用の薄いラッパー。NotFoundError のメッセージが
// 全プリセットアクションで同じ固定文言のため、呼び出し箇所ごとの重複を避ける。
export function presetActionFail<A extends string, E extends Record<string, unknown>>(
	err: unknown,
	action: A,
	extra: E
) {
	return formActionFail(err, action, extra, 'プリセットが見つかりません');
}
