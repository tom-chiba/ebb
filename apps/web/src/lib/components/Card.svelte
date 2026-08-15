<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ResolvedPathname } from '$app/types';

	let {
		href,
		children
	}: {
		href?: ResolvedPathname | string;
		children: Snippet;
	} = $props();
</script>

{#if href}
	<a {href} class="card">
		{@render children()}
	</a>
{:else}
	<div class="card">
		{@render children()}
	</div>
{/if}

<style>
	.card {
		display: block;
		background: var(--color-surface-card);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		padding: var(--space-card-pad);
		color: inherit;
		text-decoration: none;
	}
</style>
