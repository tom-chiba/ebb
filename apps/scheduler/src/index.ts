import { createDb, ping } from '@ebb/db';

export default {
	async scheduled(event, env) {
		console.log(`[scheduler] fired at ${new Date(event.scheduledTime).toISOString()}`);
		const db = createDb(env.DB);
		const rows = await db.select().from(ping).all();
		console.log(`[scheduler] ping rows: ${rows.length}`);
	}
} satisfies ExportedHandler<Env>;
