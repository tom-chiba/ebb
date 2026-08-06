import { redirect } from '@sveltejs/kit';
import { requireAuthedDb } from '$lib/server/api';
import { renderMarkdown } from '$lib/server/markdown';
import { archiveMemo, getMemo, handleMemoError } from '$lib/server/memos';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);
	try {
		const memo = await getMemo(db, user.id, event.params.id);
		// テンプレートが使うのは renderedContent（サニタイズ済み HTML）と id/title のみ。
		// 生の Markdown 本文（最大 50,000 文字）を二重に送らないよう、返す memo は
		// 使う項目だけに絞る。
		return {
			memo: { id: memo.id, title: memo.title },
			renderedContent: renderMarkdown(memo.content)
		};
	} catch (err) {
		handleMemoError(err);
	}
};

export const actions: Actions = {
	delete: async (event) => {
		const { user, db } = requireAuthedDb(event);
		try {
			await archiveMemo(db, user.id, event.params.id);
		} catch (err) {
			handleMemoError(err);
		}
		redirect(303, '/app/memos');
	}
};
