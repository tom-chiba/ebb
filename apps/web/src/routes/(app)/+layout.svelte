<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	function isActivePath(pathname: string, base: string): boolean {
		return pathname === base || pathname.startsWith(`${base}/`);
	}

	let isHome = $derived(page.url.pathname === resolve('/'));
	let isReviews = $derived(isActivePath(page.url.pathname, resolve('/reviews')));
	let isMemos = $derived(isActivePath(page.url.pathname, resolve('/memos')));
	let isSettings = $derived(isActivePath(page.url.pathname, resolve('/settings')));
</script>

<main>
	{@render children()}
</main>

<nav class="bottom-nav">
	<a href={resolve('/')} class:active={isHome} aria-current={isHome ? 'page' : undefined}>
		ホーム
	</a>
	<a
		href={resolve('/reviews')}
		class:active={isReviews}
		aria-current={isReviews ? 'page' : undefined}
	>
		復習
	</a>
	<a href={resolve('/memos')} class:active={isMemos} aria-current={isMemos ? 'page' : undefined}>
		メモ
	</a>
	<a
		href={resolve('/settings')}
		class:active={isSettings}
		aria-current={isSettings ? 'page' : undefined}
	>
		設定
	</a>
</nav>

<style>
	main {
		padding: 0 var(--space-page)
			calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 4.5rem);
	}

	.bottom-nav {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		padding-bottom: env(safe-area-inset-bottom);
		background: var(--color-surface-raised);
		border-top: 1px solid var(--color-border);
	}

	.bottom-nav a {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: var(--bottom-nav-height);
		text-align: center;
		font-size: var(--text-caption);
		color: var(--color-text-caption);
		text-decoration: none;
	}

	.bottom-nav a.active {
		color: var(--color-accent);
		font-weight: 700;
	}
</style>
