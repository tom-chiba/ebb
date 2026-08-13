import {
	and,
	count,
	desc,
	eq,
	isNull,
	intervalPresets,
	memos,
	reviews,
	sql,
	type Db
} from '@ebb/db';
import { nextReviewAt } from '@ebb/core';
import {
	ConflictError,
	isUniqueConstraintViolation,
	NotFoundError,
	ValidationError
} from './errors';
import { getAccessiblePreset } from './interval-presets';
import { clamp, normalizeOffset, type PaginationOptions } from './pagination';
import { minPendingScheduledAtSubquery } from './reviews';

export const TITLE_MAX_LENGTH = 200;
export const CONTENT_MAX_LENGTH = 50_000;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type ListOptions = PaginationOptions;

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
	const offset = normalizeOffset(options.offset);
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

// LIKE の特殊文字（\ % _）が検索語にそのまま含まれていると、意図しないワイルドカード
// 一致になる（例: "50%" というタイトルを検索したのに任意文字扱いされる）。バック
// スラッシュでエスケープし、ESCAPE 句で明示する。
function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export interface MemoBrowseItem {
	id: string;
	title: string;
	content: string;
	presetName: string;
	// このメモの未完了 reviews の中で最も早い scheduledAt（次回予定）。
	// 未完了 reviews が1件も無い（全ステップ完了済み）場合は null。
	nextScheduledAt: Date | null;
}

export interface ListMemosForBrowseOptions extends PaginationOptions {
	// メモ一覧のタイトル検索（#60）。空文字列・未指定は検索条件なし扱い。
	q?: string;
}

// メモ一覧画面（apps/web/src/routes/(app)/memos）専用。listMemos（/api/memos が使う
// 既存の契約）はそのまま維持し、この関数は画面表示に必要な追加フィールド（プリセット名・
// 次回予定）とタイトル検索を持つ別関数として用意する（設計判断: API のレスポンス形状を
// 変えないため）。
export async function listMemosForBrowse(
	db: Db,
	userId: string,
	options: ListMemosForBrowseOptions = {}
): Promise<{ items: MemoBrowseItem[]; total: number; limit: number; offset: number }> {
	const limit = clamp(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
	const offset = normalizeOffset(options.offset);
	const trimmedQuery = options.q?.trim();
	const where = and(
		eq(memos.userId, userId),
		isNull(memos.archivedAt),
		trimmedQuery ? sql`${memos.title} LIKE ${likePattern(trimmedQuery)} ESCAPE '\\'` : undefined
	);

	const minPendingScheduledAt = minPendingScheduledAtSubquery(db);

	const [rows, totalRows] = await Promise.all([
		db
			.select({
				id: memos.id,
				title: memos.title,
				content: memos.content,
				presetName: intervalPresets.name,
				nextScheduledAt: minPendingScheduledAt.minScheduledAt
			})
			.from(memos)
			.innerJoin(intervalPresets, eq(memos.intervalPresetId, intervalPresets.id))
			.leftJoin(minPendingScheduledAt, eq(minPendingScheduledAt.memoId, memos.id))
			.where(where)
			.orderBy(desc(memos.createdAt), desc(memos.id))
			.limit(limit)
			.offset(offset)
			.all(),
		db.select({ total: count() }).from(memos).where(where).all()
	]);

	return {
		items: rows.map((row) => ({
			id: row.id,
			title: row.title,
			content: row.content,
			presetName: row.presetName,
			nextScheduledAt: row.nextScheduledAt === null ? null : new Date(row.nextScheduledAt)
		})),
		total: totalRows[0]?.total ?? 0,
		limit,
		offset
	};
}

export async function getMemo(db: Db, userId: string, id: string) {
	const rows = await db.select().from(memos).where(ownMemo(userId, id)).limit(1).all();
	const memo = rows[0];
	if (!memo) throw new NotFoundError('memo not found');
	return toMemoResponse(memo);
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

// createMemo の冪等性チェック（findOwnMemoById）が見つけた既存メモに reviews が
// 1件も無い場合、その場で生成する。この状況は本来起こらないはずだが、#16 の
// デプロイ前（reviews 生成ロジックが存在しなかった時点）に作られたメモが、同じ
// クライアント生成 id で再送された場合に発生し得る（Codex adversarial レビューで
// 指摘）。既存メモ・既存プリセットの組み合わせのみを対象とし、新規メモの生成経路
// （createMemo 本体、intervals 空チェック含む）とは独立に、既に存在してしまった
// reviews 欠落を治癒するためだけの処理。
async function ensureReviewsExist(db: Db, memo: typeof memos.$inferSelect) {
	const existingReviews = await db
		.select({ id: reviews.id })
		.from(reviews)
		.where(eq(reviews.memoId, memo.id))
		.limit(1)
		.all();
	if (existingReviews.length > 0) return;

	const presetRows = await db
		.select({ intervals: intervalPresets.intervals })
		.from(intervalPresets)
		.where(eq(intervalPresets.id, memo.intervalPresetId))
		.limit(1)
		.all();
	const intervals = presetRows[0]?.intervals ?? [];
	if (intervals.length === 0) return;

	try {
		await db.insert(reviews).values(buildReviewRows(memo.id, memo.createdAt, intervals));
	} catch (err) {
		// 同時に複数のリトライが治癒を試みた場合、片方は reviews_memoId_step_unique に
		// 弾かれる。望む終状態（reviews が存在する）はもう一方の成功で既に満たされている。
		if (!isUniqueConstraintViolation(err, 'reviews.memo_id')) throw err;
	}
}

export async function createMemo(db: Db, userId: string, input: CreateMemoInput) {
	assertTitle(input.title);
	assertContent(input.content);
	const preset = await getAccessiblePreset(db, userId, input.intervalPresetId);
	// intervals が空の場合、reviews を1件も生成できない。空配列の妥当性検証自体は
	// #18（プリセット管理）の責務だが、既に存在してしまった空プリセットで
	// メモを作成すると、reviews が無いまま「静かに全ステップ完了状態」に見える
	// メモが生まれてしまうため、#16（メモ作成時の reviews 生成）としてここで拒否する
	// （docs/design-decisions.md の #15 節が明記する申し送り）。
	if (preset.intervals.length === 0) {
		throw new ValidationError('intervalPresetId references a preset with no intervals');
	}

	if (input.id !== undefined) {
		const existing = await findOwnMemoById(db, userId, input.id);
		if (existing) {
			await ensureReviewsExist(db, existing);
			return toMemoResponse(existing);
		}
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
		// 両方ロールバックされる。intervals は上のチェックにより常に1件以上のため、
		// reviewRows が空になることはない。
		[insertedMemoRows] = await db.batch([insertMemo, db.insert(reviews).values(reviewRows)]);
	} catch (err) {
		if (input.id !== undefined && isUniqueConstraintViolation(err, 'memos.id')) {
			const existing = await findOwnMemoById(db, userId, input.id);
			if (existing) {
				await ensureReviewsExist(db, existing);
				return toMemoResponse(existing);
			}
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
