// #15/#16（間隔プリセットの管理・計算ロジック、reviews 生成）が未実装のため、
// メモ作成時に選べるプリセットは packages/db の migration 0006 で投入した
// システム標準プリセット1件のみ。#15/#16 が着地したら、ここはユーザーによる
// プリセット選択 UI に置き換わる想定（docs/design-decisions.md の #14 節を参照）。
export const DEFAULT_INTERVAL_PRESET_ID = 'system-standard';
