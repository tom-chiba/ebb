import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { requireAuthedDb, requireJsonContentType } from './api';

function statusOf(fn: () => unknown): number {
	try {
		fn();
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
	throw new Error('expected fn to throw');
}

describe('requireJsonContentType', () => {
	it('accepts application/json', () => {
		const request = new Request('http://localhost/', {
			headers: { 'content-type': 'application/json' }
		});
		expect(() => requireJsonContentType(request)).not.toThrow();
	});

	it('accepts application/json with a charset parameter', () => {
		const request = new Request('http://localhost/', {
			headers: { 'content-type': 'application/json; charset=utf-8' }
		});
		expect(() => requireJsonContentType(request)).not.toThrow();
	});

	it('is case-insensitive about the media type', () => {
		const request = new Request('http://localhost/', {
			headers: { 'content-type': 'Application/JSON' }
		});
		expect(() => requireJsonContentType(request)).not.toThrow();
	});

	it('rejects a non-JSON content-type with 400', () => {
		const request = new Request('http://localhost/', {
			headers: { 'content-type': 'text/plain' }
		});
		expect(statusOf(() => requireJsonContentType(request))).toBe(400);
	});

	it('rejects a missing content-type with 400', () => {
		const request = new Request('http://localhost/');
		expect(statusOf(() => requireJsonContentType(request))).toBe(400);
	});
});

describe('requireAuthedDb', () => {
	it('throws 401 when there is no authenticated user', () => {
		expect(
			statusOf(() =>
				requireAuthedDb({ locals: { user: null, session: null }, platform: undefined })
			)
		).toBe(401);
	});

	it('throws 500 when platform.env.DB is not available', () => {
		const status = statusOf(() =>
			requireAuthedDb({
				locals: { user: { id: 'u1' }, session: { id: 's1' } } as never,
				platform: { env: {} } as never
			})
		);
		expect(status).toBe(500);
	});
});
