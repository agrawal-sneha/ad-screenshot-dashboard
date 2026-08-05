# Setup Guide

The app runs fully locally with **no API keys**: brand detection uses the GitHub
Copilot SDK (your existing Copilot subscription), screenshots are saved to
`public/uploads/`, and rows are stored in `.demo-data/rows.json`.

## Quick start (local, no keys)

```bash
npm install
copilot            # sign in once with /login, then exit
npm run dev
```

Open http://localhost:3000.

To verify everything works:

```bash
npm run typecheck
npm test           # offline: image handling + store, no model calls
npm run test:live  # also calls the real Copilot model
npm run test:api   # end-to-end, needs `npm run dev` running
```

---

## Brand detection (Copilot SDK)

`lib/copilot.ts` drives brand detection through `@github/copilot-sdk`:

- Picks a **vision-capable** model, preferring `claude-haiku-4.5`. Override with
  `COPILOT_MODEL`; a non-vision model fails fast and lists valid options.
- Starts **one shared CLI runtime** per server process and creates a **fresh
  session per image**. Reusing a session made the second image take 38s instead
  of 6s and risks answers bleeding across screenshots.
- Re-encodes every image with `sharp` to stay under the model's ~3MB inline-image
  limit. An oversized attachment otherwise hangs until the timeout rather than
  erroring, and normalizing to PNG/JPEG also avoids per-model GIF/WEBP gaps.
- Sanitizes the reply: anything that isn't a short brand-like answer becomes
  `Unknown`, so a conversational response never lands in the sheet.

---

## Optional integrations

Everything below is optional — skip it for local use.

### Google Sheets (instead of the local JSON store)

1. Create a Google Cloud project and enable the **Google Sheets API**.
2. **IAM & Admin → Service Accounts** → create one → **Keys → Add Key → JSON**.
3. Create a Sheet with headers `Date | Brand | Shared By | Drive Link` and share
   it with the service account email as **Editor**.
4. Set `GOOGLE_SERVICE_ACCOUNT_JSON` (the whole key file on one line) and
   `GOOGLE_SHEET_ID` (the ID between `/d/` and `/edit`).

Without `GOOGLE_SERVICE_ACCOUNT_JSON`, rows go to `.demo-data/rows.json`.

### imgbb (instead of local image storage)

Set `IMGBB_API_KEY` to host uploads on imgbb. Without it, images are written to
`public/uploads/` and served at `/uploads/...`.

### Gemini (instead of Copilot)

Set `USE_GEMINI=1` and `GEMINI_API_KEY`. See `.env.local.example` for the
free-tier pacing and retry options.

---

## Environment variables

Copy the example file and edit as needed — all values are optional for local use:

```bash
cp .env.local.example .env.local
```

| Variable | Purpose |
| --- | --- |
| `COPILOT_MODEL` | Force a Copilot vision model (default `claude-haiku-4.5`) |
| `COPILOT_TIMEOUT_MS` | Per-image timeout (default 90000) |
| `UPLOAD_CONCURRENCY` | Images processed in parallel (default 4) |
| `UPLOAD_MAX_FILES` | Max images per upload (default 50) |
| `USE_GEMINI` | Use Gemini instead of Copilot |
| `DEMO_MODE` | Derive the brand from the filename, no model call |
| `GEMINI_API_KEY` | Required only when `USE_GEMINI` is set |
| `IMGBB_API_KEY` | Host images on imgbb instead of locally |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Enables the Google Sheets backend |
| `GOOGLE_SHEET_ID` | Target spreadsheet ID |

Boolean flags accept `1`/`true`/`yes`/`on`; `false`, `0`, `no` and `off` all
disable them.

---

## Notes

`@github/copilot-sdk` and `sharp` load native binaries at runtime and are listed
in `serverExternalPackages` in `next.config.mjs`. Removing them from that list
breaks brand detection with *"Could not find a @github/copilot platform
package"*.
