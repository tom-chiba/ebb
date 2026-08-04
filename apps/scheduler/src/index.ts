import { count, createDb, ping } from '@ebb/db';

export default {
	async scheduled(event, env) {
		console.log(`[scheduler] fired at ${new Date(event.scheduledTime).toISOString()}`);
		const db = createDb(env.DB);
		try {
			const rows = await db.select({ value: count() }).from(ping);
			console.log(`[scheduler] ping rows: ${rows[0]?.value ?? 0}`);
		} catch {
			console.error('[scheduler] Failed to query D1. Has the migration been applied? (pnpm db:migrate:local)');
		}
	}
} satisfies ExportedHandler<Env>;
