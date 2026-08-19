CREATE TABLE `review_schedules` (
	`memo_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`memo_id`) REFERENCES `memos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 既存メモ（このマイグレーション以前に作られた行）に version=0 の行をバックフィルする。
-- createMemo は以後の新規メモで review_schedules 行を同じ db.batch() で作るため、
-- ここでの対象は「このマイグレーション適用より前に作られた既存メモ」のみ。
INSERT INTO `review_schedules` (`memo_id`, `version`)
SELECT `id`, 0 FROM `memos`;
