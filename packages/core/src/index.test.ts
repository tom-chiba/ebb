import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedIntervalStrategy, nextReviewAt, SYSTEM_INTERVAL_PRESETS } from './index';

const HOUR_MS = 60 * 60 * 1000;

describe('SYSTEM_INTERVAL_PRESETS', () => {
	it('defines the three presets from the Issue with fixed slug ids', () => {
		expect(SYSTEM_INTERVAL_PRESETS.map((preset) => preset.id)).toEqual([
			'system-short',
			'system-standard',
			'system-long'
		]);
	});

	it('keeps the "standard" preset intervals identical to the value already seeded in production (0006)', () => {
		const standard = SYSTEM_INTERVAL_PRESETS.find((preset) => preset.id === 'system-standard');
		expect(standard?.intervals).toEqual([1, 24, 72, 168, 336, 720]);
	});

	it('短期集中・長期プリセットの間隔が Issue 本文の仕様どおり時間換算されている', () => {
		const intervalsOf = (id: string) =>
			SYSTEM_INTERVAL_PRESETS.find((preset) => preset.id === id)?.intervals;
		// 短期集中: [1h, 6h, 1d, 3d]
		expect(intervalsOf('system-short')).toEqual([1, 6, 24, 72]);
		// 長期: [1d, 1w, 1m, 3m]（30日=720h, 90日=2160h 換算）
		expect(intervalsOf('system-long')).toEqual([24, 168, 720, 2160]);
	});
});

describe('nextReviewAt', () => {
	it('1時間後が正しく計算される', () => {
		const baseTime = new Date('2026-01-01T00:00:00.000Z');
		const result = nextReviewAt(baseTime, [1, 24, 72], 0);
		expect(result).toEqual(new Date('2026-01-01T01:00:00.000Z'));
	});

	it('最終ステップの結果は正しく計算される', () => {
		const baseTime = new Date('2026-01-01T00:00:00.000Z');
		const intervals = [1, 24, 72];
		const result = nextReviewAt(baseTime, intervals, intervals.length - 1);
		expect(result).toEqual(new Date('2026-01-04T00:00:00.000Z'));
	});

	it('全ステップ完了後（範囲外の step）は undefined を返す（最終間隔を繰り返さない）', () => {
		const baseTime = new Date('2026-01-01T00:00:00.000Z');
		const intervals = [1, 24, 72];
		expect(nextReviewAt(baseTime, intervals, intervals.length)).toBeUndefined();
	});

	it('空配列の場合はどの step でも undefined を返す（異常系）', () => {
		const baseTime = new Date('2026-01-01T00:00:00.000Z');
		expect(nextReviewAt(baseTime, [], 0)).toBeUndefined();
	});

	it('負数・非整数の step は undefined を返す（異常系）', () => {
		const baseTime = new Date('2026-01-01T00:00:00.000Z');
		const intervals = [1, 24, 72];
		expect(nextReviewAt(baseTime, intervals, -1)).toBeUndefined();
		expect(nextReviewAt(baseTime, intervals, 1.5)).toBeUndefined();
	});

	it('月末（1/31）を跨いでも実際の経過時間どおりに計算される（カレンダー上の「1ヶ月後」にはならない）', () => {
		// intervals は時間単位で「月」という概念を持たない。720時間 = 30日は常に
		// baseTime + 720 * 3600000ms であり、カレンダー上の「次の月の同じ日」ではない。
		const baseTime = new Date('2026-01-31T00:00:00.000Z');
		const thirtyDaysInHours = 720;
		const result = nextReviewAt(baseTime, [thirtyDaysInHours], 0);
		expect(result?.getTime()).toBe(baseTime.getTime() + thirtyDaysInHours * HOUR_MS);
		expect(result).toEqual(new Date('2026-03-02T00:00:00.000Z'));
	});

	describe('夏時間の切り替えを跨ぐ場合', () => {
		// setHours 等ローカル時刻の構成要素で計算する実装に戻す将来のリグレッションを
		// 検知するため、DST を持つタイムゾーンに固定してテストする。
		const originalTz = process.env.TZ;

		beforeAll(() => {
			process.env.TZ = 'America/New_York';
		});

		afterAll(() => {
			if (originalTz === undefined) delete process.env.TZ;
			else process.env.TZ = originalTz;
		});

		it('米国の夏時間開始（2026-03-08）を跨いでも実際の経過時間どおりに計算される', () => {
			// 2026-03-08T06:00:00Z は America/New_York で 2026-03-08 01:00 EST（切り替え前）。
			const baseTime = new Date('2026-03-08T06:00:00.000Z');
			const result = nextReviewAt(baseTime, [24], 0);
			expect(result?.getTime()).toBe(baseTime.getTime() + 24 * HOUR_MS);
			expect(result).toEqual(new Date('2026-03-09T06:00:00.000Z'));
		});
	});
});

describe('fixedIntervalStrategy', () => {
	it('SchedulingStrategy として次の復習時刻を計算する', () => {
		const baseTime = new Date('2026-01-01T00:00:00.000Z');
		expect(fixedIntervalStrategy.nextReviewAt(baseTime, [1, 24], 0)).toEqual(
			new Date('2026-01-01T01:00:00.000Z')
		);
	});

	it('範囲外の step では undefined を返す', () => {
		const baseTime = new Date('2026-01-01T00:00:00.000Z');
		expect(fixedIntervalStrategy.nextReviewAt(baseTime, [1, 24], 2)).toBeUndefined();
	});
});
