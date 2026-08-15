<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<p class="flash">
	{@render children()}
</p>

<style>
	.flash {
		margin: 0;
		background: var(--color-accent-bg);
		border: 1px solid var(--color-accent-border);
		border-radius: var(--radius-card);
		padding: 12px 16px;
		color: var(--color-accent-hover);
		font-size: var(--text-small);
		line-height: 1.8;
	}
</style>
