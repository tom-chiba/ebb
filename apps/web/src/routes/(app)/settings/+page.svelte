<script lang="ts">
	import AccountSettings from '$lib/components/AccountSettings.svelte';
	import Card from '$lib/components/Card.svelte';
	import DefaultPresetSettings from '$lib/components/DefaultPresetSettings.svelte';
	import PageHeading from '$lib/components/PageHeading.svelte';
	import PresetList from '$lib/components/PresetList.svelte';
	import PushNotificationSettings from '$lib/components/PushNotificationSettings.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// setDefault アクションの結果だけを、判別可能 union を保ったまま
	// DefaultPresetSettings が扱いやすい形に絞り込む（narrowing はここに集約し、
	// 子コンポーネントには確定済みの値だけを渡す）。
	let defaultPresetResult = $derived.by(
		(): { success: true } | { success: false; message: string } | null => {
			if (!form || form.action !== 'setDefault') return null;
			// SvelteKit の ActionData は OptionalUnion により全アクション共通のキー集合を
			// 持つ形に変換されるため、`'message' in form` は他アクションの分岐でも常に
			// 真になる（値が never/undefined になるだけ）。`!== undefined` で値そのものを
			// 見て絞り込む。
			if (form.success) return { success: true };
			if (form.message !== undefined) return { success: false, message: form.message };
			return null;
		}
	);
</script>

<PageHeading title="設定" />

<div class="cards">
	<Card>
		<PushNotificationSettings vapidPublicKey={data.vapidPublicKey} />
	</Card>

	<Card>
		<DefaultPresetSettings
			presets={data.presets}
			defaultPresetId={data.defaultPresetId}
			result={defaultPresetResult}
		/>
	</Card>

	<Card>
		<PresetList presets={data.presets} />
	</Card>

	<Card>
		<AccountSettings userName={data.user.name} />
	</Card>
</div>

<style>
	.cards {
		display: flex;
		flex-direction: column;
		gap: var(--space-stack);
	}
</style>
