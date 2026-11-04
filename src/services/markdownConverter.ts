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

function inlineText(value: string, trusted = true): string {
	return sanitizeText(value, trusted).replace(/\s*\r?\n\s*/g, " ").trim();
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
	const paragraphs = sanitizeText(body, trusted)
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
