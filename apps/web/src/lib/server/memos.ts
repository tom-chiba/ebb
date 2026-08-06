import { error } from '@sveltejs/kit';
import {
	and,
	count,
	desc,
	eq,
	isNull,
	or,
	intervalPresets,
	memos,
	reviews,
	type Db
} from '@ebb/db';
import { nextReviewAt } from '@ebb/core';

export const TITLE_MAX_LENGTH = 200;
export const CONTENT_MAX_LENGTH = 50_000;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
// 楽観的並行性制御で、更新対象が最後に読んだ状態から変わっていた場合に投げる。
export class ConflictError extends Error {}

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

// intervals も返す。createMemo が reviews をバッチ生成する際に使う（#16）。
// updateMemo（プリセット変更時のアクセス可否チェックのみ、reviews は再生成しない）は
// 戻り値を無視して呼ぶ。
async function getAccessiblePreset(db: Db, userId: string, intervalPresetId: string) {
	const rows = await db
		.select({ intervals: intervalPresets.intervals })
		.from(intervalPresets)
		.where(
			and(
				eq(intervalPresets.id, intervalPresetId),
				or(isNull(intervalPresets.userId), eq(intervalPresets.userId, userId))
			)
		)
		.limit(1)
		.all();
	const preset = rows[0];
	if (!preset) {
		throw new ValidationError('intervalPresetId does not reference an accessible preset');
	}
	return preset;
}

export interface CreateMemoInput {
	// クライアントが生成した冪等性キー（memos.id と共用）。省略時はサーバー側で
	// crypto.randomUUID() が採番される。同じ id で再送されたリクエストは新規作成せず
	// 既存の memo をそのまま返す（POST がタイムアウト等で再送されても重複作成しない）。
	id?: string;
	title: string;
	content: string;
	intervalPresetId: string;
}

async function findOwnMemoById(db: Db, userId: string, id: string) {
	const rows = await db
		.select()
		.from(memos)
		.where(and(eq(memos.id, id), eq(memos.userId, userId)))
		.limit(1)
		.all();
	return rows[0];
}

// indexHint で該当テーブル/カラムのユニーク制約違反かを絞り込む。単に
// "UNIQUE constraint failed" だけを見ると、同じ操作内で複数のユニーク制約
// （memos.id と reviews_memoId_step_unique 等）が存在する場合に取り違える。
function isUniqueConstraintViolation(err: unknown, indexHint: string): boolean {
	if (!(err instanceof Error)) return false;
	const cause = err.cause instanceof Error ? err.cause.message : '';
	const message = `${err.message} ${cause}`;
	return /UNIQUE constraint failed/i.test(message) && message.includes(indexHint);
}

// preset.intervals の全ステップ分の reviews 行を作る。baseTime は呼び出し側から
// 固定の Date を渡してもらい、複数ステップの計算起点を同一時刻に揃える。
function buildReviewRows(memoId: string, baseTime: Date, intervals: readonly number[]) {
	return intervals.map((_, step) => {
		const scheduledAt = nextReviewAt(baseTime, intervals, step);
		// intervals[0..length-1] の範囲内なので nextReviewAt が undefined を返すことはない
		if (!scheduledAt) throw new Error(`nextReviewAt returned undefined for step ${step}`);
		return { memoId, step, scheduledAt };
	});
}

export async function createMemo(db: Db, userId: string, input: CreateMemoInput) {
	assertTitle(input.title);
	assertContent(input.content);
	const preset = await getAccessiblePreset(db, userId, input.intervalPresetId);

	if (input.id !== undefined) {
		const existing = await findOwnMemoById(db, userId, input.id);
		if (existing) return toMemoResponse(existing);
	}

	// id と createdAt/updatedAt をここで確定させ、memos への INSERT と reviews の
	// バッチ生成（#12 が #16 に指示した、メモ作成時に全ステップ分をまとめて生成する方針）
	// の起点時刻を揃える。DB 側のデフォルト値（unixepoch）に任せると、reviews.scheduledAt
	// の計算起点と memos.createdAt が別クロック起点になり、日時がわずかにずれてしまう。
	const id = input.id ?? crypto.randomUUID();
	const now = new Date();
	const insertMemo = db
		.insert(memos)
		.values({
			id,
			userId,
			title: input.title,
			content: input.content,
			intervalPresetId: input.intervalPresetId,
			createdAt: now,
			updatedAt: now
		})
		.returning();
	const reviewRows = buildReviewRows(id, now, preset.intervals);

	let insertedMemoRows: (typeof memos.$inferSelect)[];
	try {
		// D1 の batch は単一の暗黙トランザクションとして実行され、どちらかが失敗すれば
		// 両方ロールバックされる。intervals が空配列（#15 が明記した異常系）なら reviews は
		// 0 件でよく、空配列を insert すると失敗するため memos の INSERT のみ行う。
		if (reviewRows.length > 0) {
			[insertedMemoRows] = await db.batch([insertMemo, db.insert(reviews).values(reviewRows)]);
		} else {
			insertedMemoRows = await insertMemo;
		}
	} catch (err) {
		if (input.id !== undefined && isUniqueConstraintViolation(err, 'memos.id')) {
			const existing = await findOwnMemoById(db, userId, input.id);
			if (existing) return toMemoResponse(existing);
			throw new ValidationError('id is already in use');
		}
		throw err;
	}

	// archiveMemo と同じく、DB に実際に書き込まれた行から MemoResponse を組み立てる
	// （INSERT に渡した値を手元で再構築しない）。
	const memo = insertedMemoRows[0];
	if (!memo) throw new Error('failed to create memo');
	return toMemoResponse(memo);
}

export type UpdateMemoInput = Partial<Omit<CreateMemoInput, 'id'>>;

export async function updateMemo(
	db: Db,
	userId: string,
	id: string,
	expectedUpdatedAt: Date,
	input: UpdateMemoInput
) {
	// 存在・所有権・非アーカイブを最初に確認する。バリデーションを先に行うと、
	// 他人のメモやアーカイブ済みのメモに対する不正な入力が 404 ではなく 400 に
	// なってしまう（存在確認より前に ValidationError が投げられるため）。
	const existing = await getMemo(db, userId, id);

	if (input.title !== undefined) assertTitle(input.title);
	if (input.content !== undefined) assertContent(input.content);
	if (input.intervalPresetId !== undefined) {
		await getAccessiblePreset(db, userId, input.intervalPresetId);
	}

	// 指定されたフィールドだけを SET することで、他フィールドを対象にした同時 PATCH の
	// 変更を古い読み取り値で上書きしてしまう read-modify-write のロストアップデートを避ける。
	const set: Partial<typeof memos.$inferInsert> = {};
	if (input.title !== undefined) set.title = input.title;
	if (input.content !== undefined) set.content = input.content;
	if (input.intervalPresetId !== undefined) set.intervalPresetId = input.intervalPresetId;

	if (Object.keys(set).length === 0) {
		return existing;
	}

	// 楽観的並行性制御: クライアントが最後に読んだ updatedAt を WHERE 条件に含める。
	// 別のリクエストが先に更新していれば updatedAt がずれて 0 行ヒットになるため、
	// 同一フィールドへの同時更新が古い方で新しい方を黙って上書きすることを防ぐ。
	const rows = await db
		.update(memos)
		.set(set)
		.where(and(ownMemo(userId, id), eq(memos.updatedAt, expectedUpdatedAt)))
		.returning()
		.all();
	const updated = rows[0];
	if (updated) return toMemoResponse(updated);

	// 0 行だった理由が「そもそも対象が無くなった（同時アーカイブ等）」のか
	// 「バージョンが古い（同時更新）」のかを区別する。
	const stillOwned = await db
		.select({ id: memos.id })
		.from(memos)
		.where(ownMemo(userId, id))
		.limit(1)
		.all();
	if (stillOwned.length === 0) throw new NotFoundError('memo not found');
	throw new ConflictError('memo has been modified since it was last read');
}

// この関数だけ MemoResponse ではなく DB 行をそのまま返す。archiveMemo の戻り値は
// HTTP レイヤー（DELETE は 204 を返すのみ）では使われず、archivedAt が実際に
// セットされたことをテストから直接確認するための内部用途にとどまるため。
export async function archiveMemo(db: Db, userId: string, id: string) {
	await getMemo(db, userId, id);

	// アーカイブと同時に未完了（completedAt IS NULL）の reviews を削除する。
	// docs/schema.md が #21 への申し送りとして残していた「archived_at は reviews に
	// 伝播しない」というエッジケースは、削除する側を採用してここで解消する
	// （#16 の受け入れ条件「メモを削除すると予定も消える」に対応するため）。
	// 完了済み（completedAt が設定済み）の行は履歴として残す方針（#18 の再計算レシピが
	// 完了済みステップ数を起点にするための前提でもある）なので削除しない。
	const [archivedRows] = await db.batch([
		db.update(memos).set({ archivedAt: new Date() }).where(ownMemo(userId, id)).returning(),
		db.delete(reviews).where(and(eq(reviews.memoId, id), isNull(reviews.completedAt)))
	]);
	const archived = archivedRows[0];
	if (!archived) throw new NotFoundError('memo not found');
	return archived;
}

// ValidationError はクライアント自身の入力に関する情報なのでメッセージをそのまま返す。
// NotFoundError は「存在しない」と「他人のもの」を区別させないため、常に固定文言にする。
// ConflictError はクライアントに再取得の上でのリトライを促すため 409 にする。
export function handleMemoError(err: unknown): never {
	if (err instanceof ValidationError) error(400, err.message);
	if (err instanceof NotFoundError) error(404, 'Not Found');
	if (err instanceof ConflictError) error(409, err.message);
	throw err;
}
