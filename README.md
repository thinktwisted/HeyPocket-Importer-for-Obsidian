# HeyPocket Importer for Obsidian

Import [HeyPocket (Pocket AI)](https://heypocket.com) recordings into your Obsidian vault as Markdown notes — via the official public API, a JSON export, the webapp's paired Markdown (`.md`) exports, or a ZIP archive of either.

Each note gets:

- YAML frontmatter: `id`, `title`, `date`, `language`, `tags`
- An **AI Summary** callout (`> [!summary]`)
- **Key Takeaways** bullets
- **Action Items** as task checkboxes (`- [ ]` / `- [x]`, with due date / assignee when present)
- A **timestamped transcript** (`0:05:12`-style offsets, speaker-labeled when available)

## Install

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Put them in `<vault>/.obsidian/plugins/obsidian-heypocket-importer/`.
3. Enable **HeyPocket Importer** in Settings → Community plugins → Installed plugins.

## Build from source

```bash
npm install
npm run build   # typecheck + production bundle → main.js
npm run dev     # watch-mode rebuild
```

## Usage

### Sync from the HeyPocket API

1. Get an API key from Pocket: **Settings → Developer → API Keys** (starts with `pk_`).
2. Paste it in **Settings → HeyPocket Importer → API key**, press **Test**.
3. Run the command palette entry **HeyPocket: Sync recordings from HeyPocket API** (or click the ribbon mic icon).

The sync pages through `GET /public/recordings` (date and tag-id filters supported in settings), then enriches each recording via `GET /public/recordings/:id?include_transcript=true&include_summarizations=true`. **Import one recording by HeyPocket id** fetches a single recording.

Base URL defaults to `https://public.heypocketai.com/api/v1`.

### Import JSON / Markdown / ZIP files

- Export recordings from HeyPocket as JSON (single object, array, or `{success, data|recordings: [...]}` envelope), as the webapp's Markdown export, or as a ZIP archive of JSON and/or Markdown files.
- The webapp exports each recording as two Markdown files sharing a filename slug — `<slug>-transcription.md` and `<slug>-summary.md`. Put both in the same vault folder; importing either one automatically finds and merges its sibling into a single note. A ZIP of the full export (either or both halves, any folder layout) works via the ZIP import.
- Speaker blocks (`**SPEAKER_00:**`) become transcript lines with normalized names (`Speaker 1`, …); webapp Markdown has no timestamps, so those transcripts are written without offsets. `### Interview Highlights` bullets become Key Takeaways, and `- [ ]` checkboxes become Action Items — `**Assignee:**` / `**Due:**` lines are parsed onto the checkbox that follows them.
- Importing just one half of a pair still works; the note gets whatever was present. Files that don't look like a HeyPocket export (e.g. a ZIP's `README.md`) are ignored with a warning.
- Place the file anywhere in your vault, then either:
  - right-click it → **Import with HeyPocket Importer**, or
  - run **HeyPocket: Import a HeyPocket JSON or Markdown file from the vault** (or the ZIP command) and pick the file.

## Settings

| Setting | Purpose |
| --- | --- |
| API key | Bearer token for the public API (desktop + mobile via `requestUrl`) |
| Target folder | Vault-relative destination; sanitized (`..`, illegal chars stripped) |
| Filename template | Tokens `{{title}} {{date}} {{year}} {{month}} {{day}} {{id}}`; missing tokens render empty (dateless exports keep a stable name); rendered name is sanitized |
| Auto-tags | Extra comma-separated tags merged into every note's `tags` |
| Overwrite policy | `skip` / `overwrite` / `rename` when the target note exists. `overwrite` only replaces notes this plugin wrote (frontmatter `id:`); foreign notes are never clobbered — a numbered copy is saved instead |
| Max recordings per sync | Cap for one API run (1–1000) |
| Include transcript | Toggle the Transcript section off for summary-only notes |
| Start/End date, Tag IDs | Filters for the listing endpoint |

## Security notes

- All file paths are sanitized: invalid characters removed, traversal (`..`) and absolute paths flattened, so crafted exports cannot crash the vault or write outside the target folder.
- The `overwrite` policy checks the existing file's frontmatter and refuses to replace notes it did not create (its own notes carry a quoted `id:` key).
- Embeds (`![[…]]`) and remote images from imported JSON/ZIP/Markdown files are stripped from note bodies — a crafted export cannot pull vault content or phone home when you read the note. Content synced from your own HeyPocket API account is written as-is.
- Only files that look like HeyPocket exports import: Markdown needs speaker blocks, action-item checkboxes, or export section headings — random notes are rejected with an error, not imported.
- ZIP archives are vetted from their central directory *before* decompression: ≤500 importable entries and ≤64 MB declared expanded size; archives whose structure cannot be verified (including exotic zip64 layouts) are declined instead of inflated.
- API keys are stored in the vault's `plugins/data.json` (plain text, like most Obsidian plugins). Don't commit that file. The plugin warns if you point the base URL at non-HTTPS.

## License

MIT
