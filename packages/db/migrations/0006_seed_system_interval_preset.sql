-- Custom SQL migration file, put your code below! --

-- #14（メモ CRUD UI）がメモ作成時に intervalPresetId を必須で送る必要があるが、
-- 複数プリセットの管理・計算ロジックは #15 のスコープでまだ実装されていない。
-- #15 が定義済みの「標準」プリセット（1h,1d,3d,7d,14d,30d）を固定 id で1件だけ
-- 先行して投入し、#14 はこれを既定値として使う（#15/#16 到来時にプリセット選択・
-- 計算ロジックへ置き換わる前提の暫定措置。apps/web/src/lib/server/interval-presets.ts
-- 参照）。
INSERT INTO interval_presets (id, user_id, name, intervals)
VALUES ('system-standard', NULL, '標準', '[1,24,72,168,336,720]');