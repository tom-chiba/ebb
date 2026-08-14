<script lang="ts">
	import { MAX_INTERVAL_HOURS, MIN_INTERVAL_HOURS } from '@ebb/core';
	import { formatShortDateTime } from '$lib/format-date-time';
	import { formatIntervalStep } from '$lib/format-interval-step';

	let {
		steps = $bindable(),
		maxIntervalCount,
		baseTime
	}: {
		steps: number[];
		maxIntervalCount: number;
		baseTime: Date;
	} = $props();

	// intervals は h（時間）/d（日、24時間）のみを単位として扱う（@ebb/core の
	// parseIntervals と同じ制約）。1つの hours 値の単位表記は「24で割り切れるか」から
	// 機械的に決める（formatIntervals と同じ規則）。ユーザーが「12h」で追加したか
	// 「0.5d」相当を意図したかは区別できないが、そもそも後者は入力できないため
	// 曖昧さは生じない。
	function naturalUnit(hours: number): 'h' | 'd' {
		return hours % 24 === 0 ? 'd' : 'h';
	}

	function toHours(amount: number, unit: 'h' | 'd'): number {
		return unit === 'd' ? amount * 24 : amount;
	}

	// 直前のステップより厳密に大きい値だけを選べるようにする（parseIntervals が
	// 要求する厳密昇順を、そもそも入力できない形で保証する）。単位が時間/日を
	// またぐ場合も内部は時間換算で比較するため、d 単位の最小値は
	// 「直前の時間数を24で割った商+1」で求める（例: 直前120h → 最小6d=144h。
	// 5d=120h は直前と同値になり不可）。
	function minAmountFor(unit: 'h' | 'd'): number {
		const lastHours = steps.at(-1);
		if (lastHours === undefined) {
			return unit === 'd' ? 1 : MIN_INTERVAL_HOURS;
		}
		return unit === 'd' ? Math.floor(lastHours / 24) + 1 : lastHours + 1;
	}

	function maxAmountFor(unit: 'h' | 'd'): number {
		return unit === 'd' ? MAX_INTERVAL_HOURS / 24 : MAX_INTERVAL_HOURS;
	}

	let pendingUnit = $state<'h' | 'd'>(
		steps.at(-1) !== undefined ? naturalUnit(steps.at(-1)!) : 'h'
	);
	let pendingAmount = $state(minAmountFor(pendingUnit));

	function resetPending() {
		pendingUnit = steps.at(-1) !== undefined ? naturalUnit(steps.at(-1)!) : 'h';
		pendingAmount = minAmountFor(pendingUnit);
	}

	function selectUnit(unit: 'h' | 'd') {
		pendingUnit = unit;
		pendingAmount = minAmountFor(unit);
	}

	function decrementPending() {
		pendingAmount = Math.max(minAmountFor(pendingUnit), pendingAmount - 1);
	}

	function incrementPending() {
		pendingAmount = Math.min(maxAmountFor(pendingUnit), pendingAmount + 1);
	}

	// 直前のステップがちょうど MAX_INTERVAL_HOURS のとき、どちらの単位でも
	// 「直前より大きい」かつ「上限以下」を同時に満たす値が存在しなくなる
	// （h: 最小値が上限を超える、d: 最小の日数が上限日数を超える）。この場合に
	// pendingAmount の範囲チェックをせず追加を許すと、必ず保存に失敗する
	// 値をステップ一覧に加えられてしまう。
	function pendingValid(): boolean {
		return pendingAmount >= minAmountFor(pendingUnit) && pendingAmount <= maxAmountFor(pendingUnit);
	}

	function addStep() {
		if (steps.length >= maxIntervalCount || !pendingValid()) return;
		steps = [...steps, toHours(pendingAmount, pendingUnit)];
		resetPending();
	}

	function removeStep(index: number) {
		steps = steps.filter((_, i) => i !== index);
		resetPending();
	}

	let atLimit = $derived(steps.length >= maxIntervalCount);
	let noValidNextStep = $derived(
		minAmountFor('h') > maxAmountFor('h') && minAmountFor('d') > maxAmountFor('d')
	);
	let guardText = $derived(
		steps.length > 0 ? `${formatIntervalStep(steps.at(-1)!)}より後の値のみ選べます` : null
	);
</script>

<div class="step-editor">
	<div class="step-editor-header">
		<span class="step-editor-label">間隔のステップ</span>
		<span class="step-editor-count">{steps.length} / {maxIntervalCount}</span>
	</div>

	{#if steps.length > 0}
		<ul class="step-list">
			{#each steps as hours, index (index)}
				<li class="step-row">
					<div class="step-main">
						<span class="step-index">{index + 1}</span>
						<span class="step-label">{formatIntervalStep(hours)}</span>
					</div>
					<div class="step-side">
						<span class="step-preview"
							>{formatShortDateTime(new Date(baseTime.getTime() + hours * 3_600_000))}</span
						>
						<button
							type="button"
							class="step-remove"
							aria-label={`${formatIntervalStep(hours)}を削除`}
							onclick={() => removeStep(index)}>×</button
						>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	{#if atLimit}
		<p class="hint">ステップ数の上限（{maxIntervalCount}）に達しました。</p>
	{:else if noValidNextStep}
		<p class="hint">これ以上、後の値を選べません。</p>
	{:else}
		<div class="add-step">
			<div class="add-step-label">次のステップを追加</div>
			<div class="add-step-row">
				<div class="stepper">
					<button
						type="button"
						class="stepper-button"
						aria-label="減らす"
						disabled={pendingAmount <= minAmountFor(pendingUnit)}
						onclick={decrementPending}>−</button
					>
					<span class="stepper-value">{pendingAmount}</span>
					<button
						type="button"
						class="stepper-button stepper-button-add"
						aria-label="増やす"
						disabled={pendingAmount >= maxAmountFor(pendingUnit)}
						onclick={incrementPending}>＋</button
					>
				</div>
				<div class="unit-toggle" role="group" aria-label="単位">
					<button
						type="button"
						class="unit-button"
						class:selected={pendingUnit === 'h'}
						aria-pressed={pendingUnit === 'h'}
						onclick={() => selectUnit('h')}>時間</button
					>
					<button
						type="button"
						class="unit-button"
						class:selected={pendingUnit === 'd'}
						aria-pressed={pendingUnit === 'd'}
						onclick={() => selectUnit('d')}>日</button
					>
				</div>
			</div>
			<div class="add-step-footer">
				{#if guardText}
					<span class="hint">{guardText}</span>
				{:else}
					<span></span>
				{/if}
				<button type="button" class="add-button" disabled={!pendingValid()} onclick={addStep}
					>追加</button
				>
			</div>
		</div>
	{/if}
</div>

<style>
	.step-editor {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.step-editor-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	.step-editor-label {
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		color: var(--color-text-caption);
	}

	.step-editor-count {
		font-size: 0.72rem;
		color: var(--color-text-faint);
	}

	.step-list {
		list-style: none;
		margin: 0;
		padding: 0 0.875rem;
		background: var(--color-surface-input);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
	}

	.step-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.6875rem 0;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.step-row:last-child {
		border-bottom: none;
	}

	.step-main {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.step-index {
		width: 0.875rem;
		font-size: 0.6875rem;
		color: var(--color-text-faint);
	}

	.step-label {
		font-family: var(--font-heading);
		font-size: 1.0625rem;
		color: var(--color-text);
	}

	.step-side {
		display: flex;
		align-items: center;
		gap: 0.875rem;
	}

	.step-preview {
		font-size: 0.72rem;
		color: var(--color-text-caption);
	}

	.step-remove {
		border: none;
		background: none;
		padding: 0;
		font-size: 0.875rem;
		line-height: 1;
		color: var(--color-text-faint);
		cursor: pointer;
	}

	.add-step {
		background: var(--color-bg);
		border: 1px dashed var(--color-border-strong);
		border-radius: var(--radius-card);
		padding: 0.875rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.add-step-label {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.add-step-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
	}

	.stepper {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: var(--color-surface-input);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-card);
		height: 2.875rem;
		padding: 0 0.375rem;
	}

	.stepper-button {
		width: 2.125rem;
		height: 2.125rem;
		border-radius: 50%;
		border: none;
		background: var(--color-border-subtle);
		color: var(--color-text-muted);
		font-size: 1rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}

	.stepper-button-add {
		background: var(--color-accent-bg);
		color: var(--color-accent-hover);
	}

	.stepper-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.stepper-value {
		font-family: var(--font-heading);
		font-size: 1.1875rem;
		color: var(--color-text);
	}

	.unit-toggle {
		display: flex;
		gap: 0.25rem;
		background: var(--color-border-subtle);
		border-radius: var(--radius-card);
		padding: 0.25rem;
	}

	.unit-button {
		border: 1px solid transparent;
		background: none;
		font-family: var(--font-sans);
		font-size: 0.78rem;
		color: var(--color-text-muted);
		padding: 0.5rem 0.75rem;
		border-radius: 9px;
		cursor: pointer;
		white-space: nowrap;
	}

	.unit-button.selected {
		font-weight: 700;
		color: var(--color-text);
		background: var(--color-surface-input);
		border-color: var(--color-border);
	}

	.add-step-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.hint {
		margin: 0;
		font-size: 0.72rem;
		color: var(--color-text-caption);
	}

	.add-button {
		flex: none;
		border: 1px solid var(--color-accent-border);
		background: var(--color-accent-bg);
		color: var(--color-accent-hover);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 700;
		border-radius: var(--radius-card);
		padding: 0.5rem 0.875rem;
		cursor: pointer;
	}

	.add-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
