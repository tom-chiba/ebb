import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import { createDb, memos } from '@ebb/db';
import type { PageServerLoad } from './$types';

// 全ユーザーの memos を認可なしで返すため、開発環境限定にする（#12 で ping から実データに変更したため必須）
export const load: PageServerLoad = async ({ platform }) => {
	if (!dev) {
		error(404, 'Not Found');
	}
	if (!platform?.env.DB) {
		error(500, 'platform.env.DB is not available');
	}
	const db = createDb(platform.env.DB);
	try {
		const rows = await db.select().from(memos).all();
		return { rows };
	} catch {
		error(500, 'Failed to query D1. Has the migration been applied? (pnpm db:migrate:local)');
	}
};
