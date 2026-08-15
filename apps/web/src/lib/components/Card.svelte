<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ResolvedPathname } from '$app/types';

	let {
		href,
		children
	}: {
		href?: ResolvedPathname;
		children: Snippet;
	} = $props();
</script>

{#if href}
	<a {href} class="card card-link">
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

	.card-link:hover {
		border-color: var(--color-border-strong);
	}

	.card-link:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
</style>
