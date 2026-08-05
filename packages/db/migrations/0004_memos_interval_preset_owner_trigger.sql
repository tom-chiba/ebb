-- Custom SQL migration file, put your code below! --

-- memos.interval_preset_id は「同じユーザーのカスタムプリセット、またはシステム
-- 標準プリセット（interval_presets.user_id IS NULL）」のみを指せる。FK だけでは
-- 他テーブルの別カラムをまたいだ整合性チェック（複合 FK 相当）ができないため、
-- トリガーで強制する（docs/schema.md の「DB 層では強制できない不変条件」を参照）。
CREATE TRIGGER memos_interval_preset_owner_insert
BEFORE INSERT ON memos
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM interval_presets
	WHERE interval_presets.id = NEW.interval_preset_id
		AND (interval_presets.user_id IS NULL OR interval_presets.user_id = NEW.user_id)
)
BEGIN
	SELECT RAISE(ABORT, 'memos.interval_preset_id must reference a system preset or a preset owned by the same user');
END;
--> statement-breakpoint
CREATE TRIGGER memos_interval_preset_owner_update
BEFORE UPDATE OF interval_preset_id, user_id ON memos
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM interval_presets
	WHERE interval_presets.id = NEW.interval_preset_id
		AND (interval_presets.user_id IS NULL OR interval_presets.user_id = NEW.user_id)
)
BEGIN
	SELECT RAISE(ABORT, 'memos.interval_preset_id must reference a system preset or a preset owned by the same user');
END;