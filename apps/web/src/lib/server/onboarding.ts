import { eq, userSettings, type Db } from '@ebb/db';

// user_settings 行自体が無いユーザー（=このユーザーの設定を一度も保存していない、
// かつ移行時のバックフィル対象でもなかった＝新規登録ユーザー）は未対応とみなす。
export async function hasSeenOnboarding(db: Db, userId: string): Promise<boolean> {
	const rows = await db
		.select({ onboardingSeenAt: userSettings.onboardingSeenAt })
		.from(userSettings)
		.where(eq(userSettings.userId, userId))
		.limit(1)
		.all();
	return rows[0]?.onboardingSeenAt != null;
}

// setDefaultPresetForUser（$lib/server/interval-presets.ts）と同じ upsert パターン。
// 「完了」「スキップ」いずれの操作からも同じ関数を呼び、以後の自動表示を止める。
export async function markOnboardingSeen(db: Db, userId: string): Promise<void> {
	const now = new Date();
	await db
		.insert(userSettings)
		.values({ userId, onboardingSeenAt: now })
		.onConflictDoUpdate({
			target: userSettings.userId,
			set: { onboardingSeenAt: now }
		});
}
