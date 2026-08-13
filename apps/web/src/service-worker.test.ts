import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceWorkerTest = vi.hoisted(() => {
	type EventHandler = (event: {
		data?: { json(): unknown };
		notification?: { data: unknown; close(): void };
		waitUntil(promise: Promise<unknown>): void;
	}) => void;

	const handlers = new Map<string, EventHandler>();
	const showNotification = vi.fn();
	const matchAll = vi.fn();
	const openWindow = vi.fn();
	const fakeSelf = {
		location: { origin: 'https://ebb.example' },
		skipWaiting: vi.fn(),
		registration: { showNotification },
		clients: { claim: vi.fn(), matchAll, openWindow },
		addEventListener(type: string, handler: EventHandler) {
			handlers.set(type, handler);
		}
	};
	vi.stubGlobal('self', fakeSelf);

	return { handlers, showNotification, matchAll, openWindow };
});

import './service-worker';

beforeEach(() => {
	vi.clearAllMocks();
});

async function dispatch(type: string, event: Record<string, unknown>): Promise<void> {
	const handler = serviceWorkerTest.handlers.get(type);
	if (!handler) throw new Error(`${type} handler was not registered`);
	let pending: Promise<unknown> | undefined;
	handler({
		...event,
		waitUntil(promise: Promise<unknown>) {
			pending = promise;
		}
	});
	if (!pending) throw new Error(`${type} handler did not call waitUntil`);
	await pending;
}

describe('service worker notifications', () => {
	it('push payload の復習 URL を通知データへ保持する', async () => {
		serviceWorkerTest.showNotification.mockResolvedValue(undefined);

		await dispatch('push', {
			data: {
				json: () => ({ title: '復習', body: '本文', url: '/reviews/review-1' })
			}
		});

		expect(serviceWorkerTest.showNotification).toHaveBeenCalledWith('復習', {
			body: '本文',
			data: { url: '/reviews/review-1' }
		});
	});

	it('通知クリック時は既存タブを復習 URL へ遷移してフォーカスし、新しいタブを開かない', async () => {
		const existingClient = { navigate: vi.fn(), focus: vi.fn() };
		serviceWorkerTest.matchAll.mockResolvedValue([existingClient]);
		const notification = { data: { url: '/reviews/review-2' }, close: vi.fn() };

		await dispatch('notificationclick', { notification });

		expect(notification.close).toHaveBeenCalledOnce();
		expect(existingClient.navigate).toHaveBeenCalledWith('/reviews/review-2');
		expect(existingClient.focus).toHaveBeenCalledOnce();
		expect(serviceWorkerTest.openWindow).not.toHaveBeenCalled();
	});

	it('既存タブがなければ復習 URL を新しいタブで開く', async () => {
		serviceWorkerTest.matchAll.mockResolvedValue([]);
		serviceWorkerTest.openWindow.mockResolvedValue(undefined);

		await dispatch('notificationclick', {
			notification: { data: { url: '/reviews/review-3' }, close: vi.fn() }
		});

		expect(serviceWorkerTest.openWindow).toHaveBeenCalledWith('/reviews/review-3');
	});
});
