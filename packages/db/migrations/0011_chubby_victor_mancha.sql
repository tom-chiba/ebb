ALTER TABLE `user_settings` ADD `onboarding_seen_at` integer;
--> statement-breakpoint
-- この機能をリリースする前からの既存ユーザーを、次回アクセス時に一律オンボーディングへ
-- 強制送りしないための移行措置（#24）。以後に作成されるユーザーは行が無い/NULLのため
-- 通常どおりオンボーディングが表示される。
INSERT INTO `user_settings` (`user_id`, `onboarding_seen_at`)
SELECT `id`, CAST(unixepoch('subsecond') * 1000 AS INTEGER)
FROM `user`
WHERE `id` NOT IN (SELECT `user_id` FROM `user_settings`);
--> statement-breakpoint
UPDATE `user_settings`
SET `onboarding_seen_at` = CAST(unixepoch('subsecond') * 1000 AS INTEGER)
WHERE `onboarding_seen_at` IS NULL;