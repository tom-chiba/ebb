// D1 は1クエリあたりの bind パラメータ数に上限があり（ローカル実行で実測したところ
// ちょうど100件で、101件から `too many SQL variables` になる。Cloudflare の
// ドキュメントが示す上限と一致）、`inArray` にメモ id 等をまとめて渡す箇所は必ず
// この単位でチャンク分割してからクエリを発行する（#18 の正確性レビューで指摘。
// 実際に251件規模のテストで生の D1 エラーを再現して確認した）。
// これは「1クエリの bind パラメータ総数」の上限であり「1つの inArray に渡せる件数」
// ではない点に注意（#18 の設計レビューで指摘）。このヘルパーを使う各クエリは
// inArray 1つだけで他に bind を持たないため一致しているが、条件を追加する際は
// チャンクサイズも見直すこと。同様に、reviews への1回の INSERT 文
// （$lib/server/reviews.ts の buildReviewRecalculationStatements）が使う bind 数は
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
export async function queryInChunks<T, R>(
	ids: readonly T[],
	query: (chunkIds: T[]) => Promise<R[]>
): Promise<R[]> {
	const results = await Promise.all(chunk(ids, D1_MAX_BIND_PARAMS).map(query));
	return results.flat();
}
