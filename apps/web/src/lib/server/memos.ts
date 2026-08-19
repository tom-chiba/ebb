import {
	and,
	count,
	desc,
	eq,
	isCurrentPendingReview,
	isNull,
	intervalPresets,
	memos,
	or,
	reviews,
	reviewSchedules,
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
import { commitReviewRecalculation, planReviewRecalculation } from './reviews';

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

function likeContains(column: typeof memos.title | typeof memos.content, pattern: string) {
	return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}

// タイトル・本文検索（#28）。FTS5/trigram は検討したが不要と判断した
// （docs/design-decisions.md の「タイトル・本文の全文検索 (#28)」節を参照）。
function memoSearchCondition(q: string) {
	const pattern = likePattern(q);
	return or(likeContains(memos.title, pattern), likeContains(memos.content, pattern));
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
	// メモ一覧のタイトル・本文検索（#60 でタイトルのみ導入、#28 で本文も対象に拡張）。
	// 空文字列・未指定は検索条件なし扱い。
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
		trimmedQuery ? memoSearchCondition(trimmedQuery) : undefined
	);

	// 「次回予定」はメモの現在の未完了 step（@ebb/db の isCurrentPendingReview、#83 で
	// 一元化した中核実装）の scheduledAt。全ステップ完了済み（該当行なし）のメモは
	// LEFT JOIN 側で null になる。
	const [rows, totalRows] = await Promise.all([
		db
			.select({
				id: memos.id,
				title: memos.title,
				content: memos.content,
				presetName: intervalPresets.name,
				nextScheduledAt: reviews.scheduledAt
			})
			.from(memos)
			.innerJoin(intervalPresets, eq(memos.intervalPresetId, intervalPresets.id))
			.leftJoin(reviews, and(eq(reviews.memoId, memos.id), isCurrentPendingReview(db)))
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
			nextScheduledAt: row.nextScheduledAt
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
		// D1 の batch は単一の暗黙トランザクションとして実行され、どれかが失敗すれば
		// 全てロールバックされる。intervals は上のチェックにより常に1件以上のため、
		// reviewRows が空になることはない。review_schedules 行は Issue #85 の
		// 楽観ロック用で、以後このメモに1:1で存在する前提を作る（version=0 始まり）。
		[insertedMemoRows] = await db.batch([
			insertMemo,
			db.insert(reviews).values(reviewRows),
			db.insert(reviewSchedules).values({ memoId: id, version: 0 })
		]);
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

// intervalPresetId はここには含まれない。プリセット変更は reviews の再計算を
// 伴うため、通常の title/content 更新から分離した changeMemoPreset の責務とする
// （#82、docs/design-decisions.md の #82 節）。
export type UpdateMemoInput = Partial<Pick<CreateMemoInput, 'title' | 'content'>>;

// updateMemo・changeMemoPreset で共通の title/content バリデーション＋SET
// オブジェクト構築（設計レビューで指摘、重複コード解消）。指定されたフィールド
// だけを SET することで、他フィールドを対象にした同時 PATCH の変更を古い読み取り
// 値で上書きしてしまう read-modify-write のロストアップデートを避ける。
function buildTitleContentSet(input: UpdateMemoInput): Partial<typeof memos.$inferInsert> {
	if (input.title !== undefined) assertTitle(input.title);
	if (input.content !== undefined) assertContent(input.content);

	const set: Partial<typeof memos.$inferInsert> = {};
	if (input.title !== undefined) set.title = input.title;
	if (input.content !== undefined) set.content = input.content;
	return set;
}

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
	const set = buildTitleContentSet(input);

	if (Object.keys(set).length === 0) {
		return existing;
	}

	// 楽観的並行性制御: クライアントが最後に読んだ updatedAt を WHERE 条件に含める。
	// 別のリクエストが先に更新していれば updatedAt がずれて 0 行ヒットになるため、
	// 同一フィールドへの同時更新が古い方で新しい方を黙って上書きすることを防ぐ。
	const rows = await applyMemoUpdate(db, userId, id, expectedUpdatedAt, set);
	return resolveUpdateResult(db, userId, id, rows[0]);
}

export interface ChangeMemoPresetInput extends UpdateMemoInput {
	intervalPresetId: string;
}

// メモのプリセット変更専用ユースケース（#82）。updateMemo から分離し、
// intervalPresetId が実際に変わる場合にのみ、memo の UPDATE と reviews の
// 再計算（$lib/server/reviews.ts の planReviewRecalculation、#18 のレシピ）を
// 同じ db.batch() で実行する。編集画面のフォームは常に intervalPresetId を
// 送ってくる（selectedPresetId が必ず埋まっている）ため、呼び出し側はまず
// title/content と合わせてこの関数に渡し、実際に変更があったかはここで判定する。
// updateMemo・changeMemoPreset で共通の、楽観ロック付き UPDATE 本体（設計
// レビューで指摘、重複コード解消）。
function applyMemoUpdate(
	db: Db,
	userId: string,
	id: string,
	expectedUpdatedAt: Date,
	set: Partial<typeof memos.$inferInsert>
) {
	return db
		.update(memos)
		.set(set)
		.where(and(ownMemo(userId, id), eq(memos.updatedAt, expectedUpdatedAt)))
		.returning()
		.all();
}

export async function changeMemoPreset(
	db: Db,
	userId: string,
	id: string,
	expectedUpdatedAt: Date,
	input: ChangeMemoPresetInput
) {
	const existing = await getMemo(db, userId, id);
	const set = buildTitleContentSet(input);

	let newIntervals: readonly number[] | undefined;
	if (input.intervalPresetId !== existing.intervalPresetId) {
		const preset = await getAccessiblePreset(db, userId, input.intervalPresetId);
		// createMemo と同じ理由（reviews が1件も生成できず、静かに「全ステップ完了」に
		// 見えるメモが生まれる）で拒否する。#18 の時点でこの検証を持たない空プリセットが
		// 既に存在し得るため、既存メモ作成時だけでなくここでも確認する。
		if (preset.intervals.length === 0) {
			throw new ValidationError('intervalPresetId references a preset with no intervals');
		}
		newIntervals = preset.intervals;
		set.intervalPresetId = input.intervalPresetId;
	}

	if (Object.keys(set).length === 0) {
		return existing;
	}

	// プリセットが変わらない場合、reviews に一切触れない従来どおりの単一 UPDATE。
	if (!newIntervals) {
		const rows = await applyMemoUpdate(db, userId, id, expectedUpdatedAt, set);
		return resolveUpdateResult(db, userId, id, rows[0]);
	}

	// この呼び出し自身の UPDATE が実際に勝ったことを、失敗時の復元処理（下記 catch
	// 節）で判別するための目印。明示的にここで確定させた値を SET する
	// （completeReview の wonThisCompletion が `completedAt = new Date()` を使うのと
	// 同じ理由）。
	const thisChangeStamp = new Date();
	set.updatedAt = thisChangeStamp;

	// プリセットが変わる場合は2段階に分ける: 1) memo の UPDATE だけを先に確定させ、
	// 2) それが勝った場合にのみ reviews の再計算を別の db.batch() で実行する
	// （経緯・却下した設計は docs/design-decisions.md の #82 節を参照）。
	const rows = await applyMemoUpdate(db, userId, id, expectedUpdatedAt, set);
	const updatedMemo = rows[0];
	if (!updatedMemo) {
		return resolveUpdateResult(db, userId, id, undefined);
	}

	const plan = await planReviewRecalculation(db, id, newIntervals);

	// Issue #85: reviews の DELETE + review_schedules.version の bump を claim として
	// 1つの db.batch() で実行し、plan 作成時の version からずれていないか（＝1) の直後・
	// 2) の実行前に別リクエストの completeReview・別のプリセット変更が割り込んでいないか）
	// を判定する。version 不一致・対象メモのアーカイブは commitReviewRecalculation 内部の
	// ガードで検出され、DB 制約エラーの文字列判定に主に依存することはなくなった（経緯は
	// docs/design-decisions.md の #82・#85 節を参照）。
	try {
		await commitReviewRecalculation(db, id, plan);
	} catch (err) {
		// この呼び出し自身の書き込み（thisChangeStamp で識別）がまだ現在の値である場合に
		// 限り、1) で確定させた全フィールド（title・content・intervalPresetId）を呼び出し前の
		// 状態へ戻す。intervalPresetId だけを戻すと、同じ呼び出しで一緒に確定していた
		// title・content が静かに確定したまま残ってしまう（409 を返したのに一部フィールドだけ
		// 保存される部分適用。正確性レビューで指摘）。他の誰かが既にこのメモを更に更新して
		// いた場合は、その更新を上書きしないよう戻さない。
		await db
			.update(memos)
			.set({
				title: existing.title,
				content: existing.content,
				intervalPresetId: existing.intervalPresetId
			})
			.where(and(eq(memos.id, id), eq(memos.updatedAt, thisChangeStamp)));
		throw err;
	}

	return toMemoResponse(updatedMemo);
}

// updateMemo・changeMemoPreset で共通の「0行だった理由の判別」。0行だった理由が
// 「そもそも対象が無くなった（同時アーカイブ等）」のか「バージョンが古い
// （同時更新）」のかを区別する（設計レビューで指摘、2箇所で一字一句同じ判定
// ロジックが重複していたのを共通化した）。
async function resolveUpdateResult(
	db: Db,
	userId: string,
	id: string,
	updated: typeof memos.$inferSelect | undefined
) {
	if (updated) return toMemoResponse(updated);

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
	// review_schedules.version も同じ batch で進める（Issue #85）。この呼び出しは
	// getMemo で既に所有権・非アーカイブを確認済みなので version の一致は問わず、常に
	// 進めてよい。これにより、この削除より前に読み取られた version を前提にした
	// changeMemoPreset・updateCustomPresetIntervals の claim は必ず版不一致で負け、
	// アーカイブ後に未完了 review が復活しない（claimReviewSchedule 側でも
	// archivedAt を直接確認しているため、二重の安全策になる）。
	const [archivedRows] = await db.batch([
		db.update(memos).set({ archivedAt: new Date() }).where(ownMemo(userId, id)).returning(),
		db.delete(reviews).where(and(eq(reviews.memoId, id), isNull(reviews.completedAt))),
		db
			.update(reviewSchedules)
			.set({ version: sql`${reviewSchedules.version} + 1` })
			.where(eq(reviewSchedules.memoId, id))
	]);
	const archived = archivedRows[0];
	if (!archived) throw new NotFoundError('memo not found');
	return archived;
}
