import { fail, redirect } from '@sveltejs/kit';
import { requireAuthedDb } from '$lib/server/api';
import {
	INVALID_FORM_SUBMISSION_MESSAGE,
	translateMemoValidationMessage
} from '$lib/server/form-messages';
import { ConflictError, handleDomainError, ValidationError } from '$lib/server/errors';
import { CONTENT_MAX_LENGTH, getMemo, TITLE_MAX_LENGTH, updateMemo } from '$lib/server/memos';
import { normalizeLineEndings } from '$lib/server/text';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);
	try {
		const memo = await getMemo(db, user.id, event.params.id);
		// テンプレートが使うのは id/title/content/updatedAt のみ。userId・
		// intervalPresetId・createdAt は使わないので返さない（一覧・詳細ページと
		// 同じく、表示に使わないフィールドをクライアントへ送らない方針）。
		return {
			memo: { id: memo.id, title: memo.title, content: memo.content, updatedAt: memo.updatedAt },
			titleMaxLength: TITLE_MAX_LENGTH,
			contentMaxLength: CONTENT_MAX_LENGTH
		};
	} catch (err) {
		handleDomainError(err);
	}
};

export const actions: Actions = {
	default: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const title = form.get('title');
		const rawContent = form.get('content');
		const expectedUpdatedAtRaw = form.get('expectedUpdatedAt');

		if (
			typeof title !== 'string' ||
			typeof rawContent !== 'string' ||
			typeof expectedUpdatedAtRaw !== 'string'
		) {
			// expectedUpdatedAt が欠落した改ざんリクエストの場合、ここで '' を返すと
			// テンプレートの `form?.expectedUpdatedAt ?? data.memo.updatedAt...` が
			// `''`（falsy だが nullish ではない）にフォールバックせず、以後の再送が
			// 毎回 `new Date('')` で invalid になり続ける。undefined を返して
			// テンプレート側の `??` によるフォールバックを機能させる。
			return fail(400, {
				message: INVALID_FORM_SUBMISSION_MESSAGE,
				title: typeof title === 'string' ? title : '',
				content: typeof rawContent === 'string' ? rawContent : '',
				expectedUpdatedAt:
					typeof expectedUpdatedAtRaw === 'string' ? expectedUpdatedAtRaw : undefined,
				conflict: false
			});
		}
		// ブラウザは <textarea> の送信時に改行を CRLF へ正規化するため、DB・
		// /api/memos（JSON、CRLF化されない）と改行コードを揃え、CRLF化で増えた
		// 文字数が maxlength（クライアント側、LFで数える）とずれて意図しない
		// 文字数超過エラーになるのを防ぐ。
		const content = normalizeLineEndings(rawContent);
		const expectedUpdatedAt = new Date(expectedUpdatedAtRaw);
		if (Number.isNaN(expectedUpdatedAt.getTime())) {
			return fail(400, {
				message: INVALID_FORM_SUBMISSION_MESSAGE,
				title,
				content,
				expectedUpdatedAt: expectedUpdatedAtRaw,
				conflict: false
			});
		}

		try {
			const memo = await updateMemo(db, user.id, event.params.id, expectedUpdatedAt, {
				title,
				content
			});
			redirect(303, `/memos/${memo.id}`);
		} catch (err) {
			if (err instanceof ValidationError) {
				return fail(400, {
					message: translateMemoValidationMessage(err.message),
					title,
					content,
					expectedUpdatedAt: expectedUpdatedAtRaw,
					conflict: false
				});
			}
			if (err instanceof ConflictError) {
				// hidden field の expectedUpdatedAt に data.memo.updatedAt（load により競合相手の
				// 最新値へ更新されている）ではなく、今回の送信で使った古い値をそのまま送り返す。
				// これにより、ユーザーがエラーに気付かず「保存」を再度押しても同じ古い
				// expectedUpdatedAt で送信されるため再度 409 になり、競合相手の変更を
				// 無警告で上書きしてしまう事故を防ぐ。実際に更新された内容を見るには
				// ページの再読み込み（= load の再実行）が必要。
				//
				// new/+page.server.ts の hidden field `id` とは意図的に逆の対処をしている
				// （あちらは送信時の値を固定せず、load 再実行のたびに新しい draftId を
				// 発行させることで「保存」の再送だけで解決できるようにしている）。この
				// ページで同じパターンに揃えて `expectedUpdatedAt` にも
				// `form?.expectedUpdatedAt` を使わないフォールバックを足すと、まさに
				// この分岐が防いでいる無警告な上書きが再発するので、揃えないこと。
				//
				// このフォームは use:enhance を使っていないため、409 のレスポンスは
				// POST に対する通常の SSR ページ表示になる。ブラウザの「再読み込み」は
				// このページへの再送信になり、ブラウザの再送信確認ダイアログを経て
				// 承認すると同じ古い expectedUpdatedAt がそのまま再送され、また 409 に
				// なるだけでループから抜けられない。そこで conflict フラグを立て、
				// テンプレート側で同じ編集ページへの GET リンク（<a> タグでの通常の
				// ナビゲーション）を案内し、そちらから抜けられるようにする。
				return fail(409, {
					message: '他の変更と競合しました。下のリンクから最新の内容を確認してください。',
					title,
					content,
					expectedUpdatedAt: expectedUpdatedAtRaw,
					conflict: true
				});
			}
			handleDomainError(err);
		}
	}
};
