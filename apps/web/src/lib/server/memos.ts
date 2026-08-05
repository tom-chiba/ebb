import { error } from '@sveltejs/kit';
import { and, count, desc, eq, isNull, or, intervalPresets, memos, type Db } from '@ebb/db';

export const TITLE_MAX_LENGTH = 200;
export const CONTENT_MAX_LENGTH = 50_000;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

interface ListOptions {
	limit?: number;
	offset?: number;
}

// archivedAt は「一覧・取得できる memo は常に非アーカイブ」という不変条件により
// 公開 API 上は常に null にしかならないため、レスポンスから落とす。
// createdAt/updatedAt は JSON 化前の中間表現としての型で、`+server.ts` の
// json() でシリアライズされた後の実際のワイヤ上の値は ISO 文字列になる。
export interface MemoResponse {
	id: string;
	userId: string;
	title: string;
	content: string;
	intervalPresetId: string;
	createdAt: Date;
	updatedAt: Date;
}

function toMemoResponse(memo: typeof memos.$inferSelect): MemoResponse {
	return {
		id: memo.id,
		userId: memo.userId,
		title: memo.title,
		content: memo.content,
		intervalPresetId: memo.intervalPresetId,
		createdAt: memo.createdAt,
		updatedAt: memo.updatedAt
	};
}

function ownMemo(userId: string, id: string) {
	return and(eq(memos.id, id), eq(memos.userId, userId), isNull(memos.archivedAt));
}

export async function listMemos(db: Db, userId: string, options: ListOptions = {}) {
	const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
	const offset = Math.max(0, Math.trunc(options.offset ?? 0));
	const where = and(eq(memos.userId, userId), isNull(memos.archivedAt));

	const [items, totalRows] = await Promise.all([
		db
			.select()
			.from(memos)
			.where(where)
			// createdAt はミリ秒精度で同時刻の行が起こり得るため、id を tie-breaker にして
			// ページ間の順序を安定させる。
			.orderBy(desc(memos.createdAt), desc(memos.id))
			.limit(limit)
			.offset(offset)
			.all(),
		db.select({ total: count() }).from(memos).where(where).all()
	]);

	return { items: items.map(toMemoResponse), total: totalRows[0]?.total ?? 0, limit, offset };
}

export async function getMemo(db: Db, userId: string, id: string) {
	const rows = await db.select().from(memos).where(ownMemo(userId, id)).limit(1).all();
	const memo = rows[0];
	if (!memo) throw new NotFoundError('memo not found');
	return toMemoResponse(memo);
}

function clamp(value: number, min: number, max: number) {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

function assertTitle(title: string) {
	if (title.trim().length === 0) {
		throw new ValidationError('title is required');
	}
	if (title.length > TITLE_MAX_LENGTH) {
		throw new ValidationError(`title must be ${TITLE_MAX_LENGTH} characters or fewer`);
	}
}

function assertContent(content: string) {
	if (content.length > CONTENT_MAX_LENGTH) {
		throw new ValidationError(`content must be ${CONTENT_MAX_LENGTH} characters or fewer`);
	}
}

async function assertPresetAccessible(db: Db, userId: string, intervalPresetId: string) {
	const rows = await db
		.select({ id: intervalPresets.id })
		.from(intervalPresets)
		.where(
			and(
				eq(intervalPresets.id, intervalPresetId),
				or(isNull(intervalPresets.userId), eq(intervalPresets.userId, userId))
			)
		)
		.limit(1)
		.all();
	if (rows.length === 0) {
		throw new ValidationError('intervalPresetId does not reference an accessible preset');
	}
}

export interface CreateMemoInput {
	title: string;
	content: string;
	intervalPresetId: string;
}

export async function createMemo(db: Db, userId: string, input: CreateMemoInput) {
	assertTitle(input.title);
	assertContent(input.content);
	await assertPresetAccessible(db, userId, input.intervalPresetId);

	const rows = await db
		.insert(memos)
		.values({
			userId,
			title: input.title,
			content: input.content,
			intervalPresetId: input.intervalPresetId
		})
		.returning()
		.all();
	const memo = rows[0];
	if (!memo) throw new Error('failed to create memo');
	return toMemoResponse(memo);
}

export type UpdateMemoInput = Partial<CreateMemoInput>;

export async function updateMemo(db: Db, userId: string, id: string, input: UpdateMemoInput) {
	if (input.title !== undefined) assertTitle(input.title);
	if (input.content !== undefined) assertContent(input.content);
	if (input.intervalPresetId !== undefined) {
		await assertPresetAccessible(db, userId, input.intervalPresetId);
	}

	// 指定されたフィールドだけを SET することで、他フィールドを対象にした同時 PATCH の
	// 変更を古い読み取り値で上書きしてしまう read-modify-write のロストアップデートを避ける。
	const set: Partial<typeof memos.$inferInsert> = {};
	if (input.title !== undefined) set.title = input.title;
	if (input.content !== undefined) set.content = input.content;
	if (input.intervalPresetId !== undefined) set.intervalPresetId = input.intervalPresetId;

	if (Object.keys(set).length === 0) {
		return getMemo(db, userId, id);
	}

	const rows = await db.update(memos).set(set).where(ownMemo(userId, id)).returning().all();
	const updated = rows[0];
	if (!updated) throw new NotFoundError('memo not found');
	return toMemoResponse(updated);
}

export async function archiveMemo(db: Db, userId: string, id: string) {
	await getMemo(db, userId, id);

	const rows = await db
		.update(memos)
		.set({ archivedAt: new Date() })
		.where(ownMemo(userId, id))
		.returning()
		.all();
	const archived = rows[0];
	if (!archived) throw new NotFoundError('memo not found');
	return archived;
}

// ValidationError はクライアント自身の入力に関する情報なのでメッセージをそのまま返す。
// NotFoundError は「存在しない」と「他人のもの」を区別させないため、常に固定文言にする。
export function handleMemoError(err: unknown): never {
	if (err instanceof ValidationError) error(400, err.message);
	if (err instanceof NotFoundError) error(404, 'Not Found');
	throw err;
}
