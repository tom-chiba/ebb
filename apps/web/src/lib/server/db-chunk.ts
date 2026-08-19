// D1 は1クエリあたりの bind パラメータ数に上限があり（ローカル実行で実測したところ
// ちょうど100件で、101件から `too many SQL variables` になる。Cloudflare の
// ドキュメントが示す上限と一致）、`inArray` にメモ id 等をまとめて渡す箇所は必ず
// この単位でチャンク分割してからクエリを発行する（#18 の正確性レビューで指摘。
// 実際に251件規模のテストで生の D1 エラーを再現して確認した）。
// これは「1クエリの bind パラメータ総数」の上限であり「1つの inArray に渡せる件数」
// ではない点に注意（#18 の設計レビューで指摘）。既定（bindsPerItem 省略）の呼び出しは
// inArray 1つだけで他に bind を持たないためチャンクサイズ100件で一致するが、
// Issue #85 で追加した review_schedules 欠落治癒 INSERT のように1件につき複数列へ
// bind する呼び出しは bindsPerItem を渡すこと（省略すると51件以上で
// `too many SQL variables` になる。正確性レビューで指摘・実機で再現）。
// bindsPerItem: 2 は「1チャンクあたり50件 × 2 bind = ちょうど100」とヘッドルームが
// 無いため、対象テーブルに列が増える場合はこの値も見直すこと。同様に、reviews への1回の INSERT 文
// （$lib/server/reviews.ts の commitReviewRecalculation・updateCustomPresetIntervals が
// 積む INSERT）が使う bind 数は
// 「新 intervals の要素数（@ebb/core の MAX_INTERVAL_COUNT が上限）× 1行あたりの
// カラム数」であり、この上限（queryInChunks のチャンク分割）とは別の bind 数上限
// なので、MAX_INTERVAL_COUNT を将来引き上げる場合はこちらとの関係も見直す必要がある。
const D1_MAX_BIND_PARAMS = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

// `inArray` にまとめて渡す id 一覧を D1_MAX_BIND_PARAMS 単位に分割してクエリを並列
// 発行し、結果を1つに結合する。空配列なら（chunk が空配列を返すため）そのままクエリ
// 0件で空配列を返す。interval-presets.ts・reviews.ts の複数のクエリが、この同じ
// ヘルパー経由でチャンク分割する（#18 の設計レビューで指摘、ロジックの重複と
// 分岐の複雑化を避けるため共通化）。
//
// bindsPerItem: 1件（id 1つ）につきそのクエリが消費する bind パラメータ数。
// 既定の1は「inArray に id を渡すだけ」の呼び出しに対応する。1件で複数列に
// bind する INSERT（例: reviewSchedules の欠落治癒が memo_id・version の2列に
// bind する）では、これを渡さないとチャンクサイズが id 数基準のままになり、
// 実際の bind 総数が D1_MAX_BIND_PARAMS を超えて `too many SQL variables` に
// なる（正確性レビューで指摘、51件以上の欠落で実機再現）。
export async function queryInChunks<T, R>(
	ids: readonly T[],
	query: (chunkIds: T[]) => Promise<R[]>,
	bindsPerItem = 1
): Promise<R[]> {
	const chunkSize = Math.max(1, Math.floor(D1_MAX_BIND_PARAMS / bindsPerItem));
	const results = await Promise.all(chunk(ids, chunkSize).map(query));
	return results.flat();
}
