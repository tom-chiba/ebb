/// <reference lib="webworker" />

// Web Push の受信・PWA インストール可能性のための実装（#8, #9）。
// このファイルは SvelteKit 生成 tsconfig の exclude に入っているため、現時点では `pnpm check` の対象外
// （専用 tsconfig の追加は #19 / #20 で行う方針。docs/design-decisions.md 参照）。

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
	event.waitUntil(
		(async () => {
			let data: { title?: string; body?: string } | undefined;
			try {
				data = event.data?.json();
			} catch {
				data = undefined;
			}
			await self.registration.showNotification(data?.title ?? 'Ebb', {
				body: data?.body
			});
		})()
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(
		(async () => {
			const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const existing = clients.find((client) => 'focus' in client);
			if (existing) {
				await existing.focus();
			} else {
				await self.clients.openWindow('/');
			}
		})()
	);
});
