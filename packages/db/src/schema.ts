import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

// `pnpm --filter @ebb/db run generate:auth-schema` で生成（手動編集しない）。
export * from './auth-schema';

// 動作確認用の最小テーブル。実際のテーブル構成は #12 で設計する。
export const ping = sqliteTable('ping', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	message: text('message').notNull()
});
