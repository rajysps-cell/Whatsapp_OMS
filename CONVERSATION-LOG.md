# Session Continuation Log — WhatsApp OMS

> Purpose: hand this project (and the state of our Claude Code conversation) to a **fresh Claude Code session on another PC** so work can continue seamlessly. **Read `HANDOFF.md` first** (the canonical project doc), then this file for what happened most recently and what's in progress. Last updated: **2026-07-24**.

## How to resume on the new PC
1. Clone this repo, then follow **`HANDOFF.md` §1** to set it up (install Node ≥22.5, `npm install`, **`npx puppeteer browsers install chrome`** — npm 11 skips it, then start).
2. **Secrets/state are NOT in the repo** (git-ignored) — you must recreate them:
   - `services/whatsapp-ingestion/.env` — recreate from `.env.example`; the important secret is `PRODUCT_IMAP_PASSWORD` (Gmail app password for `ysddiexport@gmail.com`) and `PRODUCT_REPORT_TO=ruturajysps@gmail.com`. Original value lives in the customer-portal `.env` (`DDI_IMAP_PASSWORD`) on the old PC.
   - `services/whatsapp-ingestion/auth/` — the WhatsApp linked-device session. Not transferable via git; you'll re-scan the QR at `/qr` on first run.
   - `services/whatsapp-ingestion/data.sqlite` — learned aliases + captured history. Starts empty; catalog + recent history re-sync on connect. Copy it from the old PC if you want to keep learned aliases.
3. Point Claude Code at **`HANDOFF.md`** + **this file** to restore context. (Auto-memory from `~/.claude/projects/.../memory/` does NOT transfer between PCs — the essentials are folded into HANDOFF.md and below.)

## What this project is (1 line)
A WhatsApp order-capture + product-matching tool for YS Plumbing: one Node/TypeScript service serving 4 web pages on `:3000` (`/` Kanban, `/match` order matching, `/aliases`, `/qr`), capturing group/DM orders and matching them against a 17k-product catalog. Runs against the company's **main** WhatsApp number.

## This session's work (2026-07-22 → 2026-07-24), newest last
All of the below is also captured in `HANDOFF.md` §8 (changelog items 15–20) with more detail.

1. **Fresh-PC setup** — installed Node v24.18.0 (winget), `npm install`, downloaded Chromium (npm 11 gotcha: postinstall skipped → run `npx puppeteer browsers install chrome` manually), scanned a fresh QR (the copied `auth/` was partial → deleted `auth/`+`.wwebjs_cache/`). Fresh start: no old `data.sqlite`, so learned aliases/history did not carry over.
2. **Daily product-catalog auto-import** (`src/product-import.ts`, `src/scheduler.ts`) — fetches the DDI "ZTMPEXP" export email from `ysddiexport@gmail.com` over IMAP (READ-ONLY, Gmail "All Mail", so it never interferes with the customer-portal's own 23:59 import job) and refreshes `products.csv` with a hot-reload. Runs **twice daily at 23:30 & 11:30** (`PRODUCT_IMPORT_TIME`). Emails a run report to **ruturajysps@gmail.com** after every run (via Gmail SMTP / nodemailer). Manual run: `npm run import:products`.
3. **Non-product extraction filter — 3 rounds** (`src/matcher.ts`) — reviewed ~6,300 real messages and hardened `isNonProduct` to drop notes/questions/prose/addresses/names/logistics chatter while **never dropping a line that has a product signal**. Also widened `PRODUCT_TERMS` (supplies: sprinkler, gauge, gloves, silicone, gas, etc.), added foot-mark/`psi` sizes, and fixed a quantity-parse bug (`2' 45`/`3/4 tee` no longer lose their leading size). Guarded by `npm run demo:match` asserts.
4. **Final Order ✕ remove button** (`src/web.ts`) — each Final Order row has a ✕ that un-picks the item (`chosen=null`) → it drops from the order and returns to the Unmatched section.
5. **Always-on service** — the service now runs as a Windows **Task Scheduler** task **`WhatsApp OMS Service`** (SYSTEM, at-startup, keep-alive `run-service.bat`), so it survives reboots/session-ends. **Restart via `Stop-ScheduledTask`/`Start-ScheduledTask`, NOT `npm start`** (the task owns port 3000). Details: `HANDOFF.md` §7.
6. **LAN access** — reachable at `http://192.168.1.40:3000` (static IP). Other devices also need a **Windows Firewall inbound rule for TCP 3000** — a manual admin step the user must run (a security setting):
   `New-NetFirewallRule -DisplayName "WhatsApp OMS 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private -RemoteAddress LocalSubnet`
   **Status: still NOT added as of 2026-07-24** — do this to enable remote-device access.

## ⏳ IN PROGRESS / NEXT UP — add read+send via a new WhatsApp API
The user wants to **read all messages (incl. groups, like today) AND send replies**. Decisions reached:
- ❌ Not `whatsapp-web.js` (user's choice, though it technically can send).
- ❌ Not the official Meta Cloud API — it **cannot read existing customer group chats** (only 1:1 DMs + business-created ≤8-person groups) and forces the number off the normal app.
- ✅ **Recommended: GREEN-API** — a hosted service on the WhatsApp-Web linked-device protocol that reads **all incl. groups** on the existing number, **sends** to individuals+groups, delivers incoming via **polling** (no public URL needed — fits the LAN box), ~**$8/mo** Business (free Developer tier = 3 chats). Bonus: provides names/history/media via API → lets us **remove Puppeteer/Chromium + the two bypasses** and simplify greatly.
- Alternative: **Baileys** (free, self-hosted, no third party holds the session, but a bigger rewrite).

**A full implementation plan was written** (was at `~/.claude/plans/` on the old PC — reproduced here so it transfers):

### Plan summary (GREEN-API integration)
- **Reuse the connector-agnostic core**: `types.ts` (`WaEvent`) + downstream (`chat-store`, `order-store`, `matcher`, `store`, `web`, `product-import`) are unchanged. Only the connector changes.
- **New `green-client.ts`**: poll loop `ReceiveNotification` → map → emit handlers → `DeleteNotification`; plus `sendText(chatId,text)` → GREEN-API `SendMessage`. Same handler interface as `startWaClient` so `index.ts` barely changes.
- **`normalize.ts`**: add GREEN-API→`WaEvent` mapping; keep `messageId` as `{fromMe}_{chatId}_{ID}` so `order-store.ts` reply-threading keeps working.
- **`web.ts`**: add `POST /api/send` + a compose/reply box on `/match`. Sent messages round-trip via the existing `onSent`→`chats.record` path.
- **`config.ts`+`.env`**: `GREEN_ID_INSTANCE`, `GREEN_API_TOKEN`, `GREEN_API_BASE`.
- **Retire**: `wa-client.ts` (+ both bypasses), `whatsapp-web.js`/puppeteer deps, Chromium, `SingletonLock`, `PUPPETEER_CACHE_DIR` in `run-service.bat`.
- **Rollout**: Phase 1 (safe) — GREEN-API as an *additional* linked device alongside the running whatsapp-web.js reader (undisturbed), build the connector, prove receive (group + DM) via polling + one test send to a test contact. Phase 2 (explicit go-ahead) — Business tier, switch `index.ts`, add send UI, remove whatsapp-web.js, update `HANDOFF.md` §2 (**read-only → read+send**).

### ⚠️ Open decisions (confirm before implementing)
1. **GREEN-API (hosted, ~$8/mo)** vs **Baileys (free, self-hosted)**.
2. **Ban-risk acceptance**: sending on the **main business number** via an unofficial API reverses the HANDOFF §2 read-only posture and raises ban risk. Consider a dedicated number to isolate risk.
3. GREEN-API's servers hold the WhatsApp session (they can see business messages) — acceptable vs. self-hosted Baileys?

### Sources
- GREEN-API: https://green-api.com/en/docs/ · https://green-api.com/en/docs/api/ · https://green-api.com/en/docs/about-tariffs/
- Baileys: https://github.com/WhiskeySockets/Baileys
- Official Cloud API (rejected): https://developers.facebook.com/documentation/business-messaging/whatsapp/overview
