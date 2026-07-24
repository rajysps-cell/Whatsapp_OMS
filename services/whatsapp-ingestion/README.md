# WhatsApp Ingestion + Order Matching (whatsapp-web.js)

> ⚠️ **This README describes the original ingestion layer and is partially outdated.** For the current
> architecture, all features, setup-on-a-new-PC steps, and known limitations, read **[`../../HANDOFF.md`](../../HANDOFF.md)**
> (the authoritative, up-to-date doc). The app now matches **keyless** (no AI key needed) and has a full
> web UI at `/match`, `/aliases`, `/` and `/qr`. Redis/BullMQ was removed.

Read-only ingestion layer for the **WhatsApp Order Command Center**. It links to WhatsApp as a
companion device (scan a QR on a web page), listens to your order groups, and turns messages into a
clean matched product list on the `/match` page. Claude extraction is an optional dormant seam (only
active if `ANTHROPIC_API_KEY` is set); by default matching is keyless (heuristic + fuzzy).

**This service never sends messages.** It only listens — the single biggest reducer of ban risk.
No n8n required.

## How it fits
```
WhatsApp groups → [whatsapp-web.js, read-only] → normalized events ─┬─→ BullMQ/Redis (or console)
                                                                     └─→ Claude → structured order (job site, items, status, summary)
```

## Prerequisites
- **Node.js 22.5+** (tested on 24) — REQUIRED, the app uses the built-in `node:sqlite` module which does not
  exist on older Node. On Node < 22.5 it will not start.
- Chromium — whatsapp-web.js uses Puppeteer, which downloads Chromium during `npm install`
  (or run `npx puppeteer browsers install chrome`).
- `ANTHROPIC_API_KEY` — OPTIONAL, only to enable the dormant AI extraction seam. The app matches keyless without it.

## Setup
```bash
cd services/whatsapp-ingestion
npm install
cp .env.example .env   # set ANTHROPIC_API_KEY if you want extraction
```

## Try the extractor without WhatsApp (fastest check)
Runs Claude on the PDF's sample order and prints structured JSON. Needs `ANTHROPIC_API_KEY`.
```bash
npm run demo
```

## Running the full service — ⚠️ read before you do this
Starting the service and scanning the QR **links it to a WhatsApp account**. Using an unofficial
client (whatsapp-web.js) is against WhatsApp's ToS, so the linked number carries a ban risk —
**read-only lowers it but does not remove it**. Prefer a **dedicated number** added to your order
groups, so a ban never touches your main business line.

```bash
npm run dev
```
1. Open **http://localhost:3000** (or the machine's IP:3000 from another device) — the QR appears there and auto-refreshes.
2. Scan it: **WhatsApp → Linked devices → Link a device**. The page shows "Connected".
3. Post a message in a group → you'll see the normalized event and, if `ANTHROPIC_API_KEY` is set, an `order-extraction` log with the parsed order.

Session saves to `./auth` (scan once). Stop with `Ctrl+C`. To unlink: remove the device from the phone **and** delete `./auth`.

## What Claude extracts (per message)
`intent` (new_order / discussion / replacement / customer_approval / warehouse_approval / finalized / question / other),
`jobSite`, `pickupLocation`, `items[] {quantity, product}`, `summary`, `waitingFor`, `nextAction`.
Model defaults to `claude-opus-4-8`; set `EXTRACT_MODEL=claude-haiku-4-5` (or `claude-sonnet-5`) to cut cost.

## Environment
See `.env.example`: `ANTHROPIC_API_KEY`, `EXTRACT_MODEL`, `WEB_PORT`/`WEB_HOST`, `REDIS_URL`,
`ALLOWED_GROUPS`, `AUTH_DIR`, `STORE_DIR`, `LOG_LEVEL`.

## Project layout
| File | Responsibility |
|---|---|
| `src/config.ts` | Env-driven config |
| `src/logger.ts` | App logger |
| `src/types.ts` | Canonical normalized-event shape |
| `src/wa-client.ts` | whatsapp-web.js connection (read-only, auth, QR, reconnect) |
| `src/web.ts` | Web page that shows the QR + connection status |
| `src/normalize.ts` | Message/Reaction → canonical event; media download + STT seam |
| `src/extractor.ts` | Claude structured-output order extraction |
| `src/demo-extract.ts` | Standalone extractor smoke test (`npm run demo`) |
| `src/publisher.ts` | Push events to BullMQ (console fallback) |
| `src/index.ts` | Wires it together |

## Notes / not yet built
- **Voice transcription** (`transcribeVoice` in `normalize.ts`) is a seam — pick an STT provider to enable it.
- **Persistence + status state machine**: extraction currently logs per message. Grouping messages into one order card, tracking status transitions, and writing to Postgres is the next backend step (per the plan).
- **Finalize emoji**: reaction events flow through; deciding *which* emoji finalizes an order is a business rule to add.
- **Security note:** the QR page is served on `WEB_HOST` (default `0.0.0.0`). The QR is sensitive — keep the port on a trusted network; it disappears once connected.
