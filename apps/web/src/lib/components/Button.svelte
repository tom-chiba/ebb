<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ResolvedPathname } from '$app/types';

	let {
		variant,
		tone = 'accent',
		href,
		type = 'button',
		name,
		value,
		disabled = false,
		onclick,
		children
	}: {
		variant: 'primary' | 'compact' | 'quiet';
		tone?: 'accent' | 'neutral';
		href?: ResolvedPathname | string;
		type?: 'button' | 'submit';
		name?: string;
		value?: string;
		disabled?: boolean;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	} = $props();
</script>

{#if href}
	<a {href} class="btn {variant}" class:neutral={tone === 'neutral'} aria-disabled={disabled}>
		{@render children()}
	</a>
{:else}
	<button
		{type}
		{name}
		{value}
		class="btn {variant}"
		class:neutral={tone === 'neutral'}
		{disabled}
		{onclick}
	>
		{@render children()}
	</button>
{/if}

<style>
	.btn {
		font-family: var(--font-sans);
		border: none;
		cursor: pointer;
		text-decoration: none;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		text-align: center;
	}

	.btn:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.primary {
		width: 100%;
		height: var(--control-h-primary);
		border-radius: var(--radius-pill);
		background: var(--color-accent);
		color: var(--color-surface-input);
		font-size: 15px;
		font-weight: 700;
	}

	.primary:hover {
		background: var(--color-accent-hover);
	}

	.primary:disabled,
	.primary[aria-disabled='true'] {
		background: var(--color-border-strong);
		cursor: not-allowed;
	}

	.compact {
		height: var(--control-h-compact);
		padding: 0 16px;
		border-radius: var(--radius-pill);
		font-size: var(--text-small);
		font-weight: 700;
		background: var(--color-accent);
		color: var(--color-surface-input);
	}

	.compact:hover {
		background: var(--color-accent-hover);
	}

	.compact.neutral {
		background: var(--color-surface-card);
		border: 1px solid var(--color-border-strong);
		color: var(--color-text-secondary);
		font-weight: 500;
	}

	.compact.neutral:hover {
		background: var(--color-surface-input);
	}

	.compact:disabled,
	.compact[aria-disabled='true'] {
		background: var(--color-border-strong);
		color: var(--color-text-faint);
		cursor: not-allowed;
	}

	.quiet {
		background: none;
		padding: 0;
		font-size: var(--text-small);
		font-weight: 500;
		color: var(--color-error);
	}

	.quiet:disabled,
	.quiet[aria-disabled='true'] {
		color: var(--color-text-faint);
		cursor: not-allowed;
	}
</style>
