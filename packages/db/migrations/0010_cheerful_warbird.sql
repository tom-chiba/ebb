ALTER TABLE `reviews` ADD `notification_attempted_at` integer;--> statement-breakpoint
CREATE INDEX `reviews_pending_notificationAttemptedAt_scheduledAt_idx` ON `reviews` (`notification_attempted_at`,`scheduled_at`,`id`) WHERE "reviews"."completed_at" is null and "reviews"."notified_at" is null;
