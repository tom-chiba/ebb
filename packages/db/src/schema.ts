import { relations, sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { user } from './auth-schema';

// `pnpm --filter @ebb/db run generate:auth-schema` で生成（手動編集しない）。
export * from './auth-schema';

const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });
const nowDefault = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

// システム標準プリセットは user_id が NULL の行として表現する。
// 実データの投入（固定 slug の id での seed）は #15 に委ねる（このスキーマは形だけを定義する）。
export const intervalPresets = sqliteTable(
	'interval_presets',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		// 時間単位の間隔配列（例: [1, 6, 24, 72]）。最小単位・順序のバリデーションは #18 の責務
		intervals: text('intervals', { mode: 'json' }).$type<number[]>().notNull()
	},
	(table) => [index('interval_presets_userId_idx').on(table.userId)]
);

export const memos = sqliteTable(
	'memos',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		content: text('content').notNull(),
		intervalPresetId: text('interval_preset_id')
			.notNull()
			.references(() => intervalPresets.id),
		createdAt: timestampMs('created_at').default(nowDefault).notNull(),
		updatedAt: timestampMs('updated_at')
			.default(nowDefault)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		archivedAt: timestampMs('archived_at')
	},
	(table) => [
		index('memos_userId_idx').on(table.userId),
		// SQLite は FK に自動で索引を張らない。プリセット削除可否判定（#18）が
		// このカラムで検索するため必要
		index('memos_intervalPresetId_idx').on(table.intervalPresetId)
	]
);

export const reviews = sqliteTable(
	'reviews',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		memoId: text('memo_id')
			.notNull()
			.references(() => memos.id, { onDelete: 'cascade' }),
		// intervalPresets.intervals を引くための 0 始まりのインデックス
		step: integer('step').notNull(),
		scheduledAt: timestampMs('scheduled_at').notNull(),
		completedAt: timestampMs('completed_at'),
		notifiedAt: timestampMs('notified_at')
	},
	(table) => [
		index('reviews_memoId_idx').on(table.memoId),
		// scheduler が毎分「期限到来かつ未完了」を検索するための複合インデックス（#12 必須要件）
		index('reviews_scheduledAt_completedAt_idx').on(table.scheduledAt, table.completedAt),
		// バッチ生成・再計算（#16/#18）時の重複 INSERT を防ぐ
		unique('reviews_memoId_step_unique').on(table.memoId, table.step)
	]
);

export const pushSubscriptions = sqliteTable(
	'push_subscriptions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		endpoint: text('endpoint').notNull().unique(),
		p256dh: text('p256dh').notNull(),
		auth: text('auth').notNull(),
		createdAt: timestampMs('created_at').default(nowDefault).notNull(),
		lastUsedAt: timestampMs('last_used_at')
	},
	(table) => [index('push_subscriptions_userId_idx').on(table.userId)]
);

export const intervalPresetsRelations = relations(intervalPresets, ({ one, many }) => ({
	user: one(user, { fields: [intervalPresets.userId], references: [user.id] }),
	memos: many(memos)
}));

export const memosRelations = relations(memos, ({ one, many }) => ({
	user: one(user, { fields: [memos.userId], references: [user.id] }),
	intervalPreset: one(intervalPresets, {
		fields: [memos.intervalPresetId],
		references: [intervalPresets.id]
	}),
	reviews: many(reviews)
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
	memo: one(memos, { fields: [reviews.memoId], references: [memos.id] })
}));

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
	user: one(user, { fields: [pushSubscriptions.userId], references: [user.id] })
}));
