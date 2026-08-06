CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`default_interval_preset_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_interval_preset_id`) REFERENCES `interval_presets`(`id`) ON UPDATE no action ON DELETE set null
);
