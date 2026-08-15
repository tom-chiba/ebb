<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<div class="danger-zone">
	{@render children()}
</div>

<style>
	.danger-zone {
		padding-top: 16px;
		border-top: 1px solid var(--color-border-subtle);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
</style>
