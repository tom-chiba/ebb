<script lang="ts">
	let {
		presets,
		selectedId = $bindable()
	}: {
		presets: { id: string; name: string }[];
		selectedId: string;
	} = $props();
</script>

<div class="presets">
	<div class="presets-label">間隔</div>
	<div class="chips">
		{#each presets as preset (preset.id)}
			<input
				type="radio"
				name="intervalPresetId"
				value={preset.id}
				id={`preset-${preset.id}`}
				bind:group={selectedId}
				class="chip-input"
			/>
			<label for={`preset-${preset.id}`} class="chip">{preset.name}</label>
		{/each}
	</div>
</div>

<style>
	.presets {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 14px 0;
		border-top: 1px solid var(--color-border-subtle);
	}

	.presets-label {
		font-size: var(--text-caption);
		color: var(--color-text-caption);
		flex-shrink: 0;
	}

	.chips {
		display: flex;
		gap: 0.375rem;
		flex-wrap: wrap;
	}

	.chip-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
	}

	.chip {
		display: inline-block;
		font-size: var(--text-caption);
		color: var(--color-text-secondary);
		background: var(--color-surface-input);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		padding: 5px 12px;
		cursor: pointer;
		white-space: nowrap;
	}

	.chip-input:checked + .chip {
		color: var(--color-surface-input);
		background: var(--color-accent);
		border-color: var(--color-accent);
		font-weight: 500;
	}

	.chip-input:focus-visible + .chip {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}
</style>
