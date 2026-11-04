/*
 * HeyPocket Importer — canonical type guards, data models, normalization,
 * sanitization, and formatting helpers.
 *
 * This module has NO runtime dependency on the `obsidian` package so that it
 * can be reused by services and exercised in plain Node during smoke tests.
 */

/* ------------------------------------------------------------------ *
 * Canonical type guard for this package. Import from here — do not
 * redefine ad-hoc object guards elsewhere.
 * ------------------------------------------------------------------ */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */

export type ImportSource = "api" | "json" | "zip" | "md";

export interface HpSegment {
	/** Start offset in seconds. */
	start: number;
	end?: number;
	text: string;
	speaker?: string;
}

export interface HpActionItem {
	text: string;
	done?: boolean;
	/** ISO date (YYYY-MM-DD) or raw string if unparseable. */
	due?: string;
	assignee?: string;
}

export interface HpRecording {
	id: string;
	title: string;
	/** ISO-8601 string or "". */
	date: string;
	language: string;
	tags: string[];
	/** AI-generated summary (Notes tab), or null when absent. */
	summary: string | null;
	keyTakeaways: string[];
	actionItems: HpActionItem[];
	segments: HpSegment[];
	durationSec: number | null;
	recordedBy: string | null;
	/** speakerId -> display name */
	speakers: Record<string, string>;
	source: ImportSource;
}

/** Per-file parse result used by importers. */
export interface ParsedImport {
	recordings: HpRecording[];
	warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Small coercion helpers
 * ------------------------------------------------------------------ */


function num(obj: Record<string, unknown>, ...keys: string[]): number | null {
	for (const key of keys) {
		const v = obj[key];
		if (typeof v === "number" && isFinite(v)) return v;
		if (typeof v === "string") {
			const n = Number(v);
			if (v.trim() !== "" && isFinite(n)) return n;
		}
	}
	return null;
}

/** Accepts ISO strings or epoch seconds/millis; returns ISO or "". */
export function toIsoDate(value: unknown): string {
	if (typeof value === "string") {
		const t = new Date(value.trim());
		return isNaN(t.getTime()) ? "" : t.toISOString();
	}
	if (typeof value === "number" && isFinite(value)) {
		// Heuristic: values below 1e11 are epoch seconds, above are millis.
		const t = new Date(value > 1e11 ? value : value * 1000);
		return isNaN(t.getTime()) ? "" : t.toISOString();
	}
	return "";
}

/* ------------------------------------------------------------------ *
 * Sanitization
 * ------------------------------------------------------------------ */

/**
 * Characters forbidden (or hazardous) in Obsidian file/folder names:
 * * " \ / : < > | ? are invalid file-system characters in Obsidian;
 * # and ^ break wiki-links and block refs; NUL and control chars crash
 * path handling; leading/trailing dots and spaces are invalid on some
 * platforms.
 */
const INVALID_NAME_CHARS = /[*"\\/:<>|?#^\u0000-\u001f\u007f]/g;
const MAX_BASENAME_LENGTH = 120;
const MAX_FOLDER_LENGTH = 400;

/** Sanitize a single path segment (file basename or folder name). */
export function sanitizeSegment(name: string): string {
	let out = String(name ?? "")
		.replace(/[\u00a0\u2000-\u200b\ufeff]/g, " ")
		.replace(INVALID_NAME_CHARS, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "");
	if (out.length > MAX_BASENAME_LENGTH) out = out.slice(0, MAX_BASENAME_LENGTH).trim();
	out = out.replace(/[.\s]+$/, "");
	if (out === "" || out === "." || out === "..") out = "untitled";
	return out;
}

/**
 * Sanitize a vault-relative file basename. Slashes are flattened into the
 * basename (never interpreted as folders) so a crafted title can neither
 * escape the target folder nor create unexpected directories.
 */
export function sanitizeFileName(name: string): string {
	return sanitizeSegment(name);
}

/**
 * Sanitize a vault-relative folder path. Absolute paths, drive letters and
 * any `..` traversal segments are stripped; each remaining segment is
 * character-sanitized. "" means vault root.
 */
export function sanitizeFolderPath(path: string): string {
	let p = String(path ?? "").trim();
	if (p === "") return "";
	// Windows drive letters (`C:`) — the colon is stripped by segment
	// sanitization, but remove the drive prefix explicitly so `C:/foo`
	// degrades to `foo` rather than `Cfoo`.
	p = p.replace(/^[a-zA-Z]:/, "");
	const rawSegments = p.replace(/\\/g, "/").split("/");
	const clean: string[] = [];
	for (const seg of rawSegments) {
		const t = seg.trim();
		if (t === "" || t === "." || t === "..") continue; // traversal blocked
		clean.push(sanitizeSegment(t));
	}
	let joined = clean.join("/");
	if (joined.length > MAX_FOLDER_LENGTH) joined = joined.slice(0, MAX_FOLDER_LENGTH);
	return joined;
}

/** Obsidian-safe tag: no leading '#', no spaces or hazardous chars. */
export function sanitizeTag(tag: string): string {
	let t = String(tag ?? "").trim();
	t = t.replace(/^#+/, "");
	t = t.replace(/[*"\\/:<>|?#\u0000-\u001f\u007f^]/g, "");
	t = t.replace(/\s+/g, "-");
	t = t.replace(/[.\s]+$/, "").replace(/^[.\s-]+/, "");
	return t.slice(0, 64);
}

/* ------------------------------------------------------------------ *
 * Filename templates
 * ------------------------------------------------------------------ */

export interface TemplateVars {
	title: string;
	date: string; // YYYY-MM-DD
	year: string;
	month: string;
	day: string;
	id: string;
}

export function templateVarsFrom(rec: HpRecording): TemplateVars {
	const d = rec.date ? new Date(rec.date) : null;
	const valid = d !== null && !isNaN(d.getTime());
	const iso = valid ? (d as Date) : new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return {
		title: rec.title || "Untitled",
		date: valid ? `${iso.getUTCFullYear()}-${pad(iso.getUTCMonth() + 1)}-${pad(iso.getUTCDate())}` : "",
		year: valid ? String(iso.getUTCFullYear()) : "",
		month: valid ? pad(iso.getUTCMonth() + 1) : "",
		day: valid ? pad(iso.getUTCDate()) : "",
		id: rec.id || "no-id",
	};
}

/**
 * Render `{{token}}` placeholders, dropping unknown tokens, then sanitize
 * the result into a safe single-segment basename. Never returns "".
 */
export function renderFilenameTemplate(template: string, vars: TemplateVars): string {
	const t = String(template ?? "").trim() === "" ? "{{title}}" : template;
	const rendered = t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, token: string) => {
		const key = token.toLowerCase();
		if (Object.prototype.hasOwnProperty.call(vars, key)) {
			const value = vars[key as keyof TemplateVars];
			return value ?? "";
		}
		return ""; // unknown token removed
	});
	return sanitizeFileName(rendered);
}

/* ------------------------------------------------------------------ *
 * Time formatting
 * ------------------------------------------------------------------ */

export function formatTimestamp(seconds: number): string {
	const s = Math.max(0, Math.floor(isFinite(seconds) ? seconds : 0));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `0:${pad(m)}:${pad(sec)}`;
}

export function formatDuration(seconds: number | null): string {
	if (seconds === null || !isFinite(seconds)) return "";
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m`;
	return `${s}s`;
}

/* ------------------------------------------------------------------ *
 * Normalization of arbitrary HeyPocket JSON into HpRecording
 * ------------------------------------------------------------------ */

const ID_KEYS = ["id", "recordingId", "recording_id", "recordId", "uuid", "_id"];

function firstStr(obj: Record<string, unknown>, keys: string[]): string {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string" && v.trim() !== "") return v.trim();
	}
	return "";
}

export function stableHashId(seed: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `hp-${h.toString(16).padStart(8, "0")}`;
}

function syntheticId(rec: Record<string, unknown>): string {
	const title = firstStr(rec, ["title", "name"]);
	return stableHashId(`${title}|${firstStr(rec, ["created_at", "createdAt", "recording_at", "recordedAt", "date"])}`);
}

function normTags(raw: unknown): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (tag: string) => {
		const t = sanitizeTag(tag);
		if (t && !seen.has(t.toLowerCase())) {
			seen.add(t.toLowerCase());
			out.push(t);
		}
	};
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (typeof item === "string") push(item);
			else if (isRecord(item)) push(firstStr(item, ["name", "label", "title"]));
		}
	} else if (typeof raw === "string") {
		for (const part of raw.split(/[,;]/)) push(part);
	}
	return out;
}

function normSegments(raw: unknown, speakers: Record<string, string>): HpSegment[] {
	const out: HpSegment[] = [];
	if (!Array.isArray(raw)) return out;
	for (const item of raw) {
		if (!isRecord(item)) continue;
		let text = firstStr(item, ["text", "content", "transcript"]);
		if (text === "" && typeof item.originalText === "string") text = item.originalText.trim();
		if (text === "") continue;
		const start = num(item, "start", "startTime", "start_time", "begin") ?? 0;
		const endRaw = num(item, "end", "endTime", "end_time");
		let speaker = firstStr(item, ["speaker", "speakerName", "speaker_name", "label", "who"]);
		if (speaker && speakers[speaker]) speaker = speakers[speaker];
		const sid = firstStr(item, ["speakerId", "speaker_id"]);
		if (!speaker && sid && speakers[sid]) speaker = speakers[sid];
		if (speaker) speaker = normalizeSpeakerLabel(speaker);
		const seg: HpSegment = { start: Math.max(0, start), text };
		if (endRaw !== null && endRaw >= start) seg.end = endRaw;
		if (speaker) seg.speaker = speaker;
		out.push(seg);
	}
	out.sort((a, b) => a.start - b.start);
	return out;
}

function normTakeaways(raw: unknown): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (t: string) => {
		const trimmed = t.replace(/\s+/g, " ").trim();
		if (trimmed && !seen.has(trimmed.toLowerCase())) {
			seen.add(trimmed.toLowerCase());
			out.push(trimmed);
		}
	};
	if (typeof raw === "string") {
		for (const line of raw.split(/\r?\n/)) push(line.replace(/^[-*\u2022]\s*/, ""));
	} else if (Array.isArray(raw)) {
		for (const item of raw) {
			if (typeof item === "string") push(item);
			else if (isRecord(item)) push(firstStr(item, ["text", "content", "title", "point", "summary"]));
		}
	}
	return out;
}

function normActionItems(raw: unknown): HpActionItem[] {
	const out: HpActionItem[] = [];
	if (isRecord(raw)) {
		// Wrapper shape used by v2 payloads: { version, actionItems: [...] }.
		return normActionItems(raw.actionItems ?? raw.items ?? raw.tasks ?? raw.todos);
	}
	if (!Array.isArray(raw)) return out;
	for (const item of raw) {
		if (typeof item === "string") {
			const t = item.trim();
			if (t) out.push({ text: t });
			continue;
		}
		if (!isRecord(item)) continue;
		const text = firstStr(item, ["text", "content", "title", "description", "task", "action"]);
		if (!text) continue;
		const ai: HpActionItem = { text };
		if (item.done === true || item.completed === true || item.isCompleted === true || item.is_completed === true) ai.done = true;
		const status = firstStr(item, ["status", "state"]).toLowerCase();
		if (status === "done" || status === "completed") ai.done = true;
		const dueIso = toIsoDate(item.due ?? item.due_date ?? item.dueDate ?? item.deadline);
		if (dueIso) ai.due = dueIso.slice(0, 10);
		const assignee = firstStr(item, ["assignee", "assignedTo", "assigned_to", "owner"]);
		if (assignee) ai.assignee = assignee;
		out.push(ai);
	}
	return out;
}

function normSpeakers(raw: unknown): Record<string, string> {
	const map: Record<string, string> = {};
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (isRecord(item)) {
				const id = firstStr(item, ["speakerId", "id", "uuid"]);
				const name = firstStr(item, ["name", "label"]);
				if (id && name) map[id] = name;
			}
		}
	} else if (isRecord(raw)) {
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value === "string" && value.trim()) map[key] = value.trim();
			else if (isRecord(value)) {
				const name = firstStr(value, ["name", "label"]);
				if (name) map[key] = name;
			}
		}
	}
	return map;
}

/** Keys that mark a record as an actual summarization entry vs an id-keyed map. */
const SUMMARIZATION_KEYS = [
	"summary", "summaries", "text", "content", "markdown", "body", "sections", "parts", "v2",
	"key_takeaways", "keyTakeaways", "takeaways", "highlights",
	"action_items", "actionItems", "todos", "tasks", "nextSteps", "next_steps",
];

function looksLikeSummarization(rec: Record<string, unknown>): boolean {
	return SUMMARIZATION_KEYS.some((k) => rec[k] !== undefined && rec[k] !== null);
}

/** Accepts an array, a single entry object, or an id-keyed dictionary of entries. */
function consumeSummarizations(value: unknown, acc: SummarizationAcc): void {
	if (Array.isArray(value)) {
		for (const entry of value) consumeSummarization(entry, acc);
		return;
	}
	if (!isRecord(value)) return;
	if (looksLikeSummarization(value)) consumeSummarization(value, acc);
	else for (const entry of Object.values(value)) consumeSummarization(entry, acc);
}

interface SummarizationAcc {
	summary: string[];
	takeaways: unknown[];
	actions: unknown[];
}

/** Pull summary/takeaways/action items out of a summarization entry. */
function consumeSummarization(entry: unknown, acc: SummarizationAcc): void {
	if (!isRecord(entry)) return;
	const summaryText = firstStr(entry, ["summary", "fullSummary", "full_summary", "text", "content", "markdown", "body"]);
	if (summaryText) acc.summary.push(summaryText);
	// v2 payload: summary is an object with `markdown` + `bulletPoints`.
	if (isRecord(entry.summary)) {
		const md = firstStr(entry.summary, ["markdown", "text", "content", "body"]);
		if (md) acc.summary.push(md);
		const bp = entry.summary.bulletPoints ?? entry.summary.bullet_points ?? entry.summary.keyTakeaways ?? entry.summary.key_takeaways;
		if (bp !== undefined) acc.takeaways.push(bp);
	}
	const sections = entry.sections ?? entry.parts;
	if (Array.isArray(sections)) {
		for (const section of sections) {
			if (!isRecord(section)) continue;
			const heading = firstStr(section, ["title", "heading", "name"]);
			const body = firstStr(section, ["content", "text", "body"]);
			if (heading && body) acc.summary.push(`**${heading}**\n${body}`);
			else if (body) acc.summary.push(body);
		}
	}
	const tk = entry.key_takeaways ?? entry.keyTakeaways ?? entry.takeaways ?? entry.highlights;
	if (tk !== undefined) acc.takeaways.push(tk);
	const ai = entry.action_items ?? entry.actionItems ?? entry.todos ?? entry.tasks ?? entry.nextSteps ?? entry.next_steps;
	if (ai !== undefined) acc.actions.push(ai);
	if (isRecord(entry.v2)) consumeSummarization(entry.v2, acc);
	consumeSummarizations(entry.summarizations, acc);
}

/** Normalize one raw HeyPocket recording object. Throws on garbage input. */
export function normalizeRecording(input: unknown, source: ImportSource): HpRecording {
	if (!isRecord(input)) throw new Error("Recording entry is not an object");
	const raw = input;
	const hasContent =
		raw.id !== undefined ||
		raw.recordingId !== undefined ||
		raw.title !== undefined ||
		raw.transcript !== undefined ||
		raw.summary !== undefined ||
		raw.summarizations !== undefined ||
		raw.content !== undefined;
	if (!hasContent) throw new Error("Recording entry has none of the expected HeyPocket fields");

	const id = firstStr(raw, ID_KEYS) || syntheticId(raw);
	const title = firstStr(raw, ["title", "name", "subject"]) || "Untitled recording";

	let date = toIsoDate(raw.recording_at ?? raw.recordingAt ?? raw.recordedAt ?? raw.recorded_at ?? raw.date);
	if (date === "") date = toIsoDate(raw.created_at ?? raw.createdAt ?? raw.updated_at ?? raw.updatedAt);

	const language =
		firstStr(raw, ["language", "lang", "languageCode", "language_code"]) ||
		(isRecord(raw.translation) ? firstStr(raw.translation as Record<string, unknown>, ["to_language", "toLanguage", "detected_language"]) : "");

	const speakers = normSpeakers(raw.speakers);

	let segments: HpSegment[] = [];
	const transcript = raw.transcript ?? raw.transcriptSegments ?? raw.transcript_segments ?? raw.paragraphs;
	if (typeof transcript === "string") {
		// Plain-text transcript (older exports / MCP `transcript`): kept as one
		// 0-offset segment — fabricating a timestamp per line would lie.
		const text = transcript.trim();
		if (text !== "") segments = [{ start: 0, text }];
	} else if (isRecord(transcript)) {
		segments = normSegments(transcript.segments ?? transcript.paragraphs ?? transcript.items, speakers);
	} else if (Array.isArray(transcript)) {
		segments = normSegments(transcript, speakers);
	}

	const acc: SummarizationAcc = { summary: [], takeaways: [], actions: [] };
	consumeSummarizations(raw.summarizations ?? raw.summarization, acc);
	// Top-level `summary` string (MCP / simple exports).
	const topSummary = firstStr(raw, ["summary", "aiSummary", "ai_summary"]);
	if (topSummary) acc.summary.unshift(topSummary);
	const topTakeaways = raw.key_takeaways ?? raw.keyTakeaways ?? raw.takeaways ?? raw.highlights;
	if (topTakeaways !== undefined) acc.takeaways.unshift(topTakeaways);
	const topActions = raw.action_items ?? raw.actionItems ?? raw.todos ?? raw.next_steps ?? raw.nextSteps;
	if (topActions !== undefined) acc.actions.unshift(topActions);

	const summary = acc.summary.length > 0 ? acc.summary.join("\n\n").trim() : null;

	const keyTakeaways: string[] = [];
	const seenT = new Set<string>();
	for (const group of acc.takeaways) {
		for (const t of normTakeaways(group)) {
			if (!seenT.has(t.toLowerCase())) {
				seenT.add(t.toLowerCase());
				keyTakeaways.push(t);
			}
		}
	}

	const actionItems: HpActionItem[] = [];
	for (const group of acc.actions) actionItems.push(...normActionItems(group));

	return {
		id,
		title,
		date,
		language,
		tags: normTags(raw.tags ?? raw.labels),
		summary,
		keyTakeaways,
		actionItems,
		segments,
		durationSec: num(raw, "duration", "durationSec", "duration_sec", "lengthSec"),
		recordedBy:
			(isRecord(raw.recorded_by) ? firstStr(raw.recorded_by as Record<string, unknown>, ["display_name", "displayName", "email", "name"]) : "") ||
			firstStr(raw, ["recordedBy", "createdBy", "owner"]),
		speakers,
		source,
	};
}

export function dedupeKey(rec: HpRecording): string {
	return rec.id !== "" ? `id:${rec.id}` : `tk:${rec.title.toLowerCase()}|${rec.date}`;
}

export function dedupeRecordings(recs: HpRecording[]): { recordings: HpRecording[]; removed: number } {
	const seen = new Set<string>();
	const out: HpRecording[] = [];
	let removed = 0;
	for (const r of recs) {
		const key = dedupeKey(r);
		if (seen.has(key)) {
			removed++;
			continue;
		}
		seen.add(key);
		out.push(r);
	}
	return { recordings: out, removed };
}

/**
 * Normalize an arbitrary parsed-JSON payload (single recording, array,
 * `{recordings|data|results|items|notes: [...]}` envelope, nested up to a
 * depth cap) into recordings.
 */
function isRecordingLike(node: Record<string, unknown>): boolean {
	return (
		node.id !== undefined ||
		node.recordingId !== undefined ||
		node.recording_id !== undefined ||
		node.title !== undefined ||
		node.transcript !== undefined ||
		node.summarizations !== undefined ||
		node.recording_at !== undefined ||
		node.recordedAt !== undefined
	);
}

export function normalizePayload(input: unknown, source: ImportSource): ParsedImport {
	const warnings: string[] = [];
	const list: unknown[] = [];
	const unwrap = (node: unknown, depth: number): void => {
		if (depth > 6) return;
		if (Array.isArray(node)) {
			for (const item of node) unwrap(item, depth + 1);
			return;
		}
		if (!isRecord(node)) return;
		const container = node.recordings ?? node.results ?? node.items ?? node.notes ?? node.data;
		if (!isRecordingLike(node) && (Array.isArray(container) || isRecord(container))) {
			unwrap(container, depth + 1);
			return;
		}
		list.push(node);
	};
	if (Array.isArray(input) || isRecord(input)) {
		unwrap(input, 0);
	} else {
		throw new Error("Unsupported JSON root — expected an object or array");
	}

	const recordings: HpRecording[] = [];
	for (let i = 0; i < list.length; i++) {
		try {
			recordings.push(normalizeRecording(list[i], source));
		} catch (e) {
			warnings.push(`Skipped entry #${i + 1}: ${(e as Error).message}`);
		}
	}
	if (recordings.length === 0 && warnings.length === list.length) {
		throw new Error("No valid HeyPocket recordings found in input");
	}
	const deduped = dedupeRecordings(recordings);
	if (deduped.removed > 0) warnings.push(`Removed ${deduped.removed} duplicate recording(s).`);
	return { recordings: deduped.recordings, warnings };
}

/* ------------------------------------------------------------------ *
 * HeyPocket webapp Markdown exports
 *
 * The webapp exports each recording as a pair of .md files sharing a
 * filename slug:
 *   <slug>-transcription.md → title line (optionally an `# ` heading), then
 *                              `**SPEAKER_00:**` blocks with no timestamps
 *   <slug>-summary.md       → `# Title`, `###` sections, takeaways under
 *                              highlight headings, and `- [ ]` action
 *                              items with `**Assignee:** … **Due:** …`
 *                              metadata lines
 * ------------------------------------------------------------------ */

export type MdPartKind = "transcript" | "summary" | "unknown";

export interface HeyPocketMarkdownParts {
	kind: MdPartKind;
	title: string;
	segments: HpSegment[];
	summary: string | null;
	keyTakeaways: string[];
	actionItems: HpActionItem[];
}

const SPEAKER_MARKER = /^\*\*([^*\n]+?):\*\*\s*$/;
/** `**SPEAKER_00:** text` — the marker and utterance share one line. */
const SPEAKER_MARKER_INLINE = /^\*\*([^*\n]+?):\*\*\s+(.+)$/;
/** Inline markers whose label is a diarized speaker id (routers must stay strict). */
const INLINE_SPEAKER_LINE = /^\*\*(?:SPEAKER[_\s-]*\d+|Speaker\s*\d+):\*\*\s+\S/i;
const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const MD_CHECKBOX = /^\s*[-*+]\s*\[([ xX])\]\s*(.*)$/;
const MD_BULLET = /^\s*[-*+]\s+(?!\[[ xX]\])(.*)$/;
const MD_ASSIGNEE = /\*\*Assign(?:ee|ed)(?: to)?:\*\*\s*([^|\n]+?)(?:\s*\||\s*$)/i;
const MD_DUE = /\*\*Due(?:\s*date)?:\*\*\s*([^|\n]+?)(?:\s*\||\s*$)/i;
const MD_SECTION_WORD = /\b(action items|next steps|key takeaways|highlights)\b/i;
const MD_TRAILING_ROLE_LINE = /^[^,.!?…]*\s[-–—]\s(Transcriptions?|Action\s*Items)\s*$/i;
const TITLE_ROLE_SUFFIX = /\s*[-–—]\s*(Transcript|Transcription|Summary|Notes|Action\s*Items|Key\s*Takeaways)\s*$/i;
const FILE_SLUG_SUFFIX = /[-_](transcriptions?|summaries|summary|notes|action[-_]?items|key[-_]?takeaways)$/i;
const FILE_ROLE_TRANSCRIPT = /[-_]transcriptions?$/i;

/** Map `SPEAKER_00` → `Speaker 1`; pass real names through unchanged. */
export function normalizeSpeakerLabel(name: string): string {
	const m = /^SPEAKER[_\s-]*(\d+)$/i.exec(name.trim());
	if (m) return `Speaker ${Number(m[1]) + 1}`;
	return name.trim();
}

/** `interview-john-x-summary.md` → `interview-john-x`. */
export function mdSlugFromFileName(name: string): string {
	return name.replace(/\.(md|markdown)$/i, "").replace(FILE_SLUG_SUFFIX, "");
}

export function mdRoleFromFileName(name: string): "transcript" | "summary" | null {
	const base = name.replace(/\.(md|markdown)$/i, "");
	if (FILE_ROLE_TRANSCRIPT.test(base)) return "transcript";
	if (FILE_SLUG_SUFFIX.test(base)) return "summary";
	return null;
}

function cleanInline(value: string): string {
	return value.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
}

function stripTitleSuffix(title: string): string {
	return cleanInline(title.replace(TITLE_ROLE_SUFFIX, "").replace(/^#+\s*/, ""));
}

function humanizeMdName(name: string): string {
	const words = mdSlugFromFileName(name).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
	if (words === "") return "Untitled recording";
	return words.replace(/(^\p{L})|(\s\p{L})/gu, (m) => m.toUpperCase());
}

function unknownMarkdownParts(): HeyPocketMarkdownParts {
	return { kind: "unknown", title: "", segments: [], summary: null, keyTakeaways: [], actionItems: [] };
}

function isSummarySectionHeading(line: string): boolean {
	const t = line.trim();
	const heading = MD_HEADING.exec(t);
	if (heading !== null) return MD_SECTION_WORD.test(heading[2]);
	const bold = /^\*\*(.+?)\*\*:?\s*$/.exec(t);
	return bold !== null && MD_SECTION_WORD.test(bold[1]);
}

function parseMdTranscript(lines: string[], fileNameHint: string): HeyPocketMarkdownParts {
	const segments: HpSegment[] = [];
	let speaker = "";
	let buffer: string[] = [];
	let title = "";
	const flush = (): void => {
		const text = buffer.join(" ").replace(/\s+/g, " ").trim();
		if (text !== "") segments.push({ start: 0, text, ...(speaker !== "" ? { speaker } : {}) });
		buffer = [];
	};
	for (const raw of lines) {
		const line = raw.trim();
		if (line === "") {
			flush();
			continue;
		}
		if (/^-{3,}$/.test(line)) continue; // horizontal rule
		const marker = SPEAKER_MARKER.exec(line);
		if (marker) {
			flush();
			speaker = normalizeSpeakerLabel(marker[1]);
			continue;
		}
		const inline = SPEAKER_MARKER_INLINE.exec(line);
		if (inline) {
			flush();
			speaker = normalizeSpeakerLabel(inline[1]);
			buffer.push(inline[2]);
			continue;
		}
		if (speaker === "" && segments.length === 0 && title === "") {
			title = stripTitleSuffix(line);
			continue;
		}
		buffer.push(line);
	}
	flush();
	if (title === "") title = stripTitleSuffix(humanizeMdName(fileNameHint));
	return {
		kind: segments.length > 0 ? "transcript" : "unknown",
		title: segments.length > 0 ? title : "",
		segments,
		summary: null,
		keyTakeaways: [],
		actionItems: [],
	};
}

function parseMdSummary(lines: string[], fileNameHint: string): HeyPocketMarkdownParts {
	let title = "";
	const body: string[] = [];
	const keyTakeaways: string[] = [];
	const actionItems: HpActionItem[] = [];
	let pendingAssignee = "";
	let pendingDue = "";
	let inTakeawaySection = false;

	for (const raw of lines) {
		const line = raw.replace(/\s+$/, "");
		const trimmed = line.trim();
		if (/^-{3,}$/.test(trimmed)) continue;

		const heading = MD_HEADING.exec(trimmed);
		if (heading) {
			const headingText = cleanInline(heading[2]);
			if (heading[1].length === 1 && title === "") {
				title = stripTitleSuffix(heading[2]);
				continue; // H1 duplicates the note heading; drop from body
			}
			inTakeawaySection = /highlight|takeaway|key\s*point/i.test(headingText);
			if (!inTakeawaySection) body.push(trimmed); // highlights live in the Key Takeaways section
			continue;
		}

		const checkbox = MD_CHECKBOX.exec(line);
		if (checkbox) {
			const text = cleanInline(checkbox[2]);
			if (text !== "") {
				const item: HpActionItem = { text };
				if (checkbox[1].toLowerCase() === "x") item.done = true;
				if (pendingAssignee !== "") item.assignee = pendingAssignee;
				if (pendingDue !== "") item.due = pendingDue;
				actionItems.push(item);
			}
			pendingAssignee = "";
			pendingDue = "";
			inTakeawaySection = false;
			continue;
		}

		if (MD_ASSIGNEE.test(trimmed) || MD_DUE.test(trimmed)) {
			const assignee = MD_ASSIGNEE.exec(trimmed);
			if (assignee) pendingAssignee = cleanInline(assignee[1]);
			const due = MD_DUE.exec(trimmed);
			if (due) {
				const dm = /(\d{4}-\d{2}-\d{2})/.exec(due[1]);
				pendingDue = dm ? dm[1] : cleanInline(due[1]).slice(0, 32);
			}
			continue; // metadata is folded into the following checkbox
		}

		if (MD_TRAILING_ROLE_LINE.test(trimmed)) continue; // stray "…- Action Items" footer line

		if (inTakeawaySection) {
			const bullet = MD_BULLET.exec(line);
			if (bullet) {
				const t = cleanInline(bullet[1]);
				if (t !== "") keyTakeaways.push(t);
				continue; // extracted to Key Takeaways; keep body lean
			}
		}
		body.push(line);
		inTakeawaySection = false;
	}

	if (title === "") title = stripTitleSuffix(humanizeMdName(fileNameHint));
	const summaryText = body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	return {
		kind: "summary",
		title,
		segments: [],
		summary: summaryText === "" ? null : summaryText,
		keyTakeaways,
		actionItems,
	};
}

/** Sniff and parse a HeyPocket webapp Markdown export (either role). */
export function parseHeyPocketMarkdown(text: string, fileNameHint = ""): HeyPocketMarkdownParts {
	const cleaned = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
	const lines = cleaned.split("\n");
	if (!lines.some((l) => l.trim() !== "")) return unknownMarkdownParts();

	const hasHeading = lines.some((l) => MD_HEADING.test(l.trim()));
	const markerCount = lines.reduce((n, l) => {
		const t = l.trim();
		return SPEAKER_MARKER.test(t) || INLINE_SPEAKER_LINE.test(t) ? n + 1 : n;
	}, 0);
	const roleHint = mdRoleFromFileName(fileNameHint);

	const hasCheckbox = lines.some((l) => MD_CHECKBOX.test(l));
	const hasMeta = MD_ASSIGNEE.test(cleaned) || MD_DUE.test(cleaned);
	const hasFooter = lines.some((l) => MD_TRAILING_ROLE_LINE.test(l.trim()));
	const hasSectionHeading = lines.some(isSummarySectionHeading);
	const fingerprint = hasCheckbox || hasMeta || hasFooter || hasSectionHeading || (roleHint === "summary" && hasHeading);

	// Speaker-marker-dominant files go to the transcript parser even when the
	// webapp prefixed them with an `# Title` heading; only summary-shaped
	// fingerprints (or a summary filename + heading) route to the summary parser.
	if (markerCount >= 2 && !fingerprint) return parseMdTranscript(lines, fileNameHint);
	if (fingerprint) return parseMdSummary(lines, fileNameHint);
	if (!hasHeading && markerCount >= 1) return parseMdTranscript(lines, fileNameHint);
	return unknownMarkdownParts();
}

/**
 * Combine transcript + summary Markdown parts (either may be absent) into
 * one recording. `groupKey` is the folder + slug; the stable id derives
 * from slug basename + title so ZIP and vault imports of the same export
 * produce the same id and honor the overwrite policy.
 */
export function buildMdRecording(groupKey: string, transcript: HeyPocketMarkdownParts | null, summary: HeyPocketMarkdownParts | null): HpRecording {
	const base = groupKey.slice(groupKey.lastIndexOf("/") + 1);
	const title =
		(summary !== null && summary.title !== "" && summary.kind !== "unknown" ? summary.title : "") ||
		(transcript !== null && transcript.title !== "" ? transcript.title : "") ||
		stripTitleSuffix(humanizeMdName(base));
	const id = stableHashId(`${mdSlugFromFileName(base).toLowerCase()}|${title.toLowerCase()}`);
	const sum = summary !== null && summary.kind !== "unknown" ? summary : null;
	const tr = transcript !== null && transcript.kind !== "unknown" ? transcript : null;
	const segments = tr !== null ? tr.segments : [];
	const speakers: Record<string, string> = {};
	for (const seg of segments) if (seg.speaker !== undefined) speakers[seg.speaker] = seg.speaker;
	return {
		id,
		title,
		date: "",
		language: "",
		tags: [],
		summary: sum !== null ? sum.summary : null,
		keyTakeaways: sum !== null ? sum.keyTakeaways : [],
		actionItems: sum !== null ? sum.actionItems : [],
		segments,
		speakers,
		durationSec: null,
		recordedBy: null,
		source: "md",
	};
}
