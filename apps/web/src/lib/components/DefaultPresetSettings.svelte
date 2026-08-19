<script lang="ts">
	import Button from './Button.svelte';
	import Flash from './Flash.svelte';

	let {
		presets,
		defaultPresetId,
		result
	}: {
		presets: { id: string; name: string; intervalsText: string }[];
		defaultPresetId: string;
		result: { success: true } | { success: false; message: string } | null;
	} = $props();
</script>

<div class="section">
	<div class="section-label">新規メモの既定プリセット</div>
	<form method="POST" action="?/setDefault" class="option-list">
		{#each presets as preset (preset.id)}
			<label class="option-row">
				<input
					type="radio"
					name="presetId"
					value={preset.id}
					class="option-radio"
					checked={preset.id === defaultPresetId}
				/>
				<div class="option-text">
					<span class="option-name">{preset.name}</span>
					<span class="option-meta">{preset.intervalsText}</span>
				</div>
				<span class="option-dot" aria-hidden="true"></span>
			</label>
		{/each}
		<!-- 選択のたびに自動送信するとキーボードでの矢印キー操作のたびにページ全体が
			     遷移してしまう（use:enhanceを使っていないため）。選択と保存を分け、
			     JS無効環境でも同じボタンで完結するようにする。 -->
		<div class="save-default-row">
			<Button variant="compact" type="submit">保存</Button>
		</div>
	</form>
	{#if result}
		{#if result.success}
			<Flash>既定プリセットを更新しました。</Flash>
		{:else}
			<p class="error">{result.message}</p>
		{/if}
	{/if}
</div>

<style>
	.section {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.section-label {
		font-size: var(--text-caption);
		letter-spacing: 0.06em;
		color: var(--color-text-caption);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.option-list {
		gap: 0;
	}

	.save-default-row {
		margin-top: 0.75rem;
	}

	.option-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: var(--control-h-field);
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--color-border-subtle);
		cursor: pointer;
	}

	.option-list .option-row:last-child {
		border-bottom: none;
	}

	.option-radio {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
	}

	.option-text {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		flex: 1;
	}

	.option-name {
		font-size: var(--text-body);
		color: var(--color-text);
	}

	.option-meta {
		font-size: var(--text-caption);
		color: var(--color-text-caption);
	}

	.option-dot {
		flex: none;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		border: 1.5px solid var(--color-border-strong);
	}

	.option-radio:checked ~ .option-dot {
		border-color: var(--color-accent);
		background: var(--color-accent);
		box-shadow: inset 0 0 0 2.5px var(--color-surface-card);
	}

	.option-radio:focus-visible ~ .option-dot {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.error {
		color: var(--color-error);
		margin: 0;
	}
</style>
