import { error } from '@sveltejs/kit';
import { createDb, ping } from '@ebb/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	if (!platform) {
		error(500, 'platform.env is not available');
	}
	const db = createDb(platform.env.DB);
	const rows = await db.select().from(ping).all();
	return { rows };
};
