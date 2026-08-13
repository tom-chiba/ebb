import { fail, redirect } from '@sveltejs/kit';
import { requireAuthedDb } from '$lib/server/api';
import {
	INVALID_FORM_SUBMISSION_MESSAGE,
	translateMemoValidationMessage
} from '$lib/server/form-messages';
import { ValidationError } from '$lib/server/errors';
import { getDefaultPresetId } from '$lib/server/interval-presets';
import { CONTENT_MAX_LENGTH, createMemo, TITLE_MAX_LENGTH } from '$lib/server/memos';
import { normalizeLineEndings } from '$lib/server/text';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => {
	// このページ自体は DB もユーザー固有データも読まないが、他の load/action と
	// 同じく個別に認可チェックを通しておく（このリポジトリの規約。#11: layout の
	// 保護はページの load のみが対象で action には及ばない）。将来このページの
	// load がユーザー固有の値を返すよう変更されても、認可チェックの追加を
	// 忘れる余地をなくす。
	requireAuthedDb(event);

	// bfcache 経由でこのページに戻ると、直前の送信で使ったのと同じ draftId・
	// 入力途中の値がブラウザにキャッシュされたまま復元される。そこで新しい内容に
	// 書き換えて送信すると、createMemo が同じ id を既存 memo とみなしてしまい
	// 中身を更新しないため、ユーザーの新しい入力が黙って破棄される。
	// no-store を返すことでこのページを bfcache の対象外にし、戻るたびに load が
	// 再実行されて新しい draftId が発行されるようにする。
	event.setHeaders({ 'cache-control': 'no-store' });

	// サーバー側で生成する冪等性キー。二重送信（ネットワーク再送・多重クリック）が
	// 起きても createMemo が同じ id を既存 memo とみなし、重複作成しない。
	return {
		draftId: crypto.randomUUID(),
		titleMaxLength: TITLE_MAX_LENGTH,
		contentMaxLength: CONTENT_MAX_LENGTH
	};
};

export const actions: Actions = {
	default: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const id = form.get('id');
		const title = form.get('title');
		const rawContent = form.get('content');

		if (typeof id !== 'string' || typeof title !== 'string' || typeof rawContent !== 'string') {
			return fail(400, {
				message: INVALID_FORM_SUBMISSION_MESSAGE,
				title: typeof title === 'string' ? title : '',
				content: typeof rawContent === 'string' ? rawContent : ''
			});
		}
		// ブラウザは <textarea> の送信時に改行を CRLF へ正規化するため、DB・
		// /api/memos（JSON、CRLF化されない）と改行コードを揃え、CRLF化で増えた
		// 文字数が maxlength（クライアント側、LFで数える）とずれて意図しない
		// 文字数超過エラーになるのを防ぐ。
		const content = normalizeLineEndings(rawContent);

		try {
			const intervalPresetId = await getDefaultPresetId(db, user.id);
			const memo = await createMemo(db, user.id, {
				id,
				title,
				content,
				intervalPresetId
			});
			// createMemo は同じ id の再送を「内容を比較せず」既存 memo をそのまま返す
			// （#13 の冪等性キー仕様。$lib/server/memos.ts・/api/memos の契約自体は
			// 変えていないので、他の呼び出し元にはこの比較は効かない）。bfcache 等で
			// 古い draftId のまま新しい内容を送信すると、ここで返る memo は古い内容の
			// ままになる。cache-control: no-store は多くのブラウザで bfcache を避ける
			// ヒントに過ぎず、これだけに依存せず、実際に保存された内容が今回の送信内容と
			// 一致するかをここで比較する。
			//
			// 一致しない場合、fail() は edit ページの 409 とは異なりこの load を
			// 再実行させ、hidden field の id は毎回 crypto.randomUUID() で新しく
			// 発行し直される（edit ページの expectedUpdatedAt のように送信時の値を
			// 送り返して固定化してはいない）。そのため実際には「保存」をもう一度押す
			// だけで新しい id により正しい内容のメモが作られる。メッセージは
			// 「再読み込みが必要」という誤った操作を要求しないよう、その旨だけ伝える。
			if (memo.title !== title || memo.content !== content) {
				return fail(409, {
					message: 'この内容はまだ保存されていません。もう一度「保存」を押してください。',
					title,
					content
				});
			}
			redirect(303, `/memos/${memo.id}`);
		} catch (err) {
			if (err instanceof ValidationError) {
				return fail(400, { message: translateMemoValidationMessage(err.message), title, content });
			}
			throw err;
		}
	}
};
