import { requireAuthedDb } from '$lib/server/api';
import { excerptOf } from '$lib/server/excerpt';
import { listMemosForBrowse } from '$lib/server/memos';
import { parsePaginationParam } from '$lib/server/pagination';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 20;

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);

	// /api/memos（#13）は不正な offset を 400 で弾くが、ここはリンクを辿るだけの
	// ページなので、手で書き換えられた・壊れた offset クエリは 1 ページ目への
	// フォールバックとして扱い、エラー画面は出さない（プログラム的なクライアント向けの
	// API と、人がブラウズするページとで意図的に挙動を変えている）。
	const offsetParam = parsePaginationParam(event.url.searchParams.get('offset'));
	const offset = typeof offsetParam === 'number' ? offsetParam : 0;
	const q = event.url.searchParams.get('q')?.trim() || undefined;

	const result = await listMemosForBrowse(db, user.id, { limit: PAGE_SIZE, offset, q });
	// 一覧は excerpt（先頭 80 文字程度）しか表示に使わないため、最大 50,000 文字の
	// content を丸ごとクライアントへ送らず、ここで切り詰めてから返す。
	return {
		...result,
		q: q ?? '',
		items: result.items.map((memo) => ({
			id: memo.id,
			title: memo.title,
			excerpt: excerptOf(memo.content),
			presetName: memo.presetName,
			nextScheduledAt: memo.nextScheduledAt
		}))
	};
};
