/*
 * Plugin settings + Obsidian Settings tab.
 *
 * Every user-supplied path/name value is sanitized before it is saved, so
 * the rest of the codebase can assume `targetFolder` and the rendered
 * filename are always valid, vault-relative, traversal-free paths.
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { sanitizeFolderPath, sanitizeTag } from "./models/heypocket";
import { DEFAULT_API_BASE_URL } from "./services/api";
import type { OverwritePolicy } from "./services/fileImporter";
import type HeyPocketImporterPlugin from "./main";

export type { OverwritePolicy };

export interface HeyPocketSettings {
	/** `pk_...` token from Pocket Settings → Developer → API Keys. */
	apiKey: string;
	baseUrl: string;
	/** Vault-relative destination folder; "" = vault root. */
	targetFolder: string;
	/** Tokens: {{title}} {{date}} {{year}} {{month}} {{day}} {{id}}. */
	filenameTemplate: string;
	/** Comma-separated tags added to every imported note. */
	autoTags: string;
	overwritePolicy: OverwritePolicy;
	maxItemsPerSync: number;
	includeTranscript: boolean;
	startDate: string;
	endDate: string;
	tagIds: string;
}

export const DEFAULT_SETTINGS: HeyPocketSettings = {
	apiKey: "",
	baseUrl: DEFAULT_API_BASE_URL,
	targetFolder: "HeyPocket",
	filenameTemplate: "{{date}} {{title}}",
	autoTags: "heypocket",
	overwritePolicy: "overwrite",
	maxItemsPerSync: 100,
	includeTranscript: true,
	startDate: "",
	endDate: "",
	tagIds: "",
};

const POLICY_LABELS: Record<OverwritePolicy, string> = {
	skip: "Skip existing files",
	overwrite: "Overwrite existing files",
	rename: "Keep both (add numeric suffix)",
};

export function parseAutoTags(raw: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const part of String(raw ?? "").split(/[,\n]/)) {
		const tag = sanitizeTag(part);
		if (tag && !seen.has(tag.toLowerCase())) {
			seen.add(tag.toLowerCase());
			out.push(tag);
		}
	}
	return out;
}

export function normalizeSettings(loaded: Partial<HeyPocketSettings> | null | undefined): HeyPocketSettings {
	const merged: HeyPocketSettings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
	merged.apiKey = String(merged.apiKey ?? "").trim();
	merged.baseUrl = String(merged.baseUrl ?? "").trim().replace(/\/+$/, "") || DEFAULT_API_BASE_URL;
	merged.targetFolder = sanitizeFolderPath(merged.targetFolder);
	merged.filenameTemplate = String(merged.filenameTemplate ?? "").trim() || DEFAULT_SETTINGS.filenameTemplate;
	merged.autoTags = parseAutoTags(merged.autoTags).join(", ");
	if (merged.overwritePolicy !== "skip" && merged.overwritePolicy !== "overwrite" && merged.overwritePolicy !== "rename") {
		merged.overwritePolicy = DEFAULT_SETTINGS.overwritePolicy;
	}
	if (!isFinite(merged.maxItemsPerSync)) merged.maxItemsPerSync = DEFAULT_SETTINGS.maxItemsPerSync;
	merged.maxItemsPerSync = Math.min(1000, Math.max(1, Math.floor(merged.maxItemsPerSync)));
	merged.startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(merged.startDate ?? "").trim()) ? (merged.startDate as string).trim() : "";
	merged.endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(merged.endDate ?? "").trim()) ? (merged.endDate as string).trim() : "";
	merged.tagIds = String(merged.tagIds ?? "").trim();
	return merged;
}

export class HeyPocketSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: HeyPocketImporterPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("HeyPocket connection").setHeading();

		containerEl.createEl("p", {
			text: "Create an API key in Pocket: Settings → Developer → API Keys (a `pk_...` token). Keys are stored in plain text inside this vault's plugin data.json.",
			cls: "heypocket-setting-desc",
		});

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Used as a Bearer token for the HeyPocket public API.")
			.addText((text) => {
				text.setPlaceholder("pk_…")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			})
			.addButton((button) =>
				button.setButtonText("Test").setCta().onClick(async () => {
					await this.plugin.testConnection();
				})
			);

		new Setting(containerEl)
			.setName("API base URL")
			.setDesc("Only change this for self-hosted or regional deployments.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_API_BASE_URL)
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						const trimmed = value.trim().replace(/\/+$/, "");
						if (trimmed === "" || /^https?:\/\/\S+$/i.test(trimmed)) {
							this.plugin.settings.baseUrl = trimmed || DEFAULT_API_BASE_URL;
							await this.plugin.saveSettings();
							if (/^http:\/\//i.test(this.plugin.settings.baseUrl)) {
								new Notice(
									"HeyPocket Importer: the API base URL is not HTTPS — your API key and recording data will travel unencrypted.",
									10000
								);
							}
						}
					})
			);

		new Setting(containerEl).setName("Import destination").setHeading();
		containerEl.createEl("p", {
			text:
				"Manual import accepts HeyPocket JSON/ZIP exports and the webapp's Markdown export: paired files sharing a filename slug " +
				"(<slug>-transcription.md + <slug>-summary.md). Importing either side of a pair picks up the other automatically; " +
				"a ZIP containing both also works.",
			cls: "heypocket-setting-desc",
		});

		new Setting(containerEl)
			.setName("Target folder")
			.setDesc("Vault-relative folder for imported notes. Paths are sanitized; `..` segments and invalid characters are removed.")
			.addText((text) =>
				text
					.setPlaceholder("HeyPocket")
					.setValue(this.plugin.settings.targetFolder)
					.onChange(async (value) => {
						const clean = sanitizeFolderPath(value);
						if (clean !== value.trim()) {
							new Notice(`HeyPocket Importer: folder sanitized to "${clean || "vault root"}".`, 5000);
						}
						this.plugin.settings.targetFolder = clean;
						await this.plugin.saveSettings();
					})
			);

		const previewEl = containerEl.createDiv({ cls: "heypocket-template-preview" });
		previewEl.setText(`Preview: "${this.plugin.settings.filenameTemplate}" → tokens {{title}}, {{date}}, {{year}}, {{month}}, {{day}}, {{id}} are substituted; e.g. "2026-11-03 Weekly Sync.md".`);

		new Setting(containerEl)
			.setName("Filename template")
			.setDesc("Unknown tokens are dropped; the rendered name is sanitized for Obsidian.")
			.addText((text) =>
				text
					.setPlaceholder("{{date}} {{title}}")
					.setValue(this.plugin.settings.filenameTemplate)
					.onChange(async (value) => {
						this.plugin.settings.filenameTemplate = value.trim() || DEFAULT_SETTINGS.filenameTemplate;
						previewEl.setText(`Preview: "${this.plugin.settings.filenameTemplate}" → e.g. "2026-11-03 Weekly Sync.md".`);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-tags")
			.setDesc("Comma-separated tags added to every imported note alongside the recording's own tags.")
			.addText((text) =>
				text
					.setPlaceholder("heypocket, imported")
					.setValue(this.plugin.settings.autoTags)
					.onChange(async (value) => {
						this.plugin.settings.autoTags = parseAutoTags(value).join(", ");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Overwrite policy")
			.setDesc("Behavior when the target note already exists.")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(POLICY_LABELS)) dropdown.addOption(value, label);
				dropdown.setValue(this.plugin.settings.overwritePolicy).onChange(async (value) => {
					if (value === "skip" || value === "overwrite" || value === "rename") {
						this.plugin.settings.overwritePolicy = value;
						await this.plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Include transcript")
			.setDesc("Write the timestamped transcript section into notes. Disable for summary-only imports.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includeTranscript).onChange(async (value) => {
					this.plugin.settings.includeTranscript = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("API sync").setHeading();

		new Setting(containerEl)
			.setName("Maximum recordings per sync")
			.setDesc("Safety cap for one API sync run (1–1000).")
			.addText((text) =>
				text
					.setPlaceholder("100")
					.setValue(String(this.plugin.settings.maxItemsPerSync))
					.onChange(async (value) => {
						const n = Number(value);
						if (isFinite(n) && n >= 1 && n <= 1000) {
							this.plugin.settings.maxItemsPerSync = Math.floor(n);
							await this.plugin.saveSettings();
						}
					})
			);

		const dateHint = "Optional YYYY-MM-DD filter (UTC). Leave empty to disable.";
		new Setting(containerEl)
			.setName("Sync start date")
			.setDesc(dateHint)
			.addText((text) =>
				text
					.setPlaceholder("2026-01-01")
					.setValue(this.plugin.settings.startDate)
					.onChange(async (value) => {
						const v = value.trim();
						if (v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
							this.plugin.settings.startDate = v;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Sync end date")
			.setDesc(dateHint)
			.addText((text) =>
				text
					.setPlaceholder("2026-12-31")
					.setValue(this.plugin.settings.endDate)
					.onChange(async (value) => {
						const v = value.trim();
						if (v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
							this.plugin.settings.endDate = v;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Tag ID filter")
			.setDesc("Comma-separated HeyPocket tag ids limiting the sync (from GET /public/tags).")
			.addText((text) =>
				text
					.setPlaceholder("tag1,tag2")
					.setValue(this.plugin.settings.tagIds)
					.onChange(async (value) => {
						this.plugin.settings.tagIds = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("List available tags")
			.setDesc("Logs this account's tag ids to the console (Ctrl/Cmd+Shift+I → Developer tools).")
			.addButton((button) =>
				button.setButtonText("Fetch tags").onClick(async () => {
					await this.plugin.fetchTagIdsToConsole();
				})
			);
	}
}
