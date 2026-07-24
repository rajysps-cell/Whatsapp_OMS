# WhatsApp Order Monitoring System — Handoff / Continuation Doc

> **Purpose:** hand this to a fresh Claude Code session (new PC, new login, no memory) so it can
> continue the project with zero re-explanation, and let a human set the project up on another machine.
> **Self-contained: read top to bottom.** Last updated: **2026-07-22**.

---

## 0. TL;DR — current state
A **read-only** WhatsApp order-capture + product-matching tool for a US plumbing supplier (**YS Plumbing**,
posts as *"Ys Plumbing Warehouse"*). It runs as one Node service that serves 4 web pages on
`http://localhost:3000`. **Everything below is BUILT and LIVE-VERIFIED** — there is no half-finished work.
The whole thing runs locally, keyless (no AI API key), against a real linked WhatsApp business number.

Pages:
- `/` — **Kanban dashboard** of auto-aggregated order cards (New / Discussion / Waiting Customer / Waiting Warehouse / Finalized).
- `/match` — **Order Matching** (the main workhorse): WhatsApp chat list + message history on the left; per-message product extraction + matching on the right.
- `/aliases` — **Product Alias Management** (view/search/add/edit/delete aliases used in matching).
- `/qr` — QR page to (re)link WhatsApp.

Theme: **light, WhatsApp-style** (white panels, beige chat area, green outgoing bubbles). Everything is a
single-file-per-page inline HTML/CSS/JS built as strings in `web.ts` (no framework, no build step for the UI).

---

## 1. ⚙️ Setup on a NEW PC (do this to make a copied folder work)

**What to copy:** the ENTIRE `Whatsapp_OMS` folder. It can live at any path on the new PC (the code uses
paths relative to the service dir, so it is not tied to `C:\Whatsapp_OMS`).

**Files that MUST be in the copy** (they are git-ignored, so if you ever move via git they'd be missing — a
plain folder copy includes them):
- `services/whatsapp-ingestion/products.csv` — **the product catalog (17,360 rows, bundled 2026-07-21).**
  Previously this lived in `Downloads/ZTMPEXP.csv`; it is now inside the project so the folder is portable.
- `services/whatsapp-ingestion/data.sqlite` (~580 KB) — **all learned aliases, processed-message ids, chat
  catalog, and recovered message history.** Copy it or you lose all that state.
- `services/whatsapp-ingestion/auth/` (~358 MB) — the linked-device WhatsApp session (a Chromium profile).
  Copy it to *try* to keep the session; a new machine often still needs a fresh QR scan (see below).

**Files you can SKIP copying** (regenerated automatically): `node_modules/` (platform-specific binaries —
reinstall instead), `.wwebjs_cache/`, `store/`.

**Steps on the new PC (Windows / PowerShell):**
1. **Install Node ≥ 22.5** (this machine used **v24.18.0**). *Hard requirement:* the app uses the built-in
   `node:sqlite` module, which only exists on Node 22.5+. On older Node it will not start.
2. `cd <folder>\services\whatsapp-ingestion`
3. `npm install` — installs deps. **On npm 11+ (bundled with Node 24.18.0) you MUST then run
   `npx puppeteer browsers install chrome` yourself** — npm 11's `allow-scripts` guard skips Puppeteer's
   postinstall, so Chromium is NOT auto-downloaded (it lands in a per-user cache like
   `%USERPROFILE%\.cache\puppeteer`, not the project). Without this the WhatsApp client fails to launch.
4. `Remove-Item .\auth\session\SingletonLock -Force -ErrorAction SilentlyContinue` (stale Chromium lock from
   the old machine — always clear before the first start).
5. `npm start`
6. Open `http://localhost:3000/qr`. If the copied session resumed, it says **connected**. If not, scan the QR
   on the phone (WhatsApp → Linked devices → Link a device). The session then persists in `./auth`.
7. Open `http://localhost:3000/match` — you should see the chat list and catalog (`17,360 products`).

**No API key needed** (keyless mode). If you ever add one, put `ANTHROPIC_API_KEY=...` in a `.env` file in the
service dir — never paste it in chat.

**Daily catalog auto-import (§8 item 16):** the service refreshes `products.csv` from the DDI export email once a
day. The Gmail **app password** lives in `services/whatsapp-ingestion/.env` as `PRODUCT_IMAP_PASSWORD` — that file
is **git-ignored**, so a plain folder copy includes it but a git move would not. Without it the daily import is
simply skipped (the app still runs on the bundled `products.csv`). To (re)create it, copy the value from the
customer portal's `.env` (`DDI_IMAP_PASSWORD`) into `PRODUCT_IMAP_PASSWORD`.

**Gotcha:** the "clean restart" PowerShell snippet in §8 has one hardcoded path (`...\auth\session\SingletonLock`).
If the folder is not at `C:\Whatsapp_OMS`, adjust that one path (the process-kill lines are path-independent).

---

## 2. Hard constraints (do NOT violate)
- **READ-ONLY.** The bot must NEVER send a WhatsApp message — it only subscribes to inbound/own events. No
  code path calls `client.sendMessage` or similar.
- **Linked to the company's MAIN business number** — the user accepted the (small, read-only) ban risk. Be careful.
- **Keyless matching** (no `ANTHROPIC_API_KEY`) → matching is heuristic + fuzzy, no AI call. AI extraction is a
  dormant seam (`extractor.ts`) that only activates if a key is set.
- **No native-build dependencies** (Windows, no build tools) → persistence uses Node's built-in `node:sqlite`
  (`DatabaseSync`), NOT better-sqlite3.
- **Ponytail working style:** lazy = efficient. YAGNI → reuse → stdlib → 1 line → minimal code. Shortest working
  diff. Leave one runnable check for non-trivial logic. No unrequested abstractions. Read/understand fully first.
- **Don't open UNREAD chats on the live account when testing** — opening marks them read on the user's real
  business WhatsApp. (The `/match` page reads from the local DB and doesn't actually touch WhatsApp Web, but the
  user asked to avoid unread chats regardless. Pick chats with no unread badge.)

---

## 3. Stack & architecture
- **Node v24** (built-in `node:sqlite`), **TypeScript** run via **tsx** (no compile step), strict +
  `noUncheckedIndexedAccess`. Typecheck with `npm run typecheck`.
- **whatsapp-web.js v1.34.7** (Puppeteer/Chromium, unofficial WhatsApp Web client) — the connector. Already the
  latest release.
- **csv-parse v7** (catalog), **pino** logger, **qrcode**/**qrcode-terminal** (QR). `@anthropic-ai/sdk` only used
  if a key exists.
- Web server = stdlib `node:http` (no framework). Every page is vanilla HTML/CSS/JS assembled as a template
  string in `web.ts`.
- **Everything lives in:** `<repo>/services/whatsapp-ingestion/`.

**Flow:** `wa-client.ts` (WhatsApp events) → `normalize.ts` (→ canonical `WaEvent`) → `index.ts` wires handlers
→ `chat-store.ts`/`store.ts` (SQLite persistence) + `order-store.ts` (Kanban aggregation). `web.ts` serves the
pages and JSON APIs; `products.ts` holds the catalog; `matcher.ts` does extraction + fuzzy matching.

### File map (`src/`)
- `index.ts` — entrypoint: load catalog, start WA client + web server, wire handlers.
- `config.ts` — env config; all paths are cwd-relative (portable).
- `wa-client.ts` — read-only whatsapp-web.js client. Emits `onMessage`/`onReaction`/`onSent`/`onQr`/`onStatus`,
  plus `onCatalog` (chat catalog from IndexedDB) and `onHistory` (backfilled messages). Contains the two big
  bypasses (`catalogSync`, `historyBackfill`) — see §4.
- `normalize.ts` — whatsapp-web.js `Message` → canonical `WaEvent`; reply context from `_data.quotedStanzaID`.
- `types.ts` — `WaEvent` and related types (connector-agnostic; a Baileys swap would keep these).
- `chat-store.ts` — SQLite-backed per-chat log (chat list + history for `/match`).
- `store.ts` — `node:sqlite` persistence: `aliases`, `processed`, `chat_names`, `messages`, `catalog_chats`.
- `products.ts` — loads `products.csv` → `Product` objects (incl. `stock`); `all()/count()/byCode()/normalize()`.
- `matcher.ts` — `search()`, `matchItem()` (priority chain), `extractItems()` (with the non-product filter),
  `extractAndMatch()`.
- `order-store.ts` — reply-thread → order-card aggregation (roles/status/finalize) for the Kanban.
- `extractor.ts` — Claude extraction seam (only used if a key exists). Dormant.
- `web.ts` — http server + all pages (`/`, `/match`, `/aliases`, `/qr`) + all JSON APIs. **The biggest file.**
- `product-import.ts` — daily DDI-export-email catalog import: IMAP **read-only** fetch (Gmail "All Mail") →
  validate → atomic overwrite `products.csv` → `products.load()` hot-reload → email a run report. CLI:
  `npm run import:products`.
- `scheduler.ts` — tiny drift-free "run once daily at HH:MM" helper (used by the product import).
- `demo-*.ts` — offline verification scripts (`demo:match` has the extraction self-check).
- (`publisher.ts` was deleted — the old Redis/BullMQ seam, removed 2026-07-20.)

---

## 4. The whatsapp-web.js reality: what's broken + the two bypasses that fix it

**Broken:** whatsapp-web.js's Puppeteer "Store-eval" APIs all throw a minified `Error: "r"` against current
WhatsApp Web (2.3000.x): `getChats`, `getChatById`, `fetchMessages`, `getQuotedMessage`, `downloadMedia`.
Confirmed by tracking issue **pedroslopez/whatsapp-web.js#5733**. Dead ends already ruled out: upgrading the lib
(1.34.7 is latest), pinning a WhatsApp Web version via `webVersionCache`. Only **live `message`/`message_reaction`
events** and reading `msg._data` work out of the box.

**⚡ Bypass #1 — IndexedDB (`catalogSync` in wa-client.ts):** the page's own IndexedDB DB `model-storage` is
directly readable via `client.pupPage.evaluate()`. Readable: `chat` (ALL chats + last-activity `t` +
`unreadCount`), `group-metadata` (**real group subjects**), `contact` (pushnames + lid↔phone mapping). Runs on
`ready` + every 10 min → `catalog_chats` table. Message **bodies** in IndexedDB are encrypted at rest.

**⚡ Bypass #2 — `window.require` (`historyBackfill` in wa-client.ts):** WhatsApp Web's own module system is
exposed as `window.require`. `require('WAWebCollections').Chat/Msg/Contact` gives the live **decrypted in-memory
models**, and `require('WAWebChatLoadMessages').loadEarlierMsgs({chat})` pages older history into memory. Loads up
to 300 msgs/chat on every connect and persists them (INSERT OR IGNORE dedup). First run recovered ~1,360 messages
incl. days of pre-capture history. **Gotchas:** raw in-memory MsgKeys have NO `_serialized` (compose
`fromMe_remote_id` manually to match live-captured ids); `Chat.get(string)` fails (wants a Wid — match on
`getModelsArray()` ids); media msgs carry base64 thumbs in `.body` (use `.caption`).

**Remaining hard ceiling (whatsapp-web.js only):** history depth = whatever WhatsApp synced to the linked device
(~weeks of active chats; `loadEarlierMsgs` returns empty beyond that), and **media/voice download is broken**
(placeholders only). The only fix for deeper history + media = **switch the connector to Baileys**
(`@whiskeysockets/baileys`, no Puppeteer). **The user declined the Baileys rewrite (twice).** If they ever change
their mind: only `wa-client.ts` + `normalize.ts` change; everything downstream (matching, aliases, UI, DB) is
reused; needs one fresh QR scan.

---

## 5. Features — everything that works today (all live-verified)

**Capture & persistence**
- Live capture of inbound group/DM messages + emoji reactions (read-only), plus the account's OWN outgoing
  messages (`message_create` filtered to `fromMe`, via `onSent`) so warehouse replies appear in history.
- All chats + **real names** (group subjects + contact pushnames) via the IndexedDB catalog sync. Manual ✎
  rename button in `/match` for the few nameless `@lid` contacts (`POST /api/chats/rename`).
- **Full message history** backfilled on connect (up to 300/chat, incl. pre-capture days). Timestamps shown.
- Everything persists in `data.sqlite` and survives restarts.

**`/match` — per-message extraction & matching** (the current model)
- Left: chat list (real names, unread badges, search box) → click a chat → WhatsApp-style bubbles (customer left,
  warehouse right, with timestamps and green "✓ Processed" badges).
- Each **customer** message bubble has ONE **Extract** button (and the whole bubble is clickable). It's a
  **toggle**: ON appends that message's products to the right panel (green highlight + "Extracted ✓"); clicking
  again removes only that message's items. Multiple messages can be ON at once. Warehouse/logistics messages and
  bare-URL messages get no button.
- **Right panel** (compact accordion): items split into **Matched** and **Unmatched** sections.
  - Unmatched rows show ONLY `qty + extracted text`. **Click a row** to expand an inline search (fade/slide,
    auto-focus, accordion — one open at a time) with up to **5 ranked suggestions** (exact → alias → fuzzy) and a
    live product search; pick one to resolve it.
  - Matched/resolved rows show `qty | SKU — Product [stock badge]` and `↳ Customer wrote: <original text>` so the
    match can be verified against what the customer typed.
  - **Stock badge** on every product: green "N in stock", amber "N in stock" (≤5), red "out of stock".
  - **Final Order** table = `Qty | SKU | Product [stock] | ✕`. Each row has a **✕ remove** button that un-picks
    that item (sets `chosen=null`) — it drops out of the order and reappears under **Unmatched** to re-resolve or
    leave out. (Does not delete any learned alias; manage those on `/aliases`.) **Copy** button copies `qty,SKU` lines (no header),
    then marks every currently-extracted message **Processed** and resets the panel (those bubbles → "Re-Extract").
    Copy refuses to run with 0 resolved items.
- ▲/▼ nav buttons in the thread header jump between extracted/processed bubbles.

**Matching & aliases**
- Keyless matching priority: **exact product name/UPC/code → exact saved alias → fuzzy → (AI seam) → unmatched.**
  Fuzzy = trigram Dice + token-set overlap + code/UPC boost. Suggestions filtered to genuine matches
  (`SUGG_MIN=0.2`), never padded to 5.
- **Self-learning aliases:** resolving an unmatched item saves the phrase→product mapping (`POST /api/alias`),
  auto-matching it next time. Every learned/edited alias stores its original display text (`alias_text` column).

**`/aliases` — Product Alias Management**
- Table of products with alias counts; search by SKU / product name / alias (empty search = products that have
  aliases; typing searches the full catalog). Server-side pagination.
- **Click a product row** → its aliases expand inline (accordion, fade in/out) as removable chips with edit (✎)
  and delete (🗑). Add-alias input with validation (trim, non-empty, ≤255, case-insensitive dedupe). Delete-confirm
  modal, toasts, loading/empty states. All AJAX, no full reloads. Reuses the SAME `aliases` table the matcher
  reads — so anything managed here immediately affects matching, and auto-learned aliases show up here.

**`/` — Kanban dashboard**
- Auto-aggregates reply-threads into order cards across 5 status columns. Runs silently; the main workflow is
  `/match`. (Flagged earlier as "the most unused subsystem" but the user kept it.)

**Smarter extraction (non-product filter)**
- `matcher.ts extractItems` skips lines that are clearly NOT products: addresses (street suffix or leading 3+
  digit number), greetings/instructions ("pls deliver", "asap", "thanks"), phone numbers, ZIPs, dates/times,
  invoice/PO/tracking labels, standalone location words ("office", "warehouse"), **questions (any line with a
  "?"), conversational sentences (≥2 words from the `PROSE` set of pronouns/verbs/question-words), standalone
  note words (`NOTE_WORDS`: lmk, advice, add, copy, checking, uber, mins, got, arrived, ready…), NYC-area place
  names + recurring driver/sender first names (`NAMES`: milton, nate, luis…), bare numbers / "20 min" durations,
  and buyer/job/contact labels.** `hasProductSignal` (size/unit/plumbing term/known alias) protects real products
  so they're never dropped — `PRODUCT_TERMS` was widened to cover supplies that lack an obvious fitting word
  (sprinkler, gauge, gloves, silicone, glue, putty, dope, soldering, torch, gas, spray/paint, no-hub/nh…) and the
  size detector now recognises foot marks (`2'`) and `psi`. A quantity like "2' 45" / "3/4 tee" no longer has its
  leading size eaten as a count. Also strips leading unit words ("10 pieces - 2\" tee" → "2\" tee") and trailing
  instruction words ("... asap"). **Conservative:**
  the question/prose/note rules run only on lines WITHOUT a product signal, so a real product line is never
  dropped (e.g. "This is backorder will let you know in the morning eta" is dropped, but its "3 2x3½ brass nipple"
  etc. are kept; "Water flow switch Potter (vsr s)" and bare codes like "PABCFA15" are kept). Still needs AI for
  the hardest cases: a bare proper noun ("Milton", "Icon") or a question that contains a product word
  ("Check on box if it's same?") can still slip through. `demo:match` asserts the keep/drop behaviour.

---

## 6. Data model (`data.sqlite`, via `store.ts`)
- `aliases(phrase_norm PK, product_code, product_desc, created_at, alias_text)` — learned mappings; the matcher
  keys on `phrase_norm` (normalized), `alias_text` is original display text for `/aliases`.
- `processed(message_id PK, chat_id, processed_at, message_text, items)` — which messages are done + a trace of
  what was extracted/matched (JSON).
- `chat_names(chat_id PK, name, updated_at)` — manual/derived chat titles.
- `messages(msg_id PK, chat_id, sender, push_name, body, kind, from_me, is_group, ts)` — captured + backfilled
  message history (powers the `/match` thread and chat list).
- `catalog_chats(chat_id PK, name, is_group, last_ts, unread, alt_id)` — full chat list from the IndexedDB sync.

Products come from `products.csv` (columns incl. `Product (20)`=SKU, `Description`, `UPC`, `Available`=stock).
`stock` is parsed as a **float** (values can be decimal, e.g. `1746.8` ft for pipe — do NOT strip the "." or you
get a 10× value like `17468`). Moving the catalog to a real DB later touches only `products.ts`.

---

## 7. Run / restart & scripts (Windows, PowerShell)
Working dir: `<repo>\services\whatsapp-ingestion`.

**Scripts:** `npm run dev` (tsx watch, auto-reload) · `npm start` · `npm run typecheck` ·
`npm run demo:match` (offline extraction+matching check, incl. the non-product-filter asserts) ·
`npm run demo:orders` · `npm run demo` (needs a key) ·
`npm run import:products` (fetch the latest DDI export email now + refresh `products.csv`).

**Clean restart** (whatsapp-web.js can hang on a stale Chromium lock after a hard kill):
```powershell
# 1. Kill this service's node process
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*whatsapp-ingestion*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# 2. Kill the orphaned puppeteer Chromium
Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*puppeteer*' } | Stop-Process -Force
# 3. Remove the stale lock (ADJUST PATH if the folder isn't at C:\Whatsapp_OMS), then start
Remove-Item '.\auth\session\SingletonLock' -Force -ErrorAction SilentlyContinue
npm start
```
Notes: a background TaskStop may not kill the node child (orphan holds port 3000) — use step 1. If init still
hangs, also clear `.wwebjs_cache`. Web server binds `0.0.0.0:3000` (reachable from other devices on the LAN).

**Always-on service (autostart, added 2026-07-24).** The service runs 24/7 as a Windows **Task Scheduler** task
named **`WhatsApp OMS Service`** — trigger *At startup*, principal **SYSTEM** (no login required), RunLevel
Highest. It launches `run-service.bat` (in the service dir): a keep-alive loop that sets PATH + exports
`PUPPETEER_CACHE_DIR=C:\Users\Administrator\.cache\puppeteer` (so the headless Chromium is found when running as
SYSTEM), clears the stale `auth/session/SingletonLock`, runs `npm start`, and restarts it ~5 s after any exit.
Its logs go to `services/whatsapp-ingestion/logs/service.log`. **The task owns port 3000**, so:
- **Restart after a code change:** `Restart-ScheduledTask -TaskName "WhatsApp OMS Service"` — do NOT run a second
  `npm start`, it would collide on port 3000.
- **Stop / disable:** `Stop-ScheduledTask -TaskName "WhatsApp OMS Service"` (then `Disable-ScheduledTask …` to keep
  it from restarting at boot).
- **Status / PID:** `Get-ScheduledTask "WhatsApp OMS Service"` and `Get-NetTCPConnection -LocalPort 3000`.

**LAN access.** Reachable at `http://<LAN-IP>:3000` — this machine is the **static IP `192.168.1.40`**, so
`http://192.168.1.40:3000/match`. Other devices ALSO require a one-time Windows Firewall inbound rule (a manual
admin step — a security setting, so run it yourself):
`New-NetFirewallRule -DisplayName "WhatsApp OMS 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private -RemoteAddress LocalSubnet`

**Config** (env vars, all optional — `src/config.ts`): `PRODUCTS_CSV` (default: bundled `./products.csv`),
`DB_PATH` (default `./data.sqlite`), `AUTH_DIR` (default `./auth`), `WEB_PORT` (3000), `WEB_HOST` (0.0.0.0),
`ALLOWED_GROUPS` (empty = all), `WAREHOUSE_NAMES` (default `warehouse,shipping` — display-name substrings that
mark a sender as warehouse/own side; set to your staff names so their bubbles sit on the right with no Extract
button), `FINALIZE_EMOJIS` (default `✅,👍,🆗` — UNCONFIRMED, set to the team's real finalize emoji),
`ANTHROPIC_API_KEY` (absent → keyless), `EXTRACT_MODEL` (`claude-opus-4-8`).

**Daily product-import env** (`config.productImport`, all optional — see `.env.example`): `PRODUCT_IMPORT_ENABLED`
(default on; still no-ops without a password), `PRODUCT_IMAP_HOST`/`PRODUCT_IMAP_PORT` (default `imap.gmail.com:993`),
`PRODUCT_IMAP_USER` (default `ysddiexport@gmail.com`), **`PRODUCT_IMAP_PASSWORD`** (Gmail app password — REQUIRED to
enable; absent → import skipped; lives only in the git-ignored `.env`), `PRODUCT_SUBJECT_FILTER` (default `ZTMPEXP`),
`PRODUCT_SENDER_FILTER` (empty = subject-only), `PRODUCT_IMPORT_TIME` (comma-separated `HH:MM`; runs once per
listed time; default `23:30,11:30` — twice daily, after the two export emails), `PRODUCT_IMPORT_CATCHUP_HOURS`
(default 24), `PRODUCT_IMPORT_MIN_ROWS` (default 1000), `PRODUCT_IMPORT_DIR` (default `./imports`). **Run-report
email:** `PRODUCT_REPORT_TO` (recipient; empty = no emails; set to `ruturajysps@gmail.com`), `PRODUCT_REPORT_FROM`
(default = SMTP user), `PRODUCT_SMTP_HOST`/`PRODUCT_SMTP_PORT` (default `smtp.gmail.com:587`), `PRODUCT_SMTP_USER`/
`PRODUCT_SMTP_PASSWORD` (default to the `PRODUCT_IMAP_*` values — reuses the same Gmail app password).

---

## 8. Session changelog (2026-07-20 → 2026-07-22) — everything we did, newest last
1. **Chat/message persistence** — moved the in-memory chat log to SQLite (`messages` table) so the `/match` chat
   list is cumulative and survives restarts; also capture our own outgoing messages (`onSent`). Live-verified.
2. **Process-only-new + mark-processed** — `/api/extract` extracts only unprocessed inbound messages, returns
   `newMessages` count; wired the `processed` table into the flow.
3. **IndexedDB catalog sync (bypass #1)** — all chats + real group/contact names + unread counts; ✎ rename button.
4. **History backfill via `window.require` (bypass #2)** — recovered pre-capture history (~1,360 msgs first run).
5. **Per-message extraction** — "Extract from this message" buttons; source highlight; `/api/save` stores a full
   trace (message text + matched items JSON) and marks only that message processed.
6. **Multi-select → then reverted to a per-message TOGGLE model** (the user changed their mind): one Extract
   toggle per bubble; ON appends its items, OFF removes only its items; multiple can be ON; Save/Copy commits.
7. **Dark-theme UI overhaul (13-point spec)** — full redesign; Extract state machine (Extract → spinner
   Extracting… → Extracted ✓ → Processed → Re-Extract); Copy renamed, copies `qty,SKU`, marks processed on Copy
   (not on extract); Qty|SKU|Product final table; nav ▲/▼; suggestions hidden until search focus.
8. **QA + 3 bug fixes** — (a) warehouse/own-side detection moved server-side & config-driven (`isWarehouseMsg`,
   default `warehouse,shipping`; sent as `outgoing`), plus no Extract button on bare-URL messages; (b) Copy
   refuses to run with 0 resolved items (was silently marking processed + copying empty); (c) extraction skips
   URL segments + strips leading list-number punctuation. **Removed the dead Redis/BullMQ publisher** (deleted
   `publisher.ts`, dropped bullmq/ioredis, removed config). Dashboard + AI seam kept (user "no preference").
9. **Light theme** — reskinned `/match` and `/` to a WhatsApp-style light theme (white/beige, green outgoing
   bubbles, dark text). Pure CSS (the `<style>` blocks only). The user asked for light; the spec's stale "dark"
   wording was overridden to match the rest of the site.
10. **`/aliases` page** — Product Alias Management (view/search/add/edit/delete), reusing the existing `aliases`
    table (+`alias_text` column). Started as a side panel, then **switched to an inline accordion** (click a row →
    aliases fade in below it). Full server-side validation + toasts + confirm modal.
11. **Right-panel redesign + smarter extraction** — compact accordion rows; removed "Extracted from N messages",
    the "N suggestions…" hint, and the "customer:" label; unmatched = qty + text only, click to expand search;
    matched shows "↳ Customer wrote"; added the non-product extraction filter (`isNonProduct`/`hasProductSignal`)
    with a self-check in `demo-match.ts`.
12. **New catalog + stock display** — switched to the updated catalog (17,360 products) with an `Available` stock
    column; added `stock` to `Product`; stock badge (green/amber/red) on every product display + final table.
13. **Decimal-stock fix** — `Available` values are decimals (e.g. `1746.8`); fixed the parser (was stripping the
    "." → 17468) to `parseFloat`; badge shows `1,746.8 in stock`.
14. **Portability (2026-07-21)** — bundled `products.csv` into the project and made `config.productsCsvPath`
    relative, so a copied folder is self-contained. Rewrote this handoff. (No source is tied to `C:\Whatsapp_OMS`.)

### 2026-07-22 — new-PC setup + daily catalog auto-import
15. **Ran the fresh-PC setup (§1)** on `C:\inetpub\wwwroot\Whatsapp_OMS`: installed **Node v24.18.0** via
    `winget install OpenJS.NodeJS.LTS`, `npm install`, downloaded Chromium, scanned a fresh QR. The copied
    `auth/` was a partial 55 MB and threw `ProtocolError: Execution context was destroyed` on init — deleting
    `auth/` + `.wwebjs_cache/` fixed it. Started fresh (the copy had no `data.sqlite`), so learned aliases +
    history from the old PC were NOT carried over; chat catalog + recent history re-synced on connect (60 chats,
    782 msgs).
    - ⚠️ **npm 11 gotcha:** npm 11.16.0 (bundled with Node 24.18.0) has an `allow-scripts` guard that SKIPS
      Puppeteer's postinstall, so `npm install` no longer auto-downloads Chromium (contradicts §1 step 3's old
      assumption). You MUST run `npx puppeteer browsers install chrome` explicitly. esbuild/tsx still work
      (prebuilt platform pkg, no script needed).
    - Also: freshly-spawned shells may not see Node on PATH right after the winget install (parent env is cached);
      open a new terminal, or prepend `C:\Program Files\nodejs` to PATH.
16. **Daily product-catalog auto-import from the DDI export email** — new feature so the catalog updates itself
    instead of a manual `products.csv` swap. Mirrors the customer-portal `YSPSCustomerPortal/DDIImport` Python job.
    - New files: `src/product-import.ts` (fetch → validate → atomic overwrite `products.csv` → `products.load()`
      hot-reload) and `src/scheduler.ts` (drift-free "run daily at HH:MM"). Wired in `index.ts` via
      `startProductImport()`. Manual run: `npm run import:products`.
    - Runs **in-process twice daily at 23:30 & 11:30** (`PRODUCT_IMPORT_TIME`, comma-separated — the DDI export
      email arrives after ~23:00 and ~11:00); hot-reloads the live in-memory catalog with NO restart; on startup
      does a catch-up import if `products.csv` is older than 24 h (`PRODUCT_IMPORT_CATCHUP_HOURS`).
    - **Non-destructive by design (do not change this):** BOTH projects read the SAME mailbox
      `ysddiexport@gmail.com`, and the portal's job runs **23:59 and CONSUMES the email** (marks `\Seen`, moves it
      to the "Imported" label, deletes from INBOX). Ours therefore reads **READ-ONLY** (IMAP `EXAMINE`) from
      **Gmail "All Mail"** — which retains every message regardless of label — and never marks/moves/deletes. So it
      works whether it runs before or after the portal job and can never break it. Do NOT switch ours to
      mark-seen/delete/expunge or an INBOX-only search.
    - Guards: validates the download before overwriting (needs the `Product (20)` header + ≥
      `PRODUCT_IMPORT_MIN_ROWS`=1000 rows); keeps an audit copy of every import under `imports/` (git-ignored).
    - **Emails a run report after every import** (success OR failure) to `PRODUCT_REPORT_TO`
      (`ruturajysps@gmail.com`) — same idea as the portal's summary. Sent via Gmail SMTP (`nodemailer`,
      smtp.gmail.com:587); SMTP creds default to the SAME `ysddiexport` account/app-password as the IMAP read, so
      no extra secret. Subject e.g. `WhatsApp OMS product import — updated (17,362 products)`; body has host, time,
      result, rows, catalog count, audit path. Empty `PRODUCT_REPORT_TO` disables it. Non-fatal (a send failure
      never fails the import).
    - New deps: `imapflow`, `mailparser`, `nodemailer`. New env: `PRODUCT_IMAP_*` / `PRODUCT_IMPORT_*` /
      `PRODUCT_REPORT_TO` / `PRODUCT_SMTP_*` (see `.env.example`). Credentials = the existing Gmail **app password**
      reused from the portal's `.env`, in the git-ignored `services/whatsapp-ingestion/.env` (never printed).
      Live-verified: pulled the latest export, overwrote `products.csv`, hot-reloaded, emailed the report, scheduler
      armed for 23:30 & 11:30.
17. **Non-product filter — round 2 (notes/questions/prose)** — a customer message mixed a status note
    ("This is backorder will let you know in the morning eta") with real product lines, and the note was being
    extracted as an item. Reviewed ~90 real multi-line messages from the DB and hardened `matcher.ts`
    `isNonProduct`: now also drops (only on lines with NO product signal) any line containing a **"?"** (questions
    /inquiries), any line with **≥2 conversational words** (new `PROSE` set of pronouns/verbs/question-words), and
    lines made only of **note words** (new `NOTE_WORDS`: lmk, advice, eta, backorder, approx, price, model…). The
    `!hasProductSignal` guard is unchanged, so no real product line is ever dropped. Verified against the sample +
    added `demo:match` asserts (reported message → 3 products kept, note dropped; codes/no-size products kept).
18. **Non-product filter — round 3 (exhaustive review)** — dumped every extracted line WITH NO product signal
    across all 6,307 captured messages (a temporary script; deleted after) and worked the ranked list. Two halves:
    (a) **protect real products** — widened `PRODUCT_TERMS` with supplies (sprinkler, gauge, gloves, silicone,
    glue, putty, dope, soldering, torch, gas, spray/paint, water, cover, no-hub/nh…), taught the size detector
    foot marks (`2'`) and `psi`, and stopped the quantity parser from eating a leading size (`2' 45`, `3/4 tee`);
    (b) **drop more noise** — expanded `NOTE_WORDS`/`PROSE` (advise, add, copy, checking, uber, mins, got, arrived,
    ready, looking, understood…), added `NAMES` (recurring drivers/senders) + NYC place names, and new rules for
    bare numbers, "20 min" durations, and buyer/job/contact labels. Net: no-signal kept-lines **2,326 → 1,498**
    unique and total extracted items **12,935 → 11,896** (~1,000 noise lines removed) with the keep-guarantee
    intact (verified by expanded `demo:match` asserts). Remaining leaks are typo'd real products (kept for fuzzy
    matching), brand-ambiguous words (Icon, Cooper, Henry), and a thin chatter tail — the AI seam's job.
19. **Always-on service + LAN** — the service kept dying because it was started as a transient background shell
    that ended with the session. Fixed by running it as a Task Scheduler task (`WhatsApp OMS Service`, SYSTEM,
    At-startup, keep-alive `run-service.bat`) — details in §7. Also confirmed a "No products found" report was
    NOT an extraction bug: the server had simply stopped (the message extracts 3 items, shown as *Unmatched* with
    suggestions, once the service is up). LAN reach = static IP `192.168.1.40:3000` + a manual firewall rule (§7).
20. **Final Order ✕ remove button** — each Final Order row now has a ✕ that un-picks the item (`chosen=null`,
    `updateFinal`/`rmfinal` handler in `web.ts`), moving it back to the Unmatched section. Verified in-browser.

---

## 9. Gotchas learned the hard way (save yourself the debugging)
- **Regexes inside the `web.ts` page template literals** must avoid backslash classes like `\S`, `\d`, `\/` —
  the template literal eats the backslash and breaks the regex (it once broke chat opening). Use string methods
  (`indexOf`, `startsWith`) instead, or write the browser-context code as a `page.evaluate('...')` string.
- **In the in-app browser test pane**, `requestAnimationFrame` is throttled/unreliable — to trigger a CSS
  transition after inserting an element, force a reflow (`void el.offsetWidth; el.classList.add('show')`), not rAF.
- **`getComputedStyle` in that pane returns STALE values** for elements whose class was toggled at runtime
  (`.xbtn.on`, `.bubble.ext`, `.expand.show`) — the actual paint is correct; to read the true value in a test,
  clone the node or force a recalc (`el.style.display='none'; el.offsetHeight; el.style.display=''`).
- **Screenshots of the in-app browser pane time out** — verify via `read_page` / `javascript_tool` / computed
  styles instead.
- **whatsapp-web.js hangs on a stale `auth/session/SingletonLock`** after a hard kill — always remove it before start.
- When testing on the live account, **clean up any test data** (e.g. a learned alias) so the DB stays net-zero,
  and **don't open unread chats**.

---

## 10. Known limitations / deferred
- **No media/voice download** (whatsapp-web.js `downloadMedia` broken) — images/voice show as placeholders.
  Baileys-only.
- **History depth** = WhatsApp's linked-device sync window; no deeper backfill. Baileys-only.
- **Extraction is heuristic** (keyless): drops obvious non-products but a bare proper-noun line with no number
  can slip through. Flipping on `ANTHROPIC_API_KEY` activates the `extractor.ts` AI seam for better extraction.
- **Kanban dashboard `/`** is a largely-unused parallel subsystem (the real workflow is `/match`); kept at the
  user's choice.
- Catalog is a CSV (`products.csv`); a DB move touches only `products.ts`. As of 2026-07-22 the CSV is
  **auto-refreshed daily** from the DDI export email (§8 item 16) — the file itself is still the store.

---

## 11. Observed reality of the real WhatsApp data (for tuning)
- Orders are **terse prose**, not line items: `"Tanks and pumps please"`, `"2 floor clean outs 4”"`,
  `"Please send me a price for 5 50gal and 5 pumps"`. Often no job site / no quantities; often mixed with
  addresses and delivery notes on separate lines.
- Workflow is **reply-driven**: customer posts → warehouse replies with a voice note or a quote PDF. Lots of `"."`
  ack replies.
- Senders are `@lid` IDs, not phone numbers → identify people by `pushName`. Mixed id formats (`@g.us`, `@c.us`,
  `@lid`).

---

## 12. Misc
- User (project owner) email on record: **Dhaval@ysplumbing.com**.
- Auto-memory on the ORIGINAL machine lived at `~/.claude/projects/C--Whatsapp-OMS/memory/`; a new PC won't have
  it — **this file is the source of truth** and folds in everything essential.
