// オンボーディング（#24）向けのクライアント専用判定。SSR では navigator/window が
// 無いため、必ずブラウザ側（onMount 等）からのみ呼び出すこと。
export interface PlatformInfo {
	// iOS/iPadOS の Safari（ホームスクリーンからの起動を含む）とみなせるか。
	isIOSLike: boolean;
	isAndroid: boolean;
	// display-mode: standalone での起動、または iOS のホーム画面追加済み Web App。
	isStandalone: boolean;
	// このブラウザ・コンテキストで Web Push 自体が使える見込みがあるか
	// （iOS Safari 特有の「ホーム画面未追加だと使えない」制約は含まない。
	// その判定は isIOSLike && !isStandalone 側で行う）。
	pushCapable: boolean;
}

export function detectPlatform(): PlatformInfo {
	const ua = navigator.userAgent;
	const isIOSLike =
		/iP(hone|ad|od)/.test(ua) ||
		// iPadOS 13+ は既定で Safari の UA が "Macintosh" になる（iPad と判別できない）ため、
		// タッチ対応の Mac を iPad とみなす。navigator.platform は非推奨だが他に手段が無い。
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
	const isAndroid = /Android/.test(ua);
	const isStandalone =
		window.matchMedia('(display-mode: standalone)').matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true;
	const pushCapable =
		'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
	return { isIOSLike, isAndroid, isStandalone, pushCapable };
}
