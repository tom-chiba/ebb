import { error } from '@sveltejs/kit';
import { createDb, ping } from '@ebb/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	if (!platform?.env.DB) {
		error(500, 'platform.env.DB is not available');
	}
	const db = createDb(platform.env.DB);
	try {
		const rows = await db.select().from(ping).all();
		return { rows };
	} catch {
		error(500, 'Failed to query D1. Has the migration been applied? (pnpm db:migrate:local)');
	}
};
