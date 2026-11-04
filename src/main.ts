/*
 * HeyPocket Importer — plugin entry point.
 *
 * Wires together: settings + settings tab, API sync (requestUrl based),
 * manual JSON / Markdown / ZIP imports (vault file picker command, palette
 * command, right-click menu), and Markdown writing via NoteWriter.
 */

import {
	App,
	FuzzySuggestModal,
	Menu,
	Modal,
	Notice,
	Plugin,
	Setting,
	TAbstractFile,
	TextComponent,
	TFile,
} from "obsidian";
import { DEFAULT_SETTINGS, HeyPocketSettings, HeyPocketSettingTab, normalizeSettings, parseAutoTags } from "./settings";
import { HeyPocketApiClient, HeyPocketApiError } from "./services/api";
import { ImportReport, NoteWriter, formatImportReport, readAndParseFile } from "./services/fileImporter";
import { HpRecording } from "./models/heypocket";

const IMPORT_EXTENSIONS = ["json", "zip", "md", "markdown"];

class HeyPocketFileSuggester extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPicked: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Type to filter vault .json / .zip files…");
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter(
				(file) =>
					IMPORT_EXTENSIONS.includes(file.extension.toLowerCase()) &&
					!file.name.startsWith(".") &&
					!file.path.includes("/.")
			);
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPicked(file);
	}
}

class RecordingIdModal extends Modal {

	constructor(app: App, private onSubmit: (id: string) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Import one HeyPocket recording" });
		contentEl.createEl("p", { text: "Paste a recording id (as shown by the API or in the HeyPocket export).", cls: "heypocket-modal-hint" });

		let input: TextComponent | null = null;
		const submit = (): void => {
			const value = (input?.getValue() ?? "").trim();
			if (value === "") return;
			this.close();
			this.onSubmit(value);
		};

		new Setting(contentEl).setName("Recording id").addText((text) => {
			input = text;
			text.setPlaceholder("rec_…").inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
				if (event.key === "Enter") submit();
			});
			text.inputEl.focus();
		});
		new Setting(contentEl).addButton((button) => button.setButtonText("Import").setCta().onClick(submit));
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export default class HeyPocketImporterPlugin extends Plugin {
	settings: HeyPocketSettings = { ...DEFAULT_SETTINGS };
	private writer!: NoteWriter;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.writer = new NoteWriter(this.app.vault);

		this.addSettingTab(new HeyPocketSettingTab(this.app, this));

		this.addRibbonIcon("mic", "Sync from HeyPocket API", () => void this.syncFromApi());

		this.addCommand({
			id: "heypocket-sync-from-api",
			name: "Sync recordings from HeyPocket API",
			icon: "refresh-cw",
			callback: () => void this.syncFromApi(),
		});
		this.addCommand({
			id: "heypocket-sync-recording-by-id",
			name: "Import one recording by HeyPocket id",
			callback: () => {
				const modal = new RecordingIdModal(this.app, (id) => void this.syncSingleRecording(id));
				modal.open();
			},
		});
		this.addCommand({
			id: "heypocket-import-json-file",
			name: "Import a HeyPocket JSON or Markdown file from the vault",
			callback: () => {
				new HeyPocketFileSuggester(this.app, (file) => void this.importVaultFile(file)).open();
			},
		});
		this.addCommand({
			id: "heypocket-import-zip-file",
			name: "Import a HeyPocket ZIP export (JSON or Markdown files)",
			callback: () => {
				new HeyPocketFileSuggester(this.app, (file) => void this.importVaultFile(file)).open();
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				if (file instanceof TFile && IMPORT_EXTENSIONS.includes(file.extension.toLowerCase())) {
					menu.addItem((item) =>
						item
							.setTitle("Import with HeyPocket Importer")
							.setIcon("mic")
							.onClick(async () => {
								await this.importVaultFile(file);
							})
					);
				}
			})
		);
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		// Accept both { settings: {...} } and an older flat shape.
		this.settings = normalizeSettings(data && typeof data === "object" ? (data.settings ?? data) : null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ settings: this.settings });
	}

	private buildClient(): HeyPocketApiClient {
		return new HeyPocketApiClient(this.settings.apiKey, this.settings.baseUrl);
	}

	private async importRecordings(recordings: HpRecording[]): Promise<ImportReport> {
		const report = await this.writer.importRecordings(recordings, {
			folder: this.settings.targetFolder,
			filenameTemplate: this.settings.filenameTemplate,
			extraTags: parseAutoTags(this.settings.autoTags),
			policy: this.settings.overwritePolicy,
			includeTranscript: this.settings.includeTranscript,
		});
		if (report.failed > 0) {
			console.error("[heypocket-importer] import errors:", report.errors);
			new Notice(`HeyPocket Importer: ${report.failed} note(s) failed — see developer console for details.`, 10000);
		}
		return report;
	}

	async syncFromApi(): Promise<void> {
		if (this.settings.apiKey === "") {
			new Notice("HeyPocket Importer: set your API key in Settings first.", 8000);
			return;
		}
		const notice = new Notice("HeyPocket: contacting API…", 0);
		try {
			const client = this.buildClient();
			const { recordings, warnings } = await client.syncRecordings({
				maxItems: this.settings.maxItemsPerSync,
				startDate: this.settings.startDate || undefined,
				endDate: this.settings.endDate || undefined,
				tagIds: this.settings.tagIds || undefined,
				includeTranscript: this.settings.includeTranscript,
				onProgress: (done, total) => {
					notice.setMessage(`HeyPocket: fetched ${done}${total !== null ? `/${total}` : ""} recordings…`);
				},
			});
			if (warnings.length > 0) console.warn("[heypocket-importer] sync warnings:", warnings);
			if (recordings.length === 0) {
				notice.setMessage("HeyPocket: no recordings matched the current filters.");
			} else {
				notice.setMessage(`HeyPocket: writing ${recordings.length} notes…`);
				const report = await this.importRecordings(recordings);
				notice.setMessage(
					`HeyPocket sync complete — ${formatImportReport(report)}${warnings.length ? ` (${warnings.length} warning(s), see console)` : ""}.`
				);
			}
		} catch (error) {
			notice.setMessage(this.describeError(error));
		} finally {
			window.setTimeout(() => notice.hide(), 10000);
		}
	}


	async syncSingleRecording(id: string): Promise<void> {
		if (this.settings.apiKey === "") {
			new Notice("HeyPocket Importer: set your API key in Settings first.", 8000);
			return;
		}
		const notice = new Notice(`HeyPocket: fetching recording ${id}…`, 0);
		try {
			const rec = await this.buildClient().getRecording(id, this.settings.includeTranscript);
			await this.importRecordings([rec]);
			notice.setMessage(`HeyPocket: imported "${rec.title}".`);
		} catch (error) {
			notice.setMessage(this.describeError(error));
		} finally {
			window.setTimeout(() => notice.hide(), 10000);
		}
	}

	async importVaultFile(file: TFile): Promise<void> {
		const notice = new Notice(`HeyPocket: reading "${file.path}"…`, 0);
		try {
			const parsed = await readAndParseFile(this.app.vault, file);
			if (parsed.warnings.length > 0) console.warn("[heypocket-importer] import warnings:", parsed.warnings);
			await this.importRecordings(parsed.recordings);
			notice.setMessage(
				`HeyPocket: imported ${parsed.recordings.length} recording(s) from ${file.name}${parsed.warnings.length ? ` — ${parsed.warnings.length} warning(s), see console` : ""}.`
			);
		} catch (error) {
			notice.setMessage(this.describeError(error));
		} finally {
			window.setTimeout(() => notice.hide(), 10000);
		}
	}

	async testConnection(): Promise<void> {
		const notice = new Notice("HeyPocket: testing API key…", 0);
		try {
			const tagCount = await this.buildClient().testConnection();
			notice.setMessage(`HeyPocket: API key works. ${tagCount} tag(s) visible.`);
		} catch (error) {
			notice.setMessage(this.describeError(error));
		} finally {
			window.setTimeout(() => notice.hide(), 10000);
		}
	}

	async fetchTagIdsToConsole(): Promise<void> {
		const notice = new Notice("HeyPocket: fetching tags…", 0);
		try {
			const tags = await this.buildClient().getTags();
			console.log("[heypocket-importer] HeyPocket tags:", tags);
			notice.setMessage("HeyPocket: tags logged to the developer console (Ctrl/Cmd+Shift+I).");
		} catch (error) {
			notice.setMessage(this.describeError(error));
		} finally {
			window.setTimeout(() => notice.hide(), 10000);
		}
	}

	private describeError(error: unknown): string {
		if (error instanceof HeyPocketApiError) return `HeyPocket: ${error.message}`;
		if (error instanceof Error) return `HeyPocket: ${error.message}`;
		return `HeyPocket: unexpected error ${String(error)}`;
	}
}

