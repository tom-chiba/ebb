<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();

	let barEl: HTMLDivElement | undefined = $state();

	$effect(() => {
		const el = barEl;
		if (!el) return;
		const update = () => {
			document.documentElement.style.setProperty('--bottom-bar-height', `${el.offsetHeight}px`);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => {
			observer.disconnect();
			document.documentElement.style.removeProperty('--bottom-bar-height');
		};
	});
</script>

<div class="bottom-bar" bind:this={barEl}>
	{@render children()}
</div>

<style>
	.bottom-bar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
		box-sizing: border-box;
		padding: 14px var(--space-page);
		background: var(--color-surface-raised);
		border-top: 1px solid var(--color-border);
	}
</style>
