<script lang="ts">
	import { tick } from 'svelte';
	import { applyMarkdownToolbarAction, type MarkdownToolbarAction } from '$lib/markdown-toolbar';

	let {
		value = $bindable(''),
		name,
		maxlength
	}: {
		value: string;
		name: string;
		maxlength: number;
	} = $props();

	let textareaEl: HTMLTextAreaElement | undefined = $state();

	const TOOLBAR_BUTTONS: { action: MarkdownToolbarAction; label: string }[] = [
		{ action: 'heading', label: '#' },
		{ action: 'bullet', label: '-' },
		{ action: 'bold', label: '**' },
		{ action: 'quote', label: '>' },
		{ action: 'code', label: '`' }
	];

	async function applyAction(action: MarkdownToolbarAction) {
		const el = textareaEl;
		if (!el) return;
		const result = applyMarkdownToolbarAction(action, {
			value,
			start: el.selectionStart,
			end: el.selectionEnd
		});
		value = result.value;
		await tick();
		el.focus();
		el.setSelectionRange(result.start, result.end);
	}
</script>

<textarea bind:this={textareaEl} bind:value {name} {maxlength} rows="10"></textarea>

<div class="counter">{value.length} / {maxlength}</div>

<div class="toolbar">
	{#each TOOLBAR_BUTTONS as button (button.action)}
		<button
			type="button"
			onmousedown={(e) => e.preventDefault()}
			onclick={() => applyAction(button.action)}
		>
			{button.label}
		</button>
	{/each}
</div>

<style>
	textarea {
		width: 100%;
		border: none;
		outline: none;
		background: transparent;
		resize: vertical;
		font-family: var(--font-sans);
		font-size: var(--text-body);
		line-height: 1.9;
		color: var(--color-text-secondary);
		padding: 0;
		box-sizing: border-box;
	}

	.counter {
		font-size: var(--text-caption);
		color: var(--color-text-faint);
		text-align: right;
	}

	.toolbar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
		display: flex;
		gap: 8px;
		background: var(--color-surface-raised);
		padding: 10px var(--space-page);
	}

	.toolbar button {
		flex: 1;
		height: 38px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-input);
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: var(--text-small);
		cursor: pointer;
	}

	.toolbar button:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
</style>
