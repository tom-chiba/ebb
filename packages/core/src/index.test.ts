import { describe, expect, it } from 'vitest';
import * as core from './index';

describe('@ebb/core', () => {
	it('is importable', () => {
		expect(core).toBeDefined();
	});
});
