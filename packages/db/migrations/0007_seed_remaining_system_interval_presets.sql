-- Custom SQL migration file, put your code below! --

-- #15（packages/core に間隔プリセット・計算ロジックを実装する Issue）が、システム標準
-- プリセット3種（短期集中 / 標準 / 長期）の値を確定した（packages/core/src/index.ts の
-- SYSTEM_INTERVAL_PRESETS が単一の出所）。このうち「標準」は #14 が暫定措置として
-- migration 0006 で既に固定 id 'system-standard' として投入済みのため、ここでは
-- 残りの2件（短期集中 / 長期）のみを投入する（docs/schema.md の interval_presets 節を参照）。
INSERT INTO interval_presets (id, user_id, name, intervals)
VALUES
	('system-short', NULL, '短期集中', '[1,6,24,72]'),
	('system-long', NULL, '長期', '[24,168,720,2160]');