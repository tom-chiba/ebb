<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ResolvedPathname } from '$app/types';

	let {
		cancelHref,
		label,
		children
	}: {
		cancelHref: ResolvedPathname | string;
		label: string;
		children: Snippet;
	} = $props();
</script>

<div class="header">
	<a href={cancelHref}>キャンセル</a>
	<div class="header-label">{label}</div>
	{@render children()}
</div>

<style>
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 56px;
		box-sizing: border-box;
		padding: 0 var(--space-page);
		margin: 0 calc(var(--space-page) * -1);
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.header a {
		font-size: var(--text-small);
		color: var(--color-text-muted);
	}

	.header-label {
		font-size: var(--text-caption);
		color: var(--color-text-caption);
	}
</style>
