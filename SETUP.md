# Setup Guide

## 1. Google Cloud Project + Service Account

1. Go to https://console.cloud.google.com and create a new project (or use an existing one).
2. Enable these two APIs:
   - **Google Drive API** → search "Drive API" in the API Library → Enable
   - **Google Sheets API** → search "Sheets API" in the API Library → Enable
3. Go to **IAM & Admin → Service Accounts** → Create Service Account
   - Name: `screenshot-dashboard`
   - Click **Create and Continue** → skip role assignment → **Done**
4. Click the service account → **Keys** tab → **Add Key → Create new key → JSON**
   - This downloads a `.json` file — keep it safe, you need it next.

---

## 2. Google Drive Folder

1. Go to Google Drive and create a new folder (e.g. "Ad Screenshots").
2. Right-click the folder → **Share** → paste the **service account email** (looks like `screenshot-dashboard@your-project.iam.gserviceaccount.com`) → give it **Editor** access.
3. Open the folder in your browser. The URL looks like:
   `https://drive.google.com/drive/folders/1AbCdEf...`
   Copy the ID at the end (after `/folders/`).

---

## 3. Google Sheet

1. Create a new Google Sheet.
2. In Row 1, add these headers: `Date | Brand | Shared By | Drive Link`
3. Share the sheet with the service account email (Editor access).
4. The sheet URL looks like:
   `https://docs.google.com/spreadsheets/d/1AbCdEf.../edit`
   Copy the ID between `/d/` and `/edit`.

---

## 4. Anthropic API Key

1. Go to https://console.anthropic.com → API Keys → Create Key.

---

## 5. Environment Variables

1. Copy `.env.local.example` to `.env.local`:
   ```bash
   cp .env.local.example .env.local
   ```
2. Open `.env.local` and fill in:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` → paste the **entire JSON content** of the key file as one line (remove newlines)
   - `GOOGLE_DRIVE_FOLDER_ID` → the folder ID from step 2
   - `GOOGLE_SHEET_ID` → the sheet ID from step 3
   - `ANTHROPIC_API_KEY` → your API key from step 4

### Tip: convert the JSON key file to one line
```bash
cat your-key-file.json | tr -d '\n'
```
Paste that output as the value of `GOOGLE_SERVICE_ACCOUNT_JSON`.

---

## 6. Run the App

```bash
npm run dev
```

Open http://localhost:3000 — you're good to go.

---

## Deploy to Vercel (optional)

```bash
npx vercel
```
Add all four env vars in the Vercel dashboard under Project → Settings → Environment Variables.
