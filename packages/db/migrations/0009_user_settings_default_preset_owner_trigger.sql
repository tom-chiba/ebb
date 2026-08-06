-- Custom SQL migration file, put your code below! --

-- user_settings.default_interval_preset_id は「同じユーザーのカスタムプリセット、
-- またはシステム標準プリセット（interval_presets.user_id IS NULL）」のみを指せる。
-- memos.interval_preset_id と全く同じ「他ユーザーの custom プリセットを指せてしまう」
-- 問題を持つため、0004_memos_interval_preset_owner_trigger.sql と同じ形のトリガーで
-- DB 層に強制する（アプリ層の書き込み経路は現時点で settings のアクション1本のみだが、
-- 将来的な書き漏らし・リトライ・メンテナンスクエリでの bypass を防ぐため、
-- memos と同じ判断を踏襲する）。default_interval_preset_id が NULL（未設定）の場合は
-- チェック対象外。
CREATE TRIGGER user_settings_default_preset_owner_insert
BEFORE INSERT ON user_settings
FOR EACH ROW
WHEN NEW.default_interval_preset_id IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM interval_presets
		WHERE interval_presets.id = NEW.default_interval_preset_id
			AND (interval_presets.user_id IS NULL OR interval_presets.user_id = NEW.user_id)
	)
BEGIN
	SELECT RAISE(ABORT, 'user_settings.default_interval_preset_id must reference a system preset or a preset owned by the same user');
END;
--> statement-breakpoint
CREATE TRIGGER user_settings_default_preset_owner_update
BEFORE UPDATE OF default_interval_preset_id, user_id ON user_settings
FOR EACH ROW
WHEN NEW.default_interval_preset_id IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM interval_presets
		WHERE interval_presets.id = NEW.default_interval_preset_id
			AND (interval_presets.user_id IS NULL OR interval_presets.user_id = NEW.user_id)
	)
BEGIN
	SELECT RAISE(ABORT, 'user_settings.default_interval_preset_id must reference a system preset or a preset owned by the same user');
END;