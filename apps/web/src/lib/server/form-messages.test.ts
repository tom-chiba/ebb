import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, intervalPresets, user, type Db } from '@ebb/db';
import { ValidationError } from './errors';
import { translateMemoValidationMessage } from './form-messages';
import { CONTENT_MAX_LENGTH, createMemo, TITLE_MAX_LENGTH } from './memos';

let db: Db;
let userId: string;
let presetId: string;

beforeEach(async () => {
	db = createDb(env.DB);
	userId = crypto.randomUUID();
	await db.insert(user).values({ id: userId, name: 'Test User', email: `${userId}@example.com` });
	const [preset] = await db
		.insert(intervalPresets)
		.values({ userId: null, name: 'test preset', intervals: [1] })
		.returning();
	if (!preset) throw new Error('fixture setup failed');
	presetId = preset.id;
});

// memos.ts の assertTitle/assertContent/getAccessiblePreset が実際に投げる
// ValidationError.message を経由して translateMemoValidationMessage() に通す。
// リテラル文字列を直接渡すテストだと、memos.ts 側の文言を変更してもテストの
// 入力自体が固定されたままになり回帰を検知できない（実測で確認済み: 過去の
// テストは assertTitle のメッセージを書き換えても green のままだった）。
async function captureTranslatedValidationMessage(input: {
	title: string;
	content: string;
	intervalPresetId: string;
}): Promise<string> {
	try {
		await createMemo(db, userId, input);
	} catch (err) {
		if (err instanceof ValidationError) return translateMemoValidationMessage(err.message);
		throw err;
	}
	throw new Error('expected createMemo to throw a ValidationError');
}

describe('translateMemoValidationMessage', () => {
	it('translates the real empty-title ValidationError from createMemo', async () => {
		const out = await captureTranslatedValidationMessage({
			title: '',
			content: 'body',
			intervalPresetId: presetId
		});
		expect(out).toBe('タイトルを入力してください');
	});

	it('translates the real title-too-long ValidationError from createMemo', async () => {
		const out = await captureTranslatedValidationMessage({
			title: 'a'.repeat(TITLE_MAX_LENGTH + 1),
			content: 'body',
			intervalPresetId: presetId
		});
		expect(out).toBe(`タイトルは${TITLE_MAX_LENGTH}文字以内で入力してください`);
	});

	it('translates the real content-too-long ValidationError from createMemo', async () => {
		const out = await captureTranslatedValidationMessage({
			title: 'title',
			content: 'a'.repeat(CONTENT_MAX_LENGTH + 1),
			intervalPresetId: presetId
		});
		expect(out).toBe(`本文は${CONTENT_MAX_LENGTH}文字以内で入力してください`);
	});

	it('falls back to a generic message for the real inaccessible-preset ValidationError, without leaking the field name', async () => {
		const out = await captureTranslatedValidationMessage({
			title: 'title',
			content: 'body',
			intervalPresetId: 'no-such-preset'
		});
		expect(out).toBe('入力内容を確認してください');
		expect(out).not.toContain('intervalPresetId');
	});
});
