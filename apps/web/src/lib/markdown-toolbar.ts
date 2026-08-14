export interface TextSelection {
	value: string;
	start: number;
	end: number;
}

export type MarkdownToolbarAction = 'heading' | 'bullet' | 'quote' | 'bold' | 'code';

function lineStart(value: string, pos: number): number {
	// pos === 0 を素通しせず lastIndexOf(value, -1) を呼ぶと、String#lastIndexOf の
	// 仕様で負の fromIndex が 0 にクランプされ、value[0] が '\n' の場合に誤って
	// それを「直前の改行」として検出してしまう（先頭が空行の本文で2行目を誤検出する）。
	if (pos <= 0) return 0;
	const idx = value.lastIndexOf('\n', pos - 1);
	return idx === -1 ? 0 : idx + 1;
}

function lineEnd(value: string, ls: number): number {
	const idx = value.indexOf('\n', ls);
	return idx === -1 ? value.length : idx;
}

// 現在行の先頭に marker があれば取り除き（トグルオフ）、無ければ付ける。
// selectionStart/End は行頭より後ろにある分だけ、追加/削除した長さの分ずらす
// （行頭より前の選択位置は変えない。複数行選択でも「現在行」= selectionStart を含む行のみを対象にする）。
function toggleLinePrefix(
	{ value, start, end }: TextSelection,
	pattern: RegExp,
	marker: string
): TextSelection {
	const ls = lineStart(value, start);
	const le = lineEnd(value, ls);
	const line = value.slice(ls, le);
	const match = line.match(pattern);

	if (match) {
		const removed = match[0].length;
		const newValue = value.slice(0, ls) + value.slice(ls + removed);
		return {
			value: newValue,
			start: Math.max(ls, start - removed),
			end: Math.max(ls, end - removed)
		};
	}

	const newValue = value.slice(0, ls) + marker + value.slice(ls);
	return { value: newValue, start: start + marker.length, end: end + marker.length };
}

// 現在行の先頭に marker が無ければ付ける。既に付いている場合は何もしない
// （見出しと違い、箇条書き・引用はタップのたびに追加/削除をトグルする仕様ではない）。
function addLinePrefixIfAbsent(
	{ value, start, end }: TextSelection,
	pattern: RegExp,
	marker: string
): TextSelection {
	const ls = lineStart(value, start);
	const le = lineEnd(value, ls);
	const line = value.slice(ls, le);
	if (pattern.test(line)) {
		return { value, start, end };
	}
	const newValue = value.slice(0, ls) + marker + value.slice(ls);
	return { value: newValue, start: start + marker.length, end: end + marker.length };
}

// 選択範囲を marker で囲む。選択が無い（start === end）場合は marker を2つ分
// カーソル位置に挿入し、カーソルをその中央に置く。
function wrapSelection({ value, start, end }: TextSelection, marker: string): TextSelection {
	if (start === end) {
		const newValue = value.slice(0, start) + marker + marker + value.slice(end);
		const caret = start + marker.length;
		return { value: newValue, start: caret, end: caret };
	}
	const selected = value.slice(start, end);
	const newValue = value.slice(0, start) + marker + selected + marker + value.slice(end);
	return { value: newValue, start: start + marker.length, end: end + marker.length };
}

export function applyMarkdownToolbarAction(
	action: MarkdownToolbarAction,
	selection: TextSelection
): TextSelection {
	switch (action) {
		case 'heading':
			return toggleLinePrefix(selection, /^#+\s/, '# ');
		case 'bullet':
			return addLinePrefixIfAbsent(selection, /^-\s/, '- ');
		case 'quote':
			return addLinePrefixIfAbsent(selection, /^>\s/, '> ');
		case 'bold':
			return wrapSelection(selection, '**');
		case 'code':
			return wrapSelection(selection, '`');
	}
}
