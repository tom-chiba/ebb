import { relations, sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { user } from './auth-schema';

// `pnpm --filter @ebb/db run generate:auth-schema` で生成（手動編集しない）。
export * from './auth-schema';

// 本テーブルはもう使わないが、DROP はこの PR では行わない。deploy ワークフローは
// migrate → deploy の順で実行するため、ここで DROP すると旧バージョンの
// scheduler/debug ページ（まだ ping を参照している）が、自身の deploy が
// 完了するまでの間 "no such table: ping" で壊れる（docs/design-decisions.md の
// #7 節: 破壊的マイグレーションはこの順序前提を崩す、という指摘どおり）。
// 本番デプロイが完了し、旧バージョンを参照するコードが無くなったことを確認できた
// 後続 PR で DROP する。
export const ping = sqliteTable('ping', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	message: text('message').notNull()
});

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
		notifiedAt: timestampMs('notified_at'),
		// 送信予算不足で延期した review を未試行より後に回し、SELECT 上限の範囲外にある
		// review を永久に飢餓させないための最終試行日時。claim・延期時に更新する。
		notificationAttemptedAt: timestampMs('notification_attempted_at')
	},
	(table) => [
		index('reviews_memoId_idx').on(table.memoId),
		// scheduler が毎分「期限到来かつ未完了」を検索するための複合インデックス（#12 必須要件）
		index('reviews_scheduledAt_completedAt_idx').on(table.scheduledAt, table.completedAt),
		// 上記は scheduled_at が先頭の範囲条件のため completed_at 側では絞り込めず、
		// 完了済み行が蓄積すると scheduler のスキャン対象が増え続ける。未完了・未通知の
		// 行だけを対象にした部分インデックスを別途持たせ、scheduler の実クエリ
		// （WHERE scheduled_at <= ? AND completed_at IS NULL AND notified_at IS NULL）
		// が履歴の増加と無関係な件数でスキャンできるようにする
		index('reviews_pending_scheduledAt_idx')
			.on(table.scheduledAt)
			.where(sql`${table.completedAt} is null and ${table.notifiedAt} is null`),
		// scheduler は未試行（NULL）を先に、延期済みを後に並べる。scheduled_at を
		// 第2キーにして、各グループ内では古い review から処理する。
		index('reviews_pending_notificationAttemptedAt_scheduledAt_idx')
			.on(table.notificationAttemptedAt, table.scheduledAt, table.id)
			.where(sql`${table.completedAt} is null and ${table.notifiedAt} is null`),
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

// 新規メモ作成時に使う既定プリセット（#18）。ユーザーが未設定なら
// apps/web/src/lib/server/interval-presets.ts の DEFAULT_INTERVAL_PRESET_ID
// にフォールバックするため、ここでは行の存在自体を必須にしない
// （設定画面で一度も選択していないユーザーは行を持たない）。
// defaultIntervalPresetId は onDelete: 'set null' にしている。参照先のカスタム
// プリセットが削除された場合、ユーザーの既定設定を巻き込んでブロックせず、
// 静かにシステム標準へフォールバックさせる（プリセット削除可否の判定は
// memos の使用有無だけを見る。docs/design-decisions.md の #18 節を参照）。
export const userSettings = sqliteTable('user_settings', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	defaultIntervalPresetId: text('default_interval_preset_id').references(() => intervalPresets.id, {
		onDelete: 'set null'
	})
});

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

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
	user: one(user, { fields: [userSettings.userId], references: [user.id] }),
	defaultIntervalPreset: one(intervalPresets, {
		fields: [userSettings.defaultIntervalPresetId],
		references: [intervalPresets.id]
	})
}));
