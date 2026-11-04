/*
 * HeyPocket (Pocket AI) public API client built on Obsidian's `requestUrl`
 * so it works from the app sandbox (CORS-safe on desktop and mobile).
 *
 * Reference: https://docs.heypocketai.com/docs/api
 *   Base URL   https://public.heypocketai.com/api/v1
 *   Auth       `Authorization: Bearer pk_...`
 *   Envelope   { success, data, error?, error_code?, pagination? }
 *   Endpoints  GET /public/recordings (paginated via page/limit/has_more)
 *              GET /public/recordings/:id?include_transcript&include_summarizations
 *              GET /public/tags
 */

import { requestUrl, type RequestUrlResponse } from "obsidian";
import { HpRecording, isRecord, normalizeRecording } from "../models/heypocket";

export const DEFAULT_API_BASE_URL = "https://public.heypocketai.com/api/v1";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export class HeyPocketApiError extends Error {
	status?: number;
	code?: string;

	constructor(message: string, status?: number, code?: string) {
		super(message);
		this.name = "HeyPocketApiError";
		this.status = status;
		this.code = code;
	}
}

export interface SyncOptions {
	/** YYYY-MM-DD UTC lower bound. */
	startDate?: string;
	/** YYYY-MM-DD UTC upper bound. */
	endDate?: string;
	/** Comma-separated tag ids. */
	tagIds?: string;
	/** Hard cap on recordings fetched per sync. */
	maxItems: number;
	/** Fetch each recording's transcript + summarizations after listing. */
	includeTranscript: boolean;
	onProgress?: (done: number, total: number | null) => void;
}

export interface SyncResult {
	recordings: HpRecording[];
	warnings: string[];
}

interface Pagination {
	page: number;
	totalPages: number;
	total: number | null;
	hasMore: boolean;
}

export function normalizeBaseUrl(raw: string): string {
	const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
	if (trimmed === "") return DEFAULT_API_BASE_URL;
	if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) {
		throw new HeyPocketApiError(`Invalid API base URL: "${trimmed}" (must start with http:// or https://)`);
	}
	return trimmed;
}

export class HeyPocketApiClient {
	constructor(private apiKey: string, baseUrl: string) {
		this.baseUrl = normalizeBaseUrl(baseUrl);
	}

	private readonly baseUrl: string;

	private buildUrl(path: string, query: Record<string, string | number | undefined>): string {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== "") params.set(key, String(value));
		}
		const qs = params.toString();
		return `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
	}

	private async request(
		path: string,
		query: Record<string, string | number | undefined> = {}
	): Promise<{ data: unknown; pagination?: Pagination }> {
		if (this.apiKey.trim() === "") {
			throw new HeyPocketApiError("No HeyPocket API key configured. Add it in Settings \u2192 HeyPocket Importer.");
		}
		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
				url: this.buildUrl(path, query),
				method: "GET",
				// Without this, requestUrl rejects on any 4xx/5xx and the
				// status-specific diagnostics below never run.
				throw: false,
				headers: {
					Authorization: `Bearer ${this.apiKey.trim()}`,
					Accept: "application/json",
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new HeyPocketApiError(`Could not reach the HeyPocket API (${message}). Check the network and base URL.`);
		}

		if (response.status === 401 || response.status === 403) {
			throw new HeyPocketApiError(
				"HeyPocket API rejected the key (HTTP " + response.status + "). Verify the `pk_...` token in Settings.",
				response.status
			);
		}
		if (response.status === 429) {
			throw new HeyPocketApiError("HeyPocket API rate limit reached (HTTP 429). Wait a minute and sync again.", 429);
		}
		if (response.status >= 400) {
			const snippet = String(response.text ?? "").slice(0, 200);
			throw new HeyPocketApiError(`HeyPocket API error (HTTP ${response.status}). ${snippet}`, response.status);
		}

		let body: unknown;
		try {
			body = JSON.parse(response.text);
		} catch {
			throw new HeyPocketApiError("HeyPocket API returned non-JSON data.", response.status);
		}
		if (!isRecord(body)) {
			throw new HeyPocketApiError("Unexpected HeyPocket API response shape.", response.status);
		}
		if (body.success === false) {
			const code = typeof body.error_code === "string" ? body.error_code : undefined;
			const message = typeof body.error === "string" && body.error !== "" ? body.error : "Unknown API error";
			throw new HeyPocketApiError(`HeyPocket API error: ${message}`, response.status, code);
		}

		const data = body.data !== undefined ? body.data : body;
		let pagination: Pagination | undefined;
		if (isRecord(body.pagination)) {
			const p = body.pagination;
			pagination = {
				page: typeof p.page === "number" ? p.page : 0,
				totalPages: typeof p.total_pages === "number" ? p.total_pages : 0,
				total: typeof p.total === "number" ? p.total : null,
				hasMore: p.has_more === true,
			};
		}
		return { data, pagination };
	}

	/** Raw `GET /public/tags` payload (id discovery for the tag filter). */
	async getTags(): Promise<unknown> {
		const { data } = await this.request("/public/tags");
		return data;
	}

	/** Validate credentials with a cheap request. Returns the tag count. */
	async testConnection(): Promise<number> {
		const tags = await this.listTags();
		return tags.length;
	}

	async listTags(): Promise<string[]> {
		const data = await this.getTags();
		const items = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.tags) ? data.tags : [];
		const names: string[] = [];
		for (const item of items) {
			if (typeof item === "string") names.push(item);
			else if (isRecord(item) && typeof item.name === "string") names.push(item.name);
		}
		return names;
	}

	/** Fetch one recording with transcript and summarizations. */
	async getRecording(recordingId: string, includeTranscript = true): Promise<HpRecording> {
		const id = recordingId.trim();
		if (id === "" || id.includes("/") || id.includes("..")) {
			throw new HeyPocketApiError(`Invalid recording id: "${recordingId}"`);
		}
		const { data } = await this.request(`/public/recordings/${encodeURIComponent(id)}`, {
			include_transcript: includeTranscript ? "true" : "false",
			include_summarizations: "true",
		});
		return normalizeRecording(data, "api");
	}

	/** Page through `/public/recordings`, optionally enriching each item. */
	async syncRecordings(options: SyncOptions): Promise<SyncResult> {
		const warnings: string[] = [];
		const maxItems = Math.max(1, Math.floor(isFinite(options.maxItems) ? options.maxItems : 100));
		const recordings: HpRecording[] = [];

		let page = 1;
		let hasMore = true;
		let total: number | null = null;

		while (hasMore && recordings.length < maxItems && page <= MAX_PAGES) {
			const { data, pagination } = await this.request("/public/recordings", {
				page,
				limit: PAGE_SIZE,
				start_date: options.startDate,
				end_date: options.endDate,
				tag_ids: options.tagIds,
			});
			const items = Array.isArray(data)
				? data
				: isRecord(data) && Array.isArray(data.recordings)
					? data.recordings
					: isRecord(data) && Array.isArray(data.items)
						? data.items
						: [data];
			for (const item of items) {
				if (recordings.length >= maxItems) break;
				try {
					recordings.push(normalizeRecording(item, "api"));
				} catch (error) {
					warnings.push(`Skipped a listing entry: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (pagination) {
				if (pagination.page >= page) page = pagination.page + 1;
				else page += 1;
				hasMore = pagination.hasMore;
			} else {
				hasMore = false; // un-paginated payload
			}
			if (total === null && pagination && pagination.total !== null) {
				total = pagination.total;
			}
			options.onProgress?.(recordings.length, total);
		}

		if (options.includeTranscript) {
			for (let i = 0; i < recordings.length; i++) {
				const rec = recordings[i];
				if (!rec.id || rec.segments.length > 0) continue;
				try {
					recordings[i] = await this.getRecording(rec.id, true);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					warnings.push(`No transcript for ${rec.id}: ${message}`);
				}
				options.onProgress?.(i + 1, recordings.length);
			}
		}

		return { recordings, warnings };
	}
}
