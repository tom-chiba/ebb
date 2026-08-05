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

function ownMemo(userId: string, id: string) {
	return and(eq(memos.id, id), eq(memos.userId, userId), isNull(memos.archivedAt));
}

export async function listMemos(db: Db, userId: string, options: ListOptions = {}) {
	const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
	const offset = Math.max(0, options.offset ?? 0);
	const where = and(eq(memos.userId, userId), isNull(memos.archivedAt));

	const [items, totalRows] = await Promise.all([
		db
			.select()
			.from(memos)
			.where(where)
			.orderBy(desc(memos.createdAt))
			.limit(limit)
			.offset(offset)
			.all(),
		db.select({ total: count() }).from(memos).where(where).all()
	]);

	return { items, total: totalRows[0]?.total ?? 0, limit, offset };
}

export async function getMemo(db: Db, userId: string, id: string) {
	const rows = await db.select().from(memos).where(ownMemo(userId, id)).limit(1).all();
	const memo = rows[0];
	if (!memo) throw new NotFoundError('memo not found');
	return memo;
}

function clamp(value: number, min: number, max: number) {
	if (Number.isNaN(value)) return min;
	return Math.min(Math.max(value, min), max);
}

function assertTitleAndContent(title: string, content: string) {
	if (title.trim().length === 0) {
		throw new ValidationError('title is required');
	}
	if (title.length > TITLE_MAX_LENGTH) {
		throw new ValidationError(`title must be ${TITLE_MAX_LENGTH} characters or fewer`);
	}
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
	assertTitleAndContent(input.title, input.content);
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
	return memo;
}

export interface UpdateMemoInput {
	title?: string;
	content?: string;
	intervalPresetId?: string;
}

export async function updateMemo(db: Db, userId: string, id: string, input: UpdateMemoInput) {
	const existing = await getMemo(db, userId, id);

	const nextTitle = input.title ?? existing.title;
	const nextContent = input.content ?? existing.content;
	assertTitleAndContent(nextTitle, nextContent);

	const nextIntervalPresetId = input.intervalPresetId ?? existing.intervalPresetId;
	if (input.intervalPresetId !== undefined) {
		await assertPresetAccessible(db, userId, input.intervalPresetId);
	}

	const rows = await db
		.update(memos)
		.set({ title: nextTitle, content: nextContent, intervalPresetId: nextIntervalPresetId })
		.where(ownMemo(userId, id))
		.returning()
		.all();
	const updated = rows[0];
	if (!updated) throw new NotFoundError('memo not found');
	return updated;
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
