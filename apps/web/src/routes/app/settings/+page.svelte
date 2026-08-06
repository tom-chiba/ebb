<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1>設定</h1>

<section>
	<h2>新規メモの既定プリセット</h2>
	<form method="POST" action="?/setDefault">
		<label>
			既定プリセット
			<select name="presetId">
				{#each data.presets as preset (preset.id)}
					<option value={preset.id} selected={preset.id === data.defaultPresetId}>
						{preset.name}（{preset.intervalsText}）
					</option>
				{/each}
			</select>
		</label>
		<button type="submit">保存</button>
	</form>
	{#if form && form.action === 'setDefault'}
		{#if 'success' in form && form.success}
			<p class="flash">既定プリセットを更新しました。</p>
		{:else if 'message' in form}
			<p class="error">{form.message}</p>
		{/if}
	{/if}
</section>

<section>
	<h2>プリセット一覧</h2>
	<ul>
		{#each data.presets as preset (preset.id)}
			<li>
				<h3>
					{preset.name}{#if preset.isSystem}（システム標準）{/if}
				</h3>

				{#if preset.isSystem}
					<p>{preset.intervalsText}</p>
				{:else}
					{@const updateForm =
						form && form.action === 'updatePreset' && form.presetId === preset.id ? form : null}
					{@const previewing =
						updateForm !== null &&
						'previewCount' in updateForm &&
						!('success' in updateForm && updateForm.success)}
					<form method="POST" action="?/updatePreset">
						<input type="hidden" name="presetId" value={preset.id} />
						<label>
							間隔（例: 1h, 12h, 2d, 10d。最大{data.maxIntervalCount}件）
							<input
								type="text"
								name="intervals"
								value={updateForm && 'intervals' in updateForm
									? updateForm.intervals
									: preset.intervalsText}
							/>
						</label>

						{#if updateForm && 'success' in updateForm && updateForm.success}
							<p class="flash">{updateForm.updatedReviewsCount}件の予定を更新しました。</p>
						{:else if previewing && updateForm && 'previewCount' in updateForm}
							<p class="warning">
								{updateForm.previewCount}件の予定が更新されます。よろしいですか？
							</p>
							<input type="hidden" name="confirmed" value="true" />
						{:else if updateForm && 'message' in updateForm}
							<p class="error">{updateForm.message}</p>
						{/if}

						{#if previewing}
							<button type="submit">確定して更新する</button>
						{:else}
							<button type="submit">更新する</button>
						{/if}
					</form>

					<form method="POST" action="?/deletePreset">
						<input type="hidden" name="presetId" value={preset.id} />
						<button type="submit" disabled={preset.inUse}>削除</button>
					</form>
					{#if preset.inUse}
						<p>使用中のメモがあるため削除できません。</p>
					{/if}
					{#if form && form.action === 'deletePreset' && form.presetId === preset.id && 'message' in form}
						<p class="error">{form.message}</p>
					{/if}
				{/if}
			</li>
		{/each}
	</ul>
	{#if form && form.action === 'deletePreset' && 'success' in form && form.success}
		<p class="flash">プリセットを削除しました。</p>
	{/if}
</section>

<section>
	<h2>新しいプリセットを作る</h2>
	<form method="POST" action="?/createPreset">
		<label>
			名前
			<input
				type="text"
				name="name"
				value={form && form.action === 'createPreset' && 'name' in form ? form.name : ''}
				maxlength={data.presetNameMaxLength}
				required
			/>
		</label>
		<label>
			間隔（例: 1h, 12h, 2d, 10d。最大{data.maxIntervalCount}件）
			<input
				type="text"
				name="intervals"
				value={form && form.action === 'createPreset' && 'intervals' in form ? form.intervals : ''}
				required
			/>
		</label>
		<button type="submit">作成</button>
	</form>
	{#if form && form.action === 'createPreset'}
		{#if 'success' in form && form.success}
			<p class="flash">プリセットを作成しました。</p>
		{:else if 'message' in form}
			<p class="error">{form.message}</p>
		{/if}
	{/if}
</section>

<style>
	section {
		margin-bottom: 2rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 480px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	ul {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	li {
		border: 1px solid #ccc;
		border-radius: 8px;
		padding: 0.75rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.flash {
		background: #eef6ec;
		border: 1px solid #b8d8ae;
		border-radius: 8px;
		padding: 0.75rem 1rem;
	}

	.warning {
		background: #fdf3e5;
		border: 1px solid #e8c98a;
		border-radius: 8px;
		padding: 0.75rem 1rem;
	}

	.error {
		color: #b4562f;
	}
</style>
