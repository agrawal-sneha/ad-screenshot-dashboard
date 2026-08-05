# Ad Screenshot Dashboard

Upload ad screenshots, get the brand detected automatically, and keep a running
log of who shared what.

Brand detection runs on the **GitHub Copilot SDK**, so it uses the Copilot
subscription already on the machine — there is no API key to manage.

---

## Prerequisites

| | |
| --- | --- |
| Node.js | `^20.19.0` or `>=22.12.0` (required by the Copilot SDK) |
| GitHub Copilot CLI | installed and signed in |
| Copilot subscription | any plan with vision-capable models |

Only the machine **running the server** needs these. People opening the
dashboard in a browser need nothing.

---

## Run it

```bash
npm install

# one-time: sign in to Copilot, then exit
copilot          # then /login

npm run dev
```

Open http://localhost:3000.

That's the whole setup. With no other configuration:

- brands are detected via Copilot,
- images are saved to `public/uploads/` and served at `/uploads/...`,
- rows are stored in `.demo-data/rows.json`.

Both of those paths are gitignored. See [SETUP.md](./SETUP.md) to switch to
Google Sheets, imgbb, or Gemini instead.

### Sharing with the team

`npm run dev` also binds to your LAN address (Next prints it as `Network:`), so
teammates on the same network can use the dashboard immediately.

Two things to know:

- The host machine must stay awake and signed in.
- **Every detection runs on the host's Copilot account.** The "Shared by"
  dropdown is only a label written to the log — it is not a login.

For a longer-lived setup use `npm run build && npm start`. This app cannot be
deployed to serverless platforms such as Vercel: it spawns a ~145MB Copilot CLI
binary and depends on an interactive login.

---

## How brand detection works

```
browser  ──POST /api/upload──▶  app/api/upload/route.ts
                                      │
                                      ▼
                              lib/copilot.ts
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
     sharp: re-encode        CopilotClient             fresh session
     ≤1024px / <3MB          (spawns copilot.exe,      per image
     → temp file             JSON-RPC over stdio)
                                      │
                                      ▼
                        sendAndWait({ prompt, attachments })
                                      │
                                      ▼
                          cleanBrand(...) → "Nike"
```

Notable details, each of which exists because of a measured failure:

- **One shared CLI runtime per server process**, cached on `globalThis` so dev
  hot-reload doesn't leak processes. Startup is ~900ms and is amortised.
- **A fresh session per image.** Reusing a session made the second image take
  38.8s instead of 6.8s, and risks answers bleeding between screenshots.
- **Every image is re-encoded with `sharp`.** Vision models cap inline images at
  ~3MB, and an oversized attachment *hangs* until the timeout instead of
  erroring. Normalising to PNG/JPEG also avoids per-model format gaps
  (`claude-haiku-4.5` doesn't declare GIF support).
- **Images are passed by file path**, not bytes, so each one is written to a
  temp file and deleted afterwards.
- **Replies are sanitised.** A model that answers conversationally instead of
  naming a brand collapses to `Unknown` rather than writing a sentence to the log.

Model selection prefers `claude-haiku-4.5` and falls back to any vision-capable
model. Override with `COPILOT_MODEL`; a non-vision model fails fast and lists
the valid options.

---

## Tests

```bash
npm run typecheck
npm test           # offline: sanitisation, image handling, local store
npm run test:live  # adds real Copilot model calls
npm run test:api   # end-to-end HTTP; needs `npm run dev` running
```

96 assertions, no test framework — Node strips TypeScript types natively.

Accuracy on the current model: **8/8**, including real-world Apple and Lenovo
ads across webp, 1920x1080 jpg, and a 250x397 newspaper scan. Eight images in
parallel complete in ~13s.

---

## Troubleshooting

**`Could not find a @github/copilot platform package`**

`@github/copilot-sdk` and `sharp` resolve native binaries at runtime and must
stay in `serverExternalPackages` in `next.config.mjs`. Bundling them breaks the
lookup. This fails only inside Next — the SDK works fine under plain `node`.

**`No vision-capable model is available on this Copilot account`**

The Copilot CLI isn't signed in, or the account has no vision models. Run
`copilot`, then `/login`.

**Uploads succeed but every brand is `Unknown`**

Usually the image never reached the model. Check the server log for
`not a readable image`, and confirm the file is a real image rather than a
renamed file.

**Detection is slow (>30s per image)**

Large screenshots cost more vision tokens. Images are already clamped to 1024px
on the long edge; lower `COPILOT_TIMEOUT_MS` to fail faster, or set
`UPLOAD_CONCURRENCY` higher to process more in parallel.

---

## Configuration

Everything is optional for local use. Copy `.env.local.example` to `.env.local`
and see [SETUP.md](./SETUP.md) for the full table, including the Google Sheets,
imgbb, and Gemini integrations.

Boolean flags accept `1`/`true`/`yes`/`on`; `false`, `0`, `no`, and `off` all
disable them.
