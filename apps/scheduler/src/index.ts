import { createDb } from '@ebb/db';
import { readVapidConfig } from '@ebb/push';
import { notifyDueReviews } from './notify-due-reviews';

export default {
	async scheduled(event, env) {
		console.log(`[scheduler] fired at ${new Date(event.scheduledTime).toISOString()}`);
		const db = createDb(env.DB);
		try {
			const vapid = readVapidConfig(env);
			const summary = await notifyDueReviews(db, vapid, new Date(event.scheduledTime));
			console.log(
				`[scheduler] reviews: selected=${summary.reviewsSelected} processed=${summary.reviewsProcessed} deferred=${summary.reviewsDeferred} contended=${summary.reviewsContended} failed=${summary.reviewsFailed} / sends: attempted=${summary.sendsAttempted} succeeded=${summary.sendsSucceeded} failed=${summary.sendsFailed} / expired subscriptions: detected=${summary.expiredSubscriptions} deleted=${summary.expiredSubscriptionsDeleted} cleanup_failed=${summary.subscriptionCleanupFailed}`
			);
		} catch (err) {
			console.error('[scheduler] notifyDueReviews に失敗した:', err);
		}
	}
} satisfies ExportedHandler<Env>;
