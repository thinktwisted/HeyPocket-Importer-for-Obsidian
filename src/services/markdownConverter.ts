/*
 * Renders normalized HeyPocket recordings into Obsidian Markdown notes:
 * YAML frontmatter (id, title, date, language, tags), an AI Summary callout,
 * Key Takeaways, Action Items as task checkboxes, and a timestamped
 * transcript.
 */

import {
	HpRecording,
	formatDuration,
	formatTimestamp,
	sanitizeTag,
} from "../models/heypocket";

export interface ConvertOptions {
	/** Extra tags appended after the recording's own tags (auto-tags). */
	extraTags: string[];
	/** When false, the Transcript section is omitted. */
	includeTranscript: boolean;
}

/** Strip control characters that would corrupt YAML or Markdown. */
function cleanText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** YAML double-quoted scalar (always safe; valid YAML 1.1/1.2). */
export function yamlString(value: string): string {
	const escaped = cleanText(value)
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
	return `"${escaped}"`;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function yamlScalar(value: string): string {
	// Emit bare ISO timestamps so Obsidian shows them as Date properties.
	return ISO_TIMESTAMP.test(value) ? value : yamlString(value);
}

/** Neutralize vault embeds / remote images arriving with untrusted file content. */
function scrubEmbeds(value: string): string {
	let out = value;
	for (let pass = 0; pass < 8; pass++) {
		const next = out
			.replace(/!\[\[([^\]]*)\]\]/g, (_m, inner: string) => inner.split("|")[0].split("#")[0])
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
		if (next === out) break;
		out = next;
	}
	return out;
}

/** Clean first (control chars could hide token seams), then scrub untrusted text. */
function sanitizeText(value: string, trusted: boolean): string {
	const cleaned = cleanText(value);
	return trusted ? cleaned : scrubEmbeds(cleaned);
}

/* ---- HeyPocket rich blocks: <pocket:chart>, <pocket:timeline>, <pocket:flow> ---- *
 * The AI summary embeds custom tags Obsidian cannot render; convert them to
 * native Mermaid diagrams (pie / xychart / timeline / flowchart) with Markdown
 * tables and bullets as graceful fallbacks for anything unrecognized.        */

const POCKET_BLOCK = /<pocket:([a-z0-9][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/pocket:\1>/gi;
const POCKET_TAG_REMNANTS = /<\/?pocket:[^>]*>/gi;

function pocketAttr(attrs: string, name: string): string {
	const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
	return m ? m[1] : "";
}

/** Neutralize colons: mermaid timeline uses them as field separators. */
function tlText(value: string): string {
	return value.replace(/:/g, "\u2236");
}

function pocketTable(rows: string[][], header: string[]): string {
	const width = Math.max(header.length, ...rows.map((r) => r.length));
	const cell = (v: string | undefined) => (v ?? "").replace(/\|/g, "\\|");
	const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
	for (const r of rows) {
		const cols: string[] = [];
		for (let i = 0; i < width; i++) cols.push(cell(r[i]));
		lines.push(`| ${cols.join(" | ")} |`);
	}
	return lines.join("\n");
}

/** Sanitize text destined for a quoted mermaid label. */
function mdLabel(value: string): string {
	return value.replace(/"/g, "'").replace(/</g, "\uFF1C");
}

/**
 * Decision/flow syntax (`id::label` declarations, `edge label => target`
 * links, free text as node notes) → mermaid flowchart. Returns "" when the
 * lines don't actually parse as a flow.
 */
function flowDiagram(lines: string[], caption: string): string {
	interface FNode {
		id: string;
		label: string;
		notes: string[];
	}
	const nodes = new Map<string, FNode>();
	const order: string[] = [];
	const edges: { from: string; label: string; to: string }[] = [];
	const stray: string[] = [];
	let current: FNode | null = null;
	for (const line of lines) {
		const decl = /^([A-Za-z_][\w-]*)\s*::\s*(.*)$/.exec(line);
		if (decl !== null) {
			const existing = nodes.get(decl[1]);
			if (existing === undefined) {
				const node: FNode = { id: decl[1], label: decl[2], notes: [] };
				nodes.set(node.id, node);
				order.push(node.id);
				current = node;
			} else {
				if (existing.label === "") existing.label = decl[2];
				else existing.notes.push(decl[2]);
				current = existing;
			}
			continue;
		}
		const edge = /^(.*?)\s*=>\s*([A-Za-z_][\w-]*)\s*$/.exec(line);
		if (edge !== null) {
			if (current === null) return "";
			edges.push({ from: current.id, label: edge[1].trim(), to: edge[2] });
			continue;
		}
		if (current !== null) current.notes.push(line);
		else stray.push(line);
	}
	if (nodes.size === 0 || edges.length === 0) return "";
	for (const e of edges) {
		if (!nodes.has(e.to)) {
			const node: FNode = { id: e.to, label: e.to, notes: [] };
			nodes.set(node.id, node);
			order.push(node.id);
		}
	}
	const head = caption + (stray.length > 0 ? `**${mdLabel(stray.map((s) => s.replace(/^#+\s*/, "").replace(/\*\*/g, "")).join(" "))}**\n\n` : "");
	const body = ["flowchart TD"];
	for (const id of order) {
		const n = nodes.get(id) as FNode;
		const label = [n.label, ...n.notes].filter((p) => p !== "").map(mdLabel).join("<br/>");
		body.push(`  n_${id}["${label}"]`);
	}
	for (const e of edges) {
		body.push(`  n_${e.from} -->|"${mdLabel(e.label).replace(/\|/g, "/")}"| n_${e.to}`);
	}
	return `${head}\`\`\`mermaid\n${body.join("\n")}\n\`\`\``;
}

function pocketBlock(type: string, attrs: string, inner: string): string {
	const title = pocketAttr(attrs, "title");
	const caption = title !== "" ? `**${title.replace(/\|/g, "\\|")}**\n\n` : "";
	const rawLines = inner
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "");
	const rows = rawLines.map((l) => l.split(/\s*\|\s*/).map((c) => c.trim()));
	if (rows.length === 0) return "";
	const kind = type.toLowerCase();
	if (kind === "flow" || kind === "flowchart" || kind === "workflow" || kind === "decision" || kind === "tree") {
		const diagram = flowDiagram(rawLines, caption);
		if (diagram !== "") return diagram;
		return `${caption}${rows.map((r) => `- ${r.join(" — ")}`).join("\n")}`;
	}
	if (kind === "chart") {
		const chartType = pocketAttr(attrs, "type").toLowerCase();
		const numeric = rows.every((r) => r.length >= 2 && r[1] !== "" && isFinite(Number(r[1])));
		const colors = rows.map((r) => r[2] ?? "");
		if (chartType === "pie" && numeric) {
			const colorOk = colors.every((c) => /^#[0-9a-f]{6}$/i.test(c));
			const init = colorOk ? `%%{init: {"themeVariables": {${colors.map((c, i) => `"pie${i + 1}": "${c}"`).join(", ")}}}}%%\n` : "";
			const series = rows.map((r) => `  "${mdLabel(r[0])}" : ${Number(r[1])}`).join("\n");
			return `${caption}\`\`\`mermaid\n${init}pie showData\n${series}\n\`\`\``;
		}
		if (["bar", "column", "line", "area"].includes(chartType) && numeric && rows.every((r) => r[0] !== "")) {
			const seriesWord = chartType === "line" || chartType === "area" ? "line" : "bar";
			const axis = rows.map((r) => `"${mdLabel(r[0])}"`).join(", ");
			const values = rows.map((r) => String(Number(r[1]))).join(", ");
			return `${caption}\`\`\`mermaid\nxychart-beta\n  x-axis [${axis}]\n  ${seriesWord} [${values}]\n\`\`\``;
		}
		return `${caption}${pocketTable(rows, ["Item", "Value", "Color"])}`;
	}
	if (kind === "timeline" && rows.every((r) => r.length >= 2 && r[0] !== "")) {
		const body = rows.map((r) => `  ${tlText(r[0])} : ${r.slice(1).map(tlText).join(" — ")}`).join("\n");
		return `${caption}\`\`\`mermaid\ntimeline\n${body}\n\`\`\``;
	}
	return `${caption}${rows.map((r) => `- ${r.join(" — ")}`).join("\n")}`;
}

function renderPocketEmbeds(value: string): string {
	return value
		.replace(POCKET_BLOCK, (_m, type: string, attrs: string, inner: string) => {
			try {
				return pocketBlock(type, attrs, inner);
			} catch {
				return "";
			}
		})
		.replace(POCKET_TAG_REMNANTS, "");
}

function inlineText(value: string, trusted = true): string {
	return renderPocketEmbeds(sanitizeText(value, trusted)).replace(/\s*\r?\n\s*/g, " ").trim();
}

function buildFrontmatter(rec: HpRecording, opts: ConvertOptions): string {
	const tagSet = new Set<string>();
	const tags: string[] = [];
	for (const raw of [...rec.tags, ...opts.extraTags]) {
		const tag = sanitizeTag(raw);
		if (tag && !tagSet.has(tag.toLowerCase())) {
			tagSet.add(tag.toLowerCase());
			tags.push(tag);
		}
	}

	const lines: string[] = ["---"];
	lines.push(`id: ${yamlString(rec.id)}`);
	lines.push(`title: ${yamlString(rec.title)}`);
	lines.push(`date: ${rec.date ? yamlScalar(rec.date) : yamlString("")}`); // only date may be bare
	lines.push(`language: ${yamlString(rec.language)}`);
	if (tags.length === 0) {
		lines.push("tags: []");
	} else {
		lines.push("tags:");
		for (const tag of tags) lines.push(`  - ${yamlString(tag)}`);
	}
	lines.push("---");
	return lines.join("\n");
}

/** Wrap multi-paragraph text into an Obsidian blockquote callout body. */
function calloutLines(kind: string, title: string, body: string, trusted = true): string[] {
	const lines: string[] = [`> [!${kind}] ${inlineText(title, trusted)}`];
	const paragraphs = renderPocketEmbeds(sanitizeText(body, trusted))
		.replace(/\r\n?/g, "\n")
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p !== "");
	if (paragraphs.length === 0) {
		const single = inlineText(body, trusted);
		if (single) lines.push(`> ${single}`);
	} else {
		for (const [i, paragraph] of paragraphs.entries()) {
			if (i > 0) lines.push(">");
			for (const line of paragraph.split("\n")) lines.push(`> ${line}`);
		}
	}
	return lines;
}

export function convertRecordingToMarkdown(rec: HpRecording, opts: ConvertOptions): string {
	const out: string[] = [];
	const trusted = rec.source === "api"; // file imports carry untrusted text
	out.push(buildFrontmatter(rec, opts));
	out.push("");
	out.push(`# ${inlineText(rec.title, trusted)}`);
	out.push("");

	const metaParts: string[] = [];
	if (rec.date) metaParts.push(`**Recorded:** ${rec.date.slice(0, 10)}`);
	const duration = formatDuration(rec.durationSec);
	if (duration) metaParts.push(`**Duration:** ${duration}`);
	if (rec.language) metaParts.push(`**Language:** ${inlineText(rec.language, trusted)}`);
	if (rec.recordedBy) metaParts.push(`**Recorded by:** ${inlineText(rec.recordedBy, trusted)}`);
	if (metaParts.length > 0) {
		out.push(`> [!info]- Recording info`);
		out.push(`> ${metaParts.join(" · ")}`);
		out.push("");
	}

	if (rec.summary) {
		out.push(...calloutLines("summary", "AI Summary", rec.summary, trusted));
		out.push("");
	}

	if (rec.keyTakeaways.length > 0) {
		out.push("## Key Takeaways");
		out.push("");
		for (const takeaway of rec.keyTakeaways) out.push(`- ${inlineText(takeaway, trusted)}`);
		out.push("");
	}

	if (rec.actionItems.length > 0) {
		out.push("## Action Items");
		out.push("");
		for (const item of rec.actionItems) {
			const extras: string[] = [];
			if (item.due) extras.push(`due ${inlineText(item.due, trusted)}`);
			if (item.assignee) extras.push(`assignee: ${inlineText(item.assignee, trusted)}`);
			const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
			out.push(`- [${item.done ? "x" : " "}] ${inlineText(item.text, trusted)}${suffix}`);
		}
		out.push("");
	}

	if (opts.includeTranscript && rec.segments.length > 0) {
		out.push("## Transcript");
		out.push("");
		const hasTiming = rec.segments.some((s) => s.start > 0 || s.end !== undefined);
		for (const seg of rec.segments) {
			const speaker = seg.speaker ? `**${inlineText(seg.speaker, trusted)}:** ` : "";
			const stamp = hasTiming ? `\`${formatTimestamp(seg.start)}\` ` : "";
			out.push(`- ${stamp}${speaker}${inlineText(seg.text, trusted)}`);
		}
		out.push("");
	}

	out.push(`> [!quote]- Imported from HeyPocket${rec.id ? ` (id: ${inlineText(rec.id, trusted)})` : ""}`);
	out.push("");
	return out.join("\n");
}
