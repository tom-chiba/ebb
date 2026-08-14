import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	diffIntervals,
	fixedIntervalStrategy,
	formatIntervals,
	MAX_INTERVAL_COUNT,
	MAX_INTERVAL_HOURS,
	nextReviewAt,
	parseIntervals,
	SYSTEM_INTERVAL_PRESETS
} from './index';

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

describe('parseIntervals', () => {
	it('issue本文の例（1h, 12h, 2d, 10d）を時間単位に変換する', () => {
		expect(parseIntervals('1h, 12h, 2d, 10d')).toEqual([1, 12, 48, 240]);
	});

	it('空白の有無や末尾の空トークンを許容する', () => {
		expect(parseIntervals(' 1h ,6h ,1d ')).toEqual([1, 6, 24]);
	});

	it('空文字列は拒否する', () => {
		expect(() => parseIntervals('')).toThrow();
		expect(() => parseIntervals('   ')).toThrow();
	});

	it('最小単位（1時間）未満は拒否する（0h・0d・負数）', () => {
		expect(() => parseIntervals('0h')).toThrow();
		expect(() => parseIntervals('0d')).toThrow(); // 日単位でも同じ境界が効く
		expect(() => parseIntervals('-1h')).toThrow();
	});

	it('降順・同値は拒否する（厳密昇順のみ許容）', () => {
		expect(() => parseIntervals('2h, 1h')).toThrow();
		expect(() => parseIntervals('1h, 1h')).toThrow();
		expect(() => parseIntervals('1d, 24h')).toThrow(); // 値としては同じ24h
	});

	it('未知の単位・不正なトークンは拒否する', () => {
		expect(() => parseIntervals('1w')).toThrow();
		expect(() => parseIntervals('1.5h')).toThrow();
		expect(() => parseIntervals('1.5d')).toThrow(); // 日単位でも非整数は同じ経路で拒否される
		expect(() => parseIntervals('abc')).toThrow();
	});

	it(`1間隔あたりの上限（${MAX_INTERVAL_HOURS}時間）を超えると拒否する（Date のオーバーフロー防止）`, () => {
		expect(() => parseIntervals(`${MAX_INTERVAL_HOURS + 1}h`)).toThrow();
		expect(parseIntervals(`${MAX_INTERVAL_HOURS}h`)).toEqual([MAX_INTERVAL_HOURS]);
	});

	it(`要素数が上限（${MAX_INTERVAL_COUNT}）を超えると拒否する`, () => {
		const tooMany = Array.from({ length: MAX_INTERVAL_COUNT + 1 }, (_, i) => `${i + 1}h`).join(
			', '
		);
		expect(() => parseIntervals(tooMany)).toThrow();
	});

	it(`要素数が上限（${MAX_INTERVAL_COUNT}）ちょうどなら許容する`, () => {
		const exactly = Array.from({ length: MAX_INTERVAL_COUNT }, (_, i) => `${i + 1}h`).join(', ');
		expect(parseIntervals(exactly)).toHaveLength(MAX_INTERVAL_COUNT);
	});
});

describe('formatIntervals', () => {
	it('24時間で割り切れる値は d 表記、それ以外は h 表記にする', () => {
		expect(formatIntervals([1, 12, 48, 240])).toBe('1h, 12h, 2d, 10d');
	});

	it('parseIntervals との往復（parse(format(x)) === x）が成立する', () => {
		const examples = [[1, 24, 72, 168, 336, 720], [1, 6, 24, 72], [1, 12, 48, 240], [5]];
		for (const intervals of examples) {
			expect(parseIntervals(formatIntervals(intervals))).toEqual(intervals);
		}
	});
});

describe('diffIntervals', () => {
	it('値が同じインデックスは unchanged にする', () => {
		expect(diffIntervals([1, 24, 72], [1, 24, 72])).toEqual([
			{ oldHours: 1, newHours: 1, status: 'unchanged' },
			{ oldHours: 24, newHours: 24, status: 'unchanged' },
			{ oldHours: 72, newHours: 72, status: 'unchanged' }
		]);
	});

	it('同じインデックスで値が異なれば changed にする', () => {
		expect(diffIntervals([1, 120], [1, 168])).toEqual([
			{ oldHours: 1, newHours: 1, status: 'unchanged' },
			{ oldHours: 120, newHours: 168, status: 'changed' }
		]);
	});

	it('新しい方が長い分は added にする', () => {
		expect(diffIntervals([1], [1, 24, 336])).toEqual([
			{ oldHours: 1, newHours: 1, status: 'unchanged' },
			{ oldHours: undefined, newHours: 24, status: 'added' },
			{ oldHours: undefined, newHours: 336, status: 'added' }
		]);
	});

	it('新しい方が短い分は removed にする', () => {
		expect(diffIntervals([1, 24, 336], [1])).toEqual([
			{ oldHours: 1, newHours: 1, status: 'unchanged' },
			{ oldHours: 24, newHours: undefined, status: 'removed' },
			{ oldHours: 336, newHours: undefined, status: 'removed' }
		]);
	});

	it('両方空配列なら空配列を返す', () => {
		expect(diffIntervals([], [])).toEqual([]);
	});

	it('#63: 途中のステップを削除しても、以降の共通ステップまで changed 扱いにならない', () => {
		// [1, 24, 72] から 24 だけを削除した場合、72 は値として変わっていないため
		// unchanged のまま保たれるべき（インデックスだけで比較すると 24→72 の
		// changed に誤認識してしまう）。
		expect(diffIntervals([1, 24, 72], [1, 72])).toEqual([
			{ oldHours: 1, newHours: 1, status: 'unchanged' },
			{ oldHours: 24, newHours: undefined, status: 'removed' },
			{ oldHours: 72, newHours: 72, status: 'unchanged' }
		]);
	});

	it('#63: 途中にステップを挿入しても、前後の共通ステップまで changed 扱いにならない', () => {
		expect(diffIntervals([1, 72], [1, 24, 72])).toEqual([
			{ oldHours: 1, newHours: 1, status: 'unchanged' },
			{ oldHours: undefined, newHours: 24, status: 'added' },
			{ oldHours: 72, newHours: 72, status: 'unchanged' }
		]);
	});

	it('#63: 前後に共通ステップがある区間内の値変更は changed にする', () => {
		expect(diffIntervals([1, 24, 72], [1, 50, 72])).toEqual([
			{ oldHours: 1, newHours: 1, status: 'unchanged' },
			{ oldHours: 24, newHours: 50, status: 'changed' },
			{ oldHours: 72, newHours: 72, status: 'unchanged' }
		]);
	});

	it('#63: 1つの区間に複数の削除・追加がある場合、先頭から順にペアリングして changed にし、余りだけ removed/added にする', () => {
		// 区間内: old側 [24, 48]、new側 [30] → 24→30 は changed、余った 48 は removed。
		expect(diffIntervals([1, 24, 48, 72], [1, 30, 72])).toEqual([
			{ oldHours: 1, newHours: 1, status: 'unchanged' },
			{ oldHours: 24, newHours: 30, status: 'changed' },
			{ oldHours: 48, newHours: undefined, status: 'removed' },
			{ oldHours: 72, newHours: 72, status: 'unchanged' }
		]);
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
