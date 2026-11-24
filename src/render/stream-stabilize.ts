/**
 * Streaming Markdown stabilization for the live trailing block.
 *
 * While tokens arrive a few characters at a time, incomplete inline syntax
 * (`**bold`, `` `code ``, `[label](file:///long/path...`, `~~del`) causes
 * jarring visual flicker: raw markers or long URLs expand across multiple lines
 * and then abruptly collapse the moment the closing character arrives.
 *
 * This module stabilizes ONLY the active streaming tail at render time (never
 * mutating the underlying message or lexer cache):
 *  - hides bare trailing openers (`*`, `**`, `***`, `` ` ``, `~~`) until the
 *    first content character arrives,
 *  - hides in-progress link URLs (`[label](partial-url` -> `[label](#)`) so
 *    links render immediately at their final display width without URL flash,
 *  - auto-closes open codespans, `**strong**`, `*em*`, and `~~del~~` (also
 *    absorbing partial closing markers like `**bold*` -> `**bold**`).
 */

const UNCLOSED_LINK_TAIL_RE = /\[([^\[\]\n]+)\]\((?:[^()\n]*)$/;
const BARE_STREAMING_PREFIX_RE = /^ {0,3}(?:#{1,6}|``|~~)$/;

/** True when a trailing streaming paragraph is only an incomplete heading/fence prefix. */
export function isBareStreamingBlockPrefix(text: string): boolean {
	return BARE_STREAMING_PREFIX_RE.test(text);
}

/**
 * Stabilize incomplete inline Markdown constructs at the tail of a streaming
 * text span so rendering stays visually smooth with zero raw-marker jumps.
 */
export function stabilizeStreamingInline(input: string): string {
	if (!input) return input;

	// Single-pass scan tracking open backtick codespan and emphasis delimiters.
	type Delim = "**" | "*" | "~~";
	let out = input;
	let openBackticks = 0;
	let openBacktickPos = -1;
	const stack: Array<{ marker: Delim; pos: number }> = [];

	const popOrPush = (marker: Delim, pos: number, nextChar: string, prevChar: string): void => {
		// Try closing a matching open delimiter on the stack first.
		for (let j = stack.length - 1; j >= 0; j--) {
			if (stack[j]!.marker === marker) {
				// Closing delimiter cannot follow whitespace.
				if (prevChar && !/\s/.test(prevChar)) {
					stack.length = j;
					return;
				}
			}
		}
		// Otherwise push as an opener if not followed by whitespace (or at end of string).
		if (!nextChar || !/\s/.test(nextChar)) {
			// Avoid treating mid-word `*` or `**` (e.g. `foo*bar`, `x**2`) as emphasis openers.
			if (prevChar && /[A-Za-z0-9]/.test(prevChar) && nextChar && /[A-Za-z0-9]/.test(nextChar)) {
				return;
			}
			stack.push({ marker, pos });
		}
	};

	let i = 0;
	while (i < out.length) {
		const ch = out[i]!;

		// Inside an inline codespan: only a matching backtick run closes it.
		if (openBackticks > 0) {
			if (ch === "`") {
				let run = 0;
				while (i + run < out.length && out[i + run] === "`") run++;
				if (run === openBackticks) {
					openBackticks = 0;
					openBacktickPos = -1;
				}
				i += run;
				continue;
			}
			i++;
			continue;
		}

		if (ch === "\\") {
			i += 2;
			continue;
		}

		if (ch === "`") {
			let run = 0;
			while (i + run < out.length && out[i + run] === "`") run++;
			openBackticks = run;
			openBacktickPos = i;
			i += run;
			continue;
		}

		// Complete inline link `[label](url)` — skip over the URL so `*`/`~` inside URLs don't confuse emphasis tracking.
		if (ch === "]") {
			if (out[i + 1] === "(") {
				const close = out.indexOf(")", i + 2);
				const nl = out.indexOf("\n", i + 2);
				if (close !== -1 && (nl === -1 || close < nl)) {
					i = close + 1;
					continue;
				}
				// Unclosed link URL at the tail: stop scanning here and stabilize below.
				break;
			}
		}

		const prev = i > 0 ? out[i - 1]! : "";

		if (ch === "~" && out[i + 1] === "~") {
			const next = out[i + 2] ?? "";
			popOrPush("~~", i, next, prev);
			i += 2;
			continue;
		}

		if (ch === "*") {
			let run = 0;
			while (i + run < out.length && out[i + run] === "*") run++;
			const next = out[i + run] ?? "";
			if (run === 3) {
				// `***` opens/closes both `**` and `*`.
				popOrPush("**", i, next, prev);
				popOrPush("*", i + 2, next, prev);
			} else if (run === 2) {
				popOrPush("**", i, next, prev);
			} else if (run === 1) {
				// If a single trailing `*` sits at the very end while `**` is open, treat it as partial closing `*` of `**`.
				if (i + 1 === out.length && stack.some((d) => d.marker === "**") && prev && !/\s/.test(prev)) {
					break;
				}
				popOrPush("*", i, next, prev);
			}
			i += run;
			continue;
		}

		i++;
	}

	// 1. Handle an unclosed inline codespan at the tail.
	if (openBackticks > 0) {
		const content = out.slice(openBacktickPos + openBackticks);
		if (content.length === 0) {
			// Bare opening backticks at very end -> hide until code text arrives.
			out = out.slice(0, openBacktickPos);
		} else {
			// Absorb partial closing backticks (e.g. ``foo` -> ``foo``) and close cleanly.
			let trailingTicks = 0;
			while (
				trailingTicks < openBackticks &&
				trailingTicks < content.length &&
				content[content.length - 1 - trailingTicks] === "`"
			) {
				trailingTicks++;
			}
			out += "`".repeat(openBackticks - trailingTicks);
		}
	}

	// 2. Stabilize an unclosed `[label](partial-url` at the tail (outside codespan).
	if (openBackticks === 0) {
		const linkMatch = UNCLOSED_LINK_TAIL_RE.exec(out);
		if (linkMatch) {
			out = `${out.slice(0, linkMatch.index)}[${linkMatch[1]}](#)`;
		}
	}

	// 3. Close (or hide empty) unclosed emphasis delimiters from innermost to outermost.
	for (let j = stack.length - 1; j >= 0; j--) {
		const { marker, pos } = stack[j]!;
		const after = out.slice(pos + marker.length);
		if (after.length === 0) {
			// Bare trailing opener (e.g. `**` or `*` or `~~` at end) -> hide until next char arrives.
			out = out.slice(0, pos);
			continue;
		}
		// Partial first char of a 2-char closing marker (e.g. `**bold*` or `~~del~`).
		if (marker.length === 2 && out.endsWith(marker[0]!) && !out.endsWith(marker)) {
			const beforePartial = out[out.length - 2] ?? "";
			if (beforePartial && !/\s/.test(beforePartial)) {
				out += marker[0]!;
				continue;
			}
		}
		// Only auto-close if the span ends on a non-whitespace character; otherwise trim trailing space before closing.
		const trimmedEnd = out.replace(/[ \t]+$/, "");
		if (trimmedEnd.length > pos + marker.length) {
			out = `${trimmedEnd}${marker}${out.slice(trimmedEnd.length)}`;
		}
	}

	return out;
}
