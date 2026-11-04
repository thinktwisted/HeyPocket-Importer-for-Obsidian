/*
 * Manual imports: parse HeyPocket exports — JSON (single object, array, or
 * `{ success, data|recordings: [...] }` envelope), Markdown files from the
 * webapp (`<slug>-transcription.md` + `<slug>-summary.md`), and ZIP archives
 * containing any of those — then write normalized recordings into the vault.
 *
 * All vault paths pass through the sanitizers in src/models/heypocket.ts:
 * illegal filename characters are removed and `..` / absolute segments can
 * never escape the target folder.
 */

import { TFile, Vault, normalizePath } from "obsidian";
import { strFromU8, unzipSync } from "fflate";
import {
	HpRecording,
	ParsedImport,
	dedupeRecordings,
	normalizePayload,
	renderFilenameTemplate,
	sanitizeFolderPath,
	templateVarsFrom,
	HeyPocketMarkdownParts,
	buildMdRecording,
	mdRoleFromFileName,
	mdSlugFromFileName,
	parseHeyPocketMarkdown,
} from "../models/heypocket";
import { convertRecordingToMarkdown } from "./markdownConverter";

export type OverwritePolicy = "skip" | "overwrite" | "rename";

export interface ImportOptions {
	folder: string;
	filenameTemplate: string;
	extraTags: string[];
	policy: OverwritePolicy;
	includeTranscript: boolean;
	onProgress?: (done: number, total: number) => void;
}

export interface ImportReport {
	created: number;
	updated: number;
	skipped: number;
	renamed: number;
	failed: number;
	errors: string[];
}

/** Upper bound on importable (JSON or Markdown) entries in one ZIP archive. */
const MAX_ZIP_ENTRIES = 500;

/** Hard cap on the *declared* decompressed size of one archive. */
const MAX_ZIP_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function parseJsonPayload(text: string, source: "json" | "zip"): ParsedImport {
	const trimmed = text.replace(/^\ufeff/, "").trim();
	if (trimmed === "") throw new Error("File is empty.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new Error(`Invalid JSON: ${errorMessage(error)}`);
	}
	return normalizePayload(parsed, source);
}

function isRelevantZipEntry(name: string): boolean {
	if (name.endsWith("/")) return false; // directory entry
	if (name.startsWith("__MACOSX/") || name.startsWith(".")) return false;
	const base = name.slice(name.lastIndexOf("/") + 1);
	if (base.startsWith(".")) return false;
	const lower = base.toLowerCase();
	return lower.endsWith(".json") || lower.endsWith(".md") || lower.endsWith(".markdown");
}

export interface ZipManifestEntry {
	name: string;
	/** Declared uncompressed size in bytes; -1 when unknown (zip64). */
	size: number;
}

/**
 * Read the ZIP central directory without decompressing anything. Returns
 * entry names + declared sizes, or null when the layout is not a plain
 * archive we can interpret.
 */
export function zipManifest(data: Uint8Array): ZipManifestEntry[] | null {
	if (data.byteLength < 22) return null;
	const view = new DataView(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
	let eocd = -1;
	const scanStart = Math.max(0, data.byteLength - 66_000);
	for (let i = data.byteLength - 22; i >= scanStart; i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd === -1) return null;
	let count = view.getUint16(eocd + 10, true);
	let cd = view.getUint32(eocd + 16, true);
	if (count === 0xffff || cd === 0xffffffff) {
		// zip64: the real table lives behind the EOCD64 locator record.
		const locator = eocd - 20;
		if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) return null;
		const eocd64 = u64(view, locator + 8);
		if (eocd64 + 56 > data.byteLength || view.getUint32(eocd64, true) !== 0x06064b50) return null;
		count = u64(view, eocd64 + 32);
		cd = u64(view, eocd64 + 48);
		if (cd >= data.byteLength) return null;
	}
	const entries: ZipManifestEntry[] = [];
	for (let n = 0; n < count; n++) {
		if (cd + 46 > data.byteLength || view.getUint32(cd, true) !== 0x02014b50) return null;
		const nameLen = view.getUint16(cd + 28, true);
		const extraLen = view.getUint16(cd + 30, true);
		const commentLen = view.getUint16(cd + 32, true);
		const nameStart = cd + 46;
		if (nameStart + nameLen > data.byteLength) return null;
		let name = "";
		for (let i = 0; i < nameLen; i++) name += String.fromCharCode(view.getUint8(nameStart + i));
		let size = view.getUint32(cd + 24, true);
		if (size === 0xffffffff) size = zip64UncompressedSize(view, nameStart + nameLen, extraLen);
		if (size === 0xffffffff) size = -1; // unverifiable placeholder
		entries.push({ name, size });
		cd = nameStart + nameLen + extraLen + commentLen;
	}
	return entries;
}

/**
 * zip64 extended-information extra field: the uncompressed size is the first
 * 8-byte member exactly when the central-directory slot held 0xFFFFFFFF.
 */
function u64(view: DataView, at: number): number {
	return view.getUint32(at, true) + view.getUint32(at + 4, true) * 4294967296;
}

function zip64UncompressedSize(view: DataView, start: number, len: number): number {
	const end = Math.min(start + len, view.byteLength);
	let p = start;
	while (p + 4 <= end) {
		const id = view.getUint16(p, true);
		const fieldLen = view.getUint16(p + 2, true);
		if (id === 0x0001 && fieldLen >= 8 && p + 12 <= end) return u64(view, p + 4);
		p += 4 + fieldLen;
	}
	return 0xffffffff;
}

/** Human-readable rejection when the archive's declared contents exceed the budget. */
export function zipBudgetError(entries: ZipManifestEntry[]): string | null {
	const relevant = entries.filter((entry) => isRelevantZipEntry(entry.name));
	if (relevant.length > MAX_ZIP_ENTRIES) {
		return `ZIP archive declares ${relevant.length} importable entries (limit is ${MAX_ZIP_ENTRIES}).`;
	}
	let total = 0;
	for (const entry of relevant) {
		if (entry.size === -1) {
			return "ZIP archive uses zip64 size fields the importer cannot verify — unzip it and import the files or a recompressed archive.";
		}
		total += entry.size;
		if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
			return `ZIP archive expands to more than ${Math.floor(MAX_ZIP_UNCOMPRESSED_BYTES / (1024 * 1024))} MB of JSON/Markdown — refusing to import.`;
		}
	}
	return null;
}

export function parseZipArchive(data: Uint8Array): ParsedImport {
	const manifest = zipManifest(data);
	if (manifest === null) {
		throw new Error("Could not read ZIP archive: its structure cannot be verified before decompression (corrupt or non-standard zip). Unzip it and import the files directly.");
	}
	const budget = zipBudgetError(manifest);
	if (budget !== null) throw new Error(budget);
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(data, { filter: (entry) => isRelevantZipEntry(entry.name) });
	} catch (error) {
		throw new Error(`Could not read ZIP archive: ${errorMessage(error)}`);
	}
	const names = Object.keys(files).sort((a, b) => a.localeCompare(b));
	if (names.length === 0) {
		throw new Error("No .json or .md files found inside the ZIP archive. Export recordings from HeyPocket as JSON or Markdown.");
	}
	if (names.length > MAX_ZIP_ENTRIES) {
		throw new Error(`ZIP archive contains ${names.length} JSON/Markdown entries (limit is ${MAX_ZIP_ENTRIES}).`);
	}

	const recordings: HpRecording[] = [];
	const warnings: string[] = [];
	const markdownEntries: MarkdownFileEntry[] = [];
	for (const name of names) {
		if (/\.(md|markdown)$/i.test(name)) {
			try {
				markdownEntries.push({ name, text: strFromU8(files[name]) });
			} catch (error) {
				warnings.push(`${name}: could not decode text: ${errorMessage(error)}`);
			}
			continue;
		}
		try {
			const result = parseJsonPayload(strFromU8(files[name]), "zip");
			recordings.push(...result.recordings);
			for (const warning of result.warnings) warnings.push(`${name}: ${warning}`);
		} catch (error) {
			warnings.push(`${name}: ${errorMessage(error)}`);
		}
	}
	if (markdownEntries.length > 0) {
		try {
			const md = parseMarkdownBundle(markdownEntries);
			recordings.push(...md.recordings);
			warnings.push(...md.warnings);
		} catch (error) {
			warnings.push(`Markdown files: ${errorMessage(error)}`);
		}
	}
	if (recordings.length === 0) {
		throw new Error(
			warnings.length > 0 ? `No valid HeyPocket recordings in archive. First error: ${warnings[0]}` : "No valid HeyPocket recordings in archive."
		);
	}
	const deduped = dedupeRecordings(recordings);
	if (deduped.removed > 0) warnings.push(`Removed ${deduped.removed} duplicate recording(s) across files.`);
	return { recordings: deduped.recordings, warnings };
}

export interface MarkdownFileEntry {
	name: string;
	text: string;
}

/**
 * Group `<slug>-transcription.md` / `<slug>-summary.md` (either role may be
 * absent) by directory + slug and build one recording per pair.
 */
export function parseMarkdownBundle(entries: MarkdownFileEntry[]): ParsedImport {
	const warnings: string[] = [];
	interface Group {
		transcript: HeyPocketMarkdownParts | null;
		summary: HeyPocketMarkdownParts | null;
	}
	const groups = new Map<string, Group>();
	const order: string[] = [];
	for (const entry of entries) {
		let parts: HeyPocketMarkdownParts;
		try {
			parts = parseHeyPocketMarkdown(entry.text, entry.name.slice(entry.name.lastIndexOf("/") + 1));
		} catch (error) {
			warnings.push(`${entry.name}: ${errorMessage(error)}`);
			continue;
		}
		if (parts.kind === "unknown") {
			warnings.push(`${entry.name}: does not look like a HeyPocket Markdown export — ignored.`);
			continue;
		}
		const base = entry.name.slice(entry.name.lastIndexOf("/") + 1);
		const dir = entry.name.slice(0, entry.name.length - base.length);
		const role: "transcript" | "summary" = parts.kind; // content decides, filename only groups
		const slug = dir + mdSlugFromFileName(base);
		let key = slug;
		for (let bump = 2; ; bump++) {
			const group = groups.get(key);
			if (!group) {
				groups.set(key, role === "transcript" ? { transcript: parts, summary: null } : { transcript: null, summary: parts });
				order.push(key);
				break;
			}
			if (role === "transcript" ? group.transcript === null : group.summary === null) {
				group[role] = parts;
				break;
			}
			key = `${slug} (${bump})`;
		}
	}
	const recordings = order.map((key) => buildMdRecording(key, groups.get(key)?.transcript ?? null, groups.get(key)?.summary ?? null));
	return { recordings, warnings };
}

/** Read a vault file (.json, .md/.markdown, or .zip) and parse it. */
export async function readAndParseFile(vault: Vault, file: TFile): Promise<ParsedImport> {
	const ext = file.extension.toLowerCase();
	if (ext === "zip") {
		const buffer = await vault.readBinary(file);
		return parseZipArchive(new Uint8Array(buffer));
	}
	if (ext === "json") {
		return parseJsonPayload(await vault.read(file), "json");
	}
	if (ext === "md" || ext === "markdown") {
		return parseMarkdownVaultFile(vault, file);
	}
	throw new Error(`Unsupported file type ".${ext}" — HeyPocket Importer accepts .json, .md, and .zip files.`);
}

async function parseMarkdownVaultFile(vault: Vault, file: TFile): Promise<ParsedImport> {
	const parts = parseHeyPocketMarkdown(await vault.read(file), file.name);
	if (parts.kind === "unknown") {
		throw new Error(`"${file.name}" does not look like a HeyPocket Markdown export (no speaker blocks, action-item checkboxes, or export section headings).`);
	}
	const role: "transcript" | "summary" = parts.kind;
	const otherRole: "transcript" | "summary" = role === "transcript" ? "summary" : "transcript";
	const dir = file.path.slice(0, file.path.lastIndexOf("/") + 1);
	const slug = mdSlugFromFileName(file.name);
	const group: { transcript: HeyPocketMarkdownParts | null; summary: HeyPocketMarkdownParts | null } = {
		transcript: role === "transcript" ? parts : null,
		summary: role === "summary" ? parts : null,
	};
	const warnings: string[] = [];
	for (const candidate of vault.getFiles()) {
		if (candidate.path === file.path || !candidate.path.startsWith(dir) || candidate.path.slice(dir.length).includes("/")) continue;
		if (!["md", "markdown"].includes(candidate.extension.toLowerCase())) continue;
		if (mdRoleFromFileName(candidate.name) !== otherRole || mdSlugFromFileName(candidate.name) !== slug) continue;
		const sibling = parseHeyPocketMarkdown(await vault.read(candidate), candidate.name);
		if (sibling.kind === "unknown") {
			warnings.push(`${candidate.name}: ignored — not a HeyPocket Markdown export.`);
		} else {
			group[otherRole] = sibling;
		}
		break;
	}
	if (group[otherRole] === null && warnings.length === 0) {
		warnings.push(`No matching ${otherRole} file for "${slug}" in the same folder — imported the ${role} side only.`);
	}
	return { recordings: [buildMdRecording(dir + slug, group.transcript, group.summary)], warnings };
}

export class NoteWriter {
	constructor(private vault: Vault) {}

	/** Create each missing segment of `folderPath` (already sanitized). */
	private async ensureFolder(folderPath: string): Promise<void> {
		if (folderPath === "") return;
		let current = "";
		for (const segment of folderPath.split("/")) {
			current = current === "" ? segment : `${current}/${segment}`;
			if (this.vault.getAbstractFileByPath(current)) continue;
			try {
				await this.vault.createFolder(current);
			} catch (error) {
				// Racing with the indexer is fine; anything else must surface.
				if (!errorMessage(error).toLowerCase().includes("already exists")) throw error;
			}
		}
	}

	private targetPath(folder: string, rec: HpRecording, template: string): string {
		const base = renderFilenameTemplate(template, templateVarsFrom(rec));
		return normalizePath(folder === "" ? `${base}.md` : `${folder}/${base}.md`);
	}

	private freeVariant(desired: string): string {
		const match = /^(.*)\.md$/.exec(desired);
		const stem = match ? match[1] : desired;
		for (let n = 1; n <= 999; n++) {
			const candidate = normalizePath(`${stem} (${n}).md`);
			if (!this.vault.getAbstractFileByPath(candidate)) return candidate;
		}
		return normalizePath(`${stem} (imported-${Date.now()}).md`);
	}

	/** True when the frontmatter carries a quoted `id:` key — only we write those. */
	private async isPluginNote(file: TFile): Promise<boolean> {
		let head: string;
		try {
			head = (await this.vault.read(file)).slice(0, 4000);
		} catch {
			return false;
		}
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(head);
		return frontmatter !== null && /^id:[ \t]*"[^"]*"/m.test(frontmatter[1]);
	}

	async importRecordings(recordings: HpRecording[], options: ImportOptions): Promise<ImportReport> {
		const report: ImportReport = { created: 0, updated: 0, skipped: 0, renamed: 0, failed: 0, errors: [] };
		const folder = sanitizeFolderPath(options.folder);
		try {
			await this.ensureFolder(folder);
		} catch (error) {
			throw new Error(`Cannot create target folder "${folder || "vault root"}": ${errorMessage(error)}`);
		}

		for (let i = 0; i < recordings.length; i++) {
			const rec = recordings[i];
			try {
				const markdown = convertRecordingToMarkdown(rec, {
					extraTags: options.extraTags,
					includeTranscript: options.includeTranscript,
				});
				let path = this.targetPath(folder, rec, options.filenameTemplate);
				const existing = path === "" ? null : this.vault.getAbstractFileByPath(path);

				if (existing instanceof TFile) {
					if (options.policy === "skip") {
						report.skipped++;
						continue;
					}
					if (options.policy === "overwrite" && (await this.isPluginNote(existing))) {
						await this.vault.modify(existing, markdown);
						report.updated++;
						continue;
					}
					path = this.freeVariant(path); // rename policy
					await this.vault.create(path, markdown);
					report.renamed++;
				} else {
					if (existing) path = this.freeVariant(path); // a folder blocks the name
					await this.vault.create(path, markdown);
					report.created++;
				}
			} catch (error) {
				report.failed++;
				const message = errorMessage(error);
				report.errors.push(`${rec.title}: ${message}`);
				console.error(`[heypocket-importer] failed to write "${rec.title}":`, error);
			} finally {
				options.onProgress?.(i + 1, recordings.length);
			}
		}
		return report;
	}
}

export function formatImportReport(report: ImportReport): string {
	const parts: string[] = [];
	if (report.created) parts.push(`${report.created} created`);
	if (report.updated) parts.push(`${report.updated} updated`);
	if (report.renamed) parts.push(`${report.renamed} renamed`);
	if (report.skipped) parts.push(`${report.skipped} skipped`);
	if (report.failed) parts.push(`${report.failed} failed`);
	return parts.length > 0 ? parts.join(", ") : "nothing to import";
}
