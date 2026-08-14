import { fail, redirect } from '@sveltejs/kit';
import { requireAuthedDb } from '$lib/server/api';
import {
	INVALID_FORM_SUBMISSION_MESSAGE,
	translateMemoValidationMessage
} from '$lib/server/form-messages';
import { ValidationError } from '$lib/server/errors';
import { getDefaultPresetId, listPresetsForUser } from '$lib/server/interval-presets';
import { CONTENT_MAX_LENGTH, createMemo, TITLE_MAX_LENGTH } from '$lib/server/memos';
import { normalizeLineEndings } from '$lib/server/text';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	// このページの load は間隔プリセット一覧・既定プリセットというユーザー固有データを
	// 読むため、他の load/action と同じく個別に認可チェックを通す（このリポジトリの
	// 規約。#11: layout の保護はページの load のみが対象で action には及ばない）。
	const { user, db } = requireAuthedDb(event);

	// bfcache 経由でこのページに戻ると、直前の送信で使ったのと同じ draftId・
	// 入力途中の値がブラウザにキャッシュされたまま復元される。そこで新しい内容に
	// 書き換えて送信すると、createMemo が同じ id を既存 memo とみなしてしまい
	// 中身を更新しないため、ユーザーの新しい入力が黙って破棄される。
	// no-store を返すことでこのページを bfcache の対象外にし、戻るたびに load が
	// 再実行されて新しい draftId が発行されるようにする。
	event.setHeaders({ 'cache-control': 'no-store' });

	// サーバー側で生成する冪等性キー。二重送信（ネットワーク再送・多重クリック）が
	// 起きても createMemo が同じ id を既存 memo とみなし、重複作成しない。
	const [presets, defaultPresetId] = await Promise.all([
		listPresetsForUser(db, user.id),
		getDefaultPresetId(db, user.id)
	]);

	return {
		draftId: crypto.randomUUID(),
		titleMaxLength: TITLE_MAX_LENGTH,
		contentMaxLength: CONTENT_MAX_LENGTH,
		presets: presets.map((preset) => ({ id: preset.id, name: preset.name })),
		defaultPresetId
	};
};

export const actions: Actions = {
	default: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const id = form.get('id');
		const title = form.get('title');
		const rawContent = form.get('content');
		const intervalPresetId = form.get('intervalPresetId');

		if (
			typeof id !== 'string' ||
			typeof title !== 'string' ||
			typeof rawContent !== 'string' ||
			typeof intervalPresetId !== 'string'
		) {
			return fail(400, {
				message: INVALID_FORM_SUBMISSION_MESSAGE,
				title: typeof title === 'string' ? title : '',
				content: typeof rawContent === 'string' ? rawContent : '',
				intervalPresetId: typeof intervalPresetId === 'string' ? intervalPresetId : undefined
			});
		}
		// ブラウザは <textarea> の送信時に改行を CRLF へ正規化するため、DB・
		// /api/memos（JSON、CRLF化されない）と改行コードを揃え、CRLF化で増えた
		// 文字数が maxlength（クライアント側、LFで数える）とずれて意図しない
		// 文字数超過エラーになるのを防ぐ。
		const content = normalizeLineEndings(rawContent);

		try {
			const memo = await createMemo(db, user.id, {
				id,
				title,
				content,
				intervalPresetId
			});
			// createMemo は同じ id の再送を「内容を比較せず」既存 memo をそのまま返す
			// （#13 の冪等性キー仕様。$lib/server/memos.ts・/api/memos の契約自体は
			// 変えていないので、他の呼び出し元にはこの比較は効かない）。bfcache 等で
			// 古い draftId のまま新しい内容（プリセット選択のみの変更を含む）を送信すると、
			// ここで返る memo は古い内容のままになる。cache-control: no-store は多くの
			// ブラウザで bfcache を避けるヒントに過ぎず、これだけに依存せず、実際に
			// 保存された内容が今回の送信内容と一致するかをここで比較する。
			//
			// 一致しない場合、fail() は edit ページの 409 とは異なりこの load を
			// 再実行させ、hidden field の id は毎回 crypto.randomUUID() で新しく
			// 発行し直される（edit ページの expectedUpdatedAt のように送信時の値を
			// 送り返して固定化してはいない）。そのため実際には「保存」をもう一度押す
			// だけで新しい id により正しい内容のメモが作られる。メッセージは
			// 「再読み込みが必要」という誤った操作を要求しないよう、その旨だけ伝える。
			if (
				memo.title !== title ||
				memo.content !== content ||
				memo.intervalPresetId !== intervalPresetId
			) {
				return fail(409, {
					message: 'この内容はまだ保存されていません。もう一度「保存」を押してください。',
					title,
					content,
					intervalPresetId
				});
			}
			redirect(303, `/memos/${memo.id}`);
		} catch (err) {
			if (err instanceof ValidationError) {
				return fail(400, {
					message: translateMemoValidationMessage(err.message),
					title,
					content,
					intervalPresetId
				});
			}
			throw err;
		}
	}
};
