/// <reference lib="webworker" />

// Web Push の受信・PWA インストール可能性のための実装（#8, #9）。
// このファイルは SvelteKit 生成 tsconfig の exclude に入っているため、`../tsconfig.json`
// 経由の svelte-check では検査されない。専用の tsconfig.service-worker.json を
// `pnpm check` から別途叩いている（#19、docs/design-decisions.md 参照）。

// このファイルは import/export を持たないグローバルスクリプト（本番ビルドで classic
// 出力になるための意図的な制約。#9 参照）として扱われるため、`declare const self:
// ServiceWorkerGlobalScope` で直接上書きすると lib.webworker.d.ts の ambient `self`
// （WorkerGlobalScope 型）と同一スコープで衝突し `Cannot redeclare block-scoped
// variable 'self'` になる（tsconfig.service-worker.json 追加時に実測確認済み）。
// 別名の定数へ型アサーションすることで、self の再宣言を避けつつ
// ServiceWorkerGlobalScope 固有のメンバーを型安全に使う。
const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', () => {
	sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(sw.clients.claim());
});

sw.addEventListener('push', (event) => {
	event.waitUntil(
		(async () => {
			let data: { title?: string; body?: string; url?: string } | undefined;
			try {
				data = event.data?.json();
			} catch {
				data = undefined;
			}
			await sw.registration.showNotification(data?.title ?? 'Ebb', {
				body: data?.body,
				data: { url: data?.url }
			});
		})()
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(
		(async () => {
			const notificationData: unknown = event.notification.data;
			const targetUrl =
				typeof notificationData === 'object' &&
				notificationData !== null &&
				'url' in notificationData &&
				typeof notificationData.url === 'string'
					? notificationData.url
					: '/';
			const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const existing = clients.find((client) => 'focus' in client);
			if (existing) {
				if ('navigate' in existing) {
					await existing.navigate(targetUrl);
				}
				await existing.focus();
			} else {
				await sw.clients.openWindow(targetUrl);
			}
		})()
	);
});
