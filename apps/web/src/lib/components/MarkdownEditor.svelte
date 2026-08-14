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
		font-size: 14.5px;
		line-height: 2;
		color: var(--color-text-secondary);
		padding: 0;
		box-sizing: border-box;
	}

	.toolbar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
		display: flex;
		gap: 1px;
		background: var(--color-border-strong);
		padding: 6px;
		border-top: 1px solid var(--color-border-strong);
	}

	.toolbar button {
		flex: 1;
		height: 38px;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--color-surface-input);
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 13px;
		cursor: pointer;
	}
</style>
