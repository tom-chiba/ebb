<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from './Button.svelte';

	let {
		presets
	}: {
		presets: {
			id: string;
			name: string;
			intervalsText: string;
			isSystem: boolean;
			inUseCount: number;
		}[];
	} = $props();
</script>

<div class="section">
	<div class="section-header">
		<div class="section-label">プリセット</div>
		<Button variant="compact" tone="neutral" href={resolve('/settings/presets/new')}>＋ 追加</Button
		>
	</div>
	<ul class="preset-list">
		{#each presets as preset (preset.id)}
			<li>
				{#if preset.isSystem}
					<div class="preset-row">
						<div class="option-text">
							<span class="option-name">{preset.name}</span>
							<span class="option-meta">{preset.intervalsText} ・ 編集できません</span>
						</div>
						<span class="badge">標準搭載</span>
					</div>
				{:else}
					<a
						href={resolve('/(app)/settings/presets/[id]/edit', { id: preset.id })}
						class="preset-row preset-row-link"
					>
						<div class="option-text">
							<span class="option-name">{preset.name}</span>
							<span class="option-meta"
								>{preset.intervalsText} ・ {preset.inUseCount}件のメモが参照中（アーカイブ済み含む）</span
							>
						</div>
						<span class="option-chevron" aria-hidden="true">›</span>
					</a>
				{/if}
			</li>
		{/each}
	</ul>
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

	.section-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
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

	.preset-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.preset-list li {
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.preset-list li:last-child {
		border-bottom: none;
	}

	.preset-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		min-height: var(--control-h-field);
		padding: 0.75rem 0;
	}

	.preset-row-link {
		color: inherit;
		text-decoration: none;
		cursor: pointer;
	}

	.preset-row-link:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.option-chevron {
		flex: none;
		font-size: var(--text-small);
		color: var(--color-text-faint);
	}

	.badge {
		flex: none;
		font-size: var(--text-caption);
		color: var(--color-text-muted);
		background: var(--color-surface-raised);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		padding: 4px 10px;
	}
</style>
