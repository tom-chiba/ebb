<script lang="ts">
	import type { ResolvedPathname } from '$app/types';

	let { href, label }: { href: ResolvedPathname; label: string } = $props();
</script>

<a {href} class="fab" aria-label={label}>＋</a>

<style>
	.fab {
		position: fixed;
		right: 1.25rem;
		bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 1rem);
		width: 56px;
		height: 56px;
		border-radius: 28px;
		background: var(--color-accent);
		color: var(--color-surface-card);
		font-size: 26px;
		line-height: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 6px 16px rgba(61, 107, 92, 0.34);
		text-decoration: none;
	}
</style>
