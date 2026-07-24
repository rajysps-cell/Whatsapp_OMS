import http from 'node:http';
import QRCode from 'qrcode';
import type { ChatStore } from './chat-store';
import { config } from './config';
import { logger } from './logger';
import { extractAndMatch, search } from './matcher';
import type { Order } from './order-store';
import { all as allProducts, byCode, count as productCount, normalize } from './products';
import {
  addAlias,
  aliasCodesMatching,
  aliasCount,
  aliasCountsByCode,
  aliasesForProduct,
  deleteAlias,
  getAliasRow,
  isProcessed,
  saveExtraction,
  setChatName,
  updateAliasText,
} from './store';

let status = 'starting';
let qrDataUrl: string | null = null;
let ordersProvider: () => Order[] = () => [];
let chatStoreRef: ChatStore | null = null;

export async function setQr(qr: string): Promise<void> {
  try {
    qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    status = 'waiting for scan';
  } catch (err) {
    logger.error({ err }, 'failed to render QR');
  }
}

export function setStatus(s: string): void {
  status = s;
  if (s === 'connected') qrDataUrl = null;
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
// Warehouse/own side vs customer. Own device (fromMe) or a sender whose display name matches a
// configured WAREHOUSE_NAMES substring. Set WAREHOUSE_NAMES to your staff names (e.g. "warehouse,
// shipping,ys plumbing") so their messages sit on the right and never get an Extract button.
function isWarehouseMsg(m: { fromMe: boolean; pushName?: string }): boolean {
  if (m.fromMe) return true;
  const name = (m.pushName ?? '').toLowerCase();
  return config.warehouseNames.some((n) => n && name.includes(n.toLowerCase()));
}
// Shared alias validation (trim, non-empty, <=255, must normalize to something matchable).
function validateAliasInput(raw: unknown): { ok: true; text: string; norm: string } | { ok: false; error: string } {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'Alias cannot be empty.' };
  if (text.length > 255) return { ok: false, error: 'Alias is too long (max 255 characters).' };
  const norm = normalize(text);
  if (!norm) return { ok: false, error: 'Alias must contain letters or numbers.' };
  return { ok: true, text, norm };
}
function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

export function startWebServer(getOrders: () => Order[], chatStore: ChatStore): http.Server {
  ordersProvider = getOrders;
  chatStoreRef = chatStore;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error({ err, url: req.url }, 'web request failed');
      try {
        json(res, 500, { error: 'internal' });
      } catch {
        /* response already sent */
      }
    });
  });

  server.listen(config.webPort, config.webHost, () => {
    logger.info(
      { port: config.webPort },
      `dashboard http://localhost:${config.webPort}  ·  matcher /match  ·  link /qr`,
    );
  });
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const u = new URL(req.url ?? '/', 'http://localhost');
  const path = u.pathname;

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (path === '/api/orders') {
    json(res, 200, { status, ts: Math.floor(Date.now() / 1000), orders: ordersProvider() });
    return;
  }
  if (path === '/api/products/search') {
    const q = u.searchParams.get('q') ?? '';
    const limit = Math.min(20, Number(u.searchParams.get('limit') ?? 8) || 8);
    json(res, 200, { results: search(q, limit).map((s) => s.product) });
    return;
  }
  if (path === '/api/extract' && req.method === 'POST') {
    const body = await readBody(req);
    let text = typeof body['text'] === 'string' ? (body['text'] as string) : '';
    let sources: Array<{ messageId: string; text: string }> = [];
    let newCount = -1;
    if (!text && typeof body['chatId'] === 'string' && chatStoreRef) {
      const cid = body['chatId'] as string;
      const mid = typeof body['messageId'] === 'string' ? (body['messageId'] as string) : '';
      const mids = Array.isArray(body['messageIds'])
        ? (body['messageIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : mid
          ? [mid]
          : [];
      const msgs = chatStoreRef.messages(cid);
      // With messageId(s): extract ONLY those bubbles (also serves as Reprocess for processed ones).
      // Without: all inbound customer messages not yet processed. Nothing is marked here —
      // marking happens on explicit /api/save, so unsaved extractions can be re-run.
      const pick = mids.length
        ? msgs.filter((m) => mids.includes(m.messageId))
        : msgs.filter((m) => !m.fromMe && !isProcessed(m.messageId));
      sources = pick.filter((m) => m.text).map((m) => ({ messageId: m.messageId, text: m.text }));
      text = sources.map((s) => s.text).join('\n');
      if (!mids.length) newCount = pick.length;
    }
    json(res, 200, { items: extractAndMatch(text), sources, ...(newCount >= 0 ? { newMessages: newCount } : {}) });
    return;
  }
  if (path === '/api/save' && req.method === 'POST') {
    const body = await readBody(req);
    const cid = typeof body['chatId'] === 'string' ? (body['chatId'] as string) : '';
    const srcs = Array.isArray(body['sources']) ? (body['sources'] as Array<{ messageId?: string; text?: string }>) : [];
    const itemsJson = JSON.stringify(body['items'] ?? []);
    let saved = 0;
    for (const s of srcs) {
      if (s && typeof s.messageId === 'string' && s.messageId) {
        saveExtraction(s.messageId, cid, typeof s.text === 'string' ? s.text : '', itemsJson);
        saved++;
      }
    }
    json(res, 200, { ok: saved > 0, saved });
    return;
  }
  if (path === '/api/alias' && req.method === 'POST') {
    const body = await readBody(req);
    const phrase = typeof body['phrase'] === 'string' ? (body['phrase'] as string) : '';
    const code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
    const desc = typeof body['description'] === 'string' ? (body['description'] as string) : '';
    if (phrase && code) addAlias(normalize(phrase), code, desc, phrase.trim());
    json(res, 200, { ok: true, aliases: aliasCount() });
    return;
  }
  if (path === '/api/chats/rename' && req.method === 'POST') {
    const body = await readBody(req);
    const cid = typeof body['chatId'] === 'string' ? (body['chatId'] as string) : '';
    const name = typeof body['name'] === 'string' ? (body['name'] as string).trim() : '';
    if (cid && name) setChatName(cid, name);
    json(res, 200, { ok: !!(cid && name) });
    return;
  }
  if (path === '/api/chats') {
    const list = chatStoreRef ? chatStoreRef.chats() : [];
    json(res, 200, {
      source: 'persisted',
      chats: list.map((c) => ({ id: c.id, title: c.title, lastText: c.lastText, lastTs: c.lastTs, unread: c.unread, isGroup: c.isGroup })),
    });
    return;
  }
  const mm = path.match(/^\/api\/chats\/(.+)\/messages$/);
  if (mm) {
    const id = decodeURIComponent(mm[1] ?? '');
    const msgs = chatStoreRef ? chatStoreRef.messages(id) : [];
    json(res, 200, {
      messages: msgs.map((m) => ({ messageId: m.messageId, fromMe: m.fromMe, pushName: m.pushName, text: m.text, kind: m.kind, hasMedia: m.kind !== 'text', ts: m.ts, processed: isProcessed(m.messageId), outgoing: isWarehouseMsg(m) })),
    });
    return;
  }
  if (path === '/api/products/count') {
    json(res, 200, { count: productCount(), aliases: aliasCount() });
    return;
  }
  // --- Alias Management API ---
  if (path === '/api/aliases' && req.method !== 'POST') {
    const q = (u.searchParams.get('q') ?? '').trim();
    const page = Math.max(1, Number(u.searchParams.get('page') ?? 1) || 1);
    const limit = Math.min(100, Math.max(1, Number(u.searchParams.get('limit') ?? 25) || 25));
    const counts = new Map<string, { n: number; desc: string }>();
    for (const c of aliasCountsByCode()) counts.set(c.code, { n: c.n, desc: c.desc });
    let codes: string[];
    if (!q) {
      // Default view: only products that actually have aliases (the ones worth managing).
      codes = [...counts.keys()];
    } else {
      // Search: any product by SKU/name across the full catalog, plus products matched by alias.
      const ql = q.toLowerCase();
      const set = new Set<string>();
      for (const p of allProducts()) {
        if (p.code.toLowerCase().includes(ql) || p.description.toLowerCase().includes(ql)) set.add(p.code);
      }
      for (const c of aliasCodesMatching(ql)) set.add(c);
      codes = [...set];
    }
    const rows = codes.map((code) => {
      const meta = counts.get(code);
      return { code, description: byCode(code)?.description ?? meta?.desc ?? '', count: meta?.n ?? 0 };
    });
    rows.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    const start = (page - 1) * limit;
    json(res, 200, { total: rows.length, page, limit, rows: rows.slice(start, start + limit) });
    return;
  }
  if (path === '/api/aliases/product') {
    const code = u.searchParams.get('code') ?? '';
    json(res, 200, { code, description: byCode(code)?.description ?? '', aliases: aliasesForProduct(code) });
    return;
  }
  if (path === '/api/aliases/add' && req.method === 'POST') {
    const body = await readBody(req);
    const code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
    if (!code) {
      json(res, 200, { ok: false, error: 'Missing product.' });
      return;
    }
    const v = validateAliasInput(body['alias']);
    if (!v.ok) {
      json(res, 200, { ok: false, error: v.error });
      return;
    }
    const existing = getAliasRow(v.norm);
    if (existing) {
      json(res, 200, {
        ok: false,
        error:
          existing.code === code
            ? 'This alias already exists for this product.'
            : `That alias is already assigned to another product (${existing.code}).`,
      });
      return;
    }
    addAlias(v.norm, code, byCode(code)?.description ?? '', v.text);
    json(res, 200, { ok: true, aliases: aliasesForProduct(code) });
    return;
  }
  if (path === '/api/aliases/edit' && req.method === 'POST') {
    const body = await readBody(req);
    const code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
    const oldNorm = typeof body['oldNorm'] === 'string' ? (body['oldNorm'] as string) : '';
    const v = validateAliasInput(body['alias']);
    if (!v.ok) {
      json(res, 200, { ok: false, error: v.error });
      return;
    }
    const old = getAliasRow(oldNorm);
    if (!old || old.code !== code) {
      json(res, 200, { ok: false, error: 'Alias not found.' });
      return;
    }
    if (v.norm === oldNorm) {
      updateAliasText(oldNorm, v.text); // casing/punctuation-only change
    } else {
      const clash = getAliasRow(v.norm);
      if (clash) {
        json(res, 200, {
          ok: false,
          error:
            clash.code === code
              ? 'This alias already exists for this product.'
              : 'That alias is already assigned to another product.',
        });
        return;
      }
      deleteAlias(oldNorm);
      addAlias(v.norm, code, old.desc, v.text);
    }
    json(res, 200, { ok: true, aliases: aliasesForProduct(code) });
    return;
  }
  if (path === '/api/aliases/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
    const norm = typeof body['norm'] === 'string' ? (body['norm'] as string) : '';
    const ok = deleteAlias(norm);
    json(res, 200, { ok, aliases: aliasesForProduct(code) });
    return;
  }
  if (path === '/aliases') {
    html(res, aliasPage());
    return;
  }
  if (path === '/qr') {
    html(res, qrPage());
    return;
  }
  if (path === '/match') {
    html(res, matchPage());
    return;
  }
  html(res, dashboardPage());
}

export function closeWebServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// --- QR linking page (at /qr) ---
function qrPage(): string {
  const body = qrDataUrl
    ? `<img src="${qrDataUrl}" width="320" height="320" alt="WhatsApp QR code"/>`
    : status === 'connected'
      ? `<p class="ok">Connected — <a href="/">dashboard</a> · <a href="/match">order matching</a>.</p>`
      : `<p class="muted">Preparing QR… this page refreshes automatically.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Link WhatsApp</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:48px auto;text-align:center;color:#111;padding:0 16px}img{border:1px solid #eee;border-radius:12px;padding:12px}.ok{color:#0a7d33;font-size:18px}.muted{color:#666}.s{margin-top:16px;color:#666;font-size:14px}</style></head><body><h2>Link WhatsApp (read-only)</h2>${body}<p class="s">On the phone: WhatsApp → Linked devices → Link a device</p></body></html>`;
}

// --- Kanban dashboard (at /) ---
function dashboardPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Order Command Center</title>
<style>
  :root{color-scheme:light}*{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f0f2f5;color:#111b21}
  header{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:#fff;z-index:2;box-shadow:0 1px 3px #0000001a}
  header h1{font-size:16px;margin:0;font-weight:700}
  .dot{width:9px;height:9px;border-radius:50%;background:#d97706;box-shadow:0 0 0 3px rgba(217,119,6,.15)}
  .dot.ok{background:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.15)}
  .conn{font-size:13px;color:#667781}.spacer{flex:1}.meta{font-size:12px;color:#667781}
  .navlink{color:#2563eb;text-decoration:none;font-size:13px;margin-left:14px;font-weight:600}
  .board{display:grid;grid-template-columns:repeat(5,minmax(240px,1fr));gap:14px;padding:16px;overflow-x:auto}
  .col{background:#fff;border:1px solid #e5e7eb;border-radius:12px;display:flex;flex-direction:column;min-height:120px;box-shadow:0 1px 2px #0000000f}
  .col h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;margin:0;padding:12px 14px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;color:#667781}
  .col h2 .n{background:#eef2f6;color:#475569;border-radius:10px;padding:0 8px;font-size:11px;line-height:18px}
  .col .items{padding:10px;display:flex;flex-direction:column;gap:10px}
  .card{background:#fff;border:1px solid #e5e7eb;border-left:3px solid var(--ac);border-radius:10px;padding:10px 12px;box-shadow:0 1px 2px #0000000f}
  .card .r1{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;color:#667781}
  .card .oid{font-family:ui-monospace,monospace}.card .cust{font-weight:600;margin:4px 0 2px;font-size:14px}
  .card .grp{font-size:11px;color:#667781;margin-bottom:6px}.card .txt{font-size:13px;color:#334155;line-height:1.35}
  .card .chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
  .chip{background:#eef2f6;border:1px solid #e5e7eb;border-radius:6px;padding:1px 6px;font-size:11px;color:#475569}
  .card .foot{display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:#667781}
  .empty{color:#94a3b8;font-size:12px;text-align:center;padding:18px 0}a{color:#2563eb}
</style></head><body>
<header><div class="dot" id="dot"></div><h1>Order Command Center</h1><span class="conn" id="conn">connecting…</span><div class="spacer"></div><span class="meta" id="meta"></span><a class="navlink" href="/aliases">Aliases</a><a class="navlink" href="/match">Order Matching →</a></header>
<div class="board" id="board"></div>
<script>
const COLS=[["new","New Orders","#3b82f6"],["discussion","Discussion","#f59e0b"],["waiting_customer","Waiting Customer","#fb923c"],["waiting_warehouse","Waiting Warehouse","#a78bfa"],["finalized","Finalized","#22c55e"]];
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ago=ts=>{if(!ts)return"";let s=Math.floor(Date.now()/1000)-ts;if(s<60)return s+"s";if(s<3600)return Math.floor(s/60)+"m";if(s<86400)return Math.floor(s/3600)+"h";return Math.floor(s/86400)+"d";};
const shortGrp=g=>String(g||"").replace(/@.*$/,"").slice(-10);
function card(o){const ac=(COLS.find(c=>c[0]===o.status)||["","","#334"])[2];const last=o.messages&&o.messages.length?o.messages[o.messages.length-1]:null;const preview=o.summary||(last&&(last.text||last.replyToText||("["+last.kind+"]")))||"";const chips=(o.items||[]).slice(0,6).map(i=>'<span class="chip">'+esc(((i.quantity?i.quantity+" ":"")+i.product))+'</span>').join("");return '<div class="card" style="--ac:'+ac+'"><div class="r1"><span class="oid">#'+esc((o.id||"").slice(0,8))+'</span><span>'+ago(o.updatedTs)+' ago</span></div><div class="cust">'+esc(o.customerName||"—")+'</div><div class="grp">'+esc(shortGrp(o.groupId))+(o.jobSite?" · "+esc(o.jobSite):"")+'</div>'+(preview?'<div class="txt">'+esc(preview)+'</div>':"")+(chips?'<div class="chips">'+chips+'</div>':"")+'<div class="foot"><span>'+(o.messages?o.messages.length:0)+' msg</span>'+(o.finalizedBy?'<span>✅ '+esc(o.finalizedBy)+'</span>':'')+'</div></div>';}
async function tick(){try{const d=await(await fetch("/api/orders")).json();const ok=d.status==="connected";document.getElementById("dot").className="dot"+(ok?" ok":"");document.getElementById("conn").textContent=ok?"connected":d.status+" — link at /qr";const orders=(d.orders||[]).sort((a,b)=>b.updatedTs-a.updatedTs);document.getElementById("meta").textContent=orders.length+" orders";document.getElementById("board").innerHTML=COLS.map(([k,label])=>{const list=orders.filter(o=>o.status===k);return '<div class="col"><h2>'+label+'<span class="n">'+list.length+'</span></h2><div class="items">'+(list.length?list.map(card).join(""):'<div class="empty">—</div>')+'</div></div>';}).join("");}catch(e){document.getElementById("conn").textContent="dashboard offline";}}
tick();setInterval(tick,4000);
</script></body></html>`;
}

// --- Order Matching page (at /match) ---
function matchPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp Order Matching</title>
<style>
  :root{color-scheme:light;
    --bg:#f0f2f5;--panel:#ffffff;--card:#ffffff;--line:#e5e7eb;
    --em:#10b981;--em2:#059669;--emdim:#d1fae5;--blue:#2563eb;--amber:#d97706;--red:#dc2626;
    --tx:#111b21;--mut:#667781;--chatbg:#efeae2;--wa:#d9fdd3}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:flex;flex-direction:column;font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;background:var(--bg);color:var(--tx);overflow:hidden}
  ::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:#00000026;border-radius:6px}::-webkit-scrollbar-thumb:hover{background:#0000003d}
  header{display:flex;align-items:center;gap:12px;padding:13px 20px;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:0 1px 3px #0000001a}
  header h1{font-size:15px;margin:0;font-weight:700;letter-spacing:.2px}
  .spacer{flex:1}.navlink{color:var(--blue);text-decoration:none;font-size:13px;font-weight:600}.navlink:hover{text-decoration:underline}
  .muted{color:var(--mut);font-size:12px}
  .wrap{flex:1;display:flex;min-height:0}
  .left{width:40%;border-right:1px solid var(--line);display:flex;min-height:0}
  .chatcol{width:262px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;flex-shrink:0;min-height:0}
  .chatsearch{margin:10px;padding:9px 11px;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:9px;font-size:13px;outline:none;transition:border-color .15s}
  .chatsearch:focus{border-color:var(--blue)}
  .chatlist{flex:1;overflow-y:auto;padding:0 6px 6px}
  .more{padding:8px 12px;color:var(--mut);font-size:12px;text-align:center}
  .chatrow{padding:10px 11px;border-radius:9px;cursor:pointer;margin-top:3px;transition:background .12s}
  .chatrow:hover{background:#f5f6f6}.chatrow.active{background:#f0f2f5;box-shadow:inset 0 0 0 1px #d1d7db}
  .chatrow .t{font-weight:600;font-size:13px;display:flex;justify-content:space-between;gap:6px}
  .chatrow .p{font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
  .badge{background:var(--em);color:#04210f;border-radius:10px;font-size:10px;padding:0 6px;font-weight:700}
  .learned{background:var(--emdim);color:var(--em2);border:1px solid #a7f3d0;border-radius:10px;padding:1px 7px;font-size:11px;margin-left:6px}
  .thread{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg)}
  .threadhead{padding:11px 16px;background:var(--panel);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
  .threadhead .tt{font-weight:700;font-size:14px}
  .btn{background:var(--blue);color:#fff;border:0;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;transition:filter .15s,transform .05s,border-color .15s,color .15s;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{filter:brightness(1.08)}.btn:active{transform:translateY(1px)}.btn:disabled{opacity:.5;cursor:default;filter:none}
  .btn.green{background:var(--em)}
  .btn.ghost{background:#0000;border:1px solid var(--line);color:var(--mut)}.btn.ghost:hover{border-color:var(--blue);color:var(--blue);filter:none}
  .iconbtn{width:34px;height:34px;padding:0;justify-content:center;font-size:13px}
  .msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;background:var(--chatbg)}
  .bubble{max-width:76%;padding:9px 12px;border-radius:12px;font-size:13px;line-height:1.4;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 1px #0000001f;border:1px solid transparent;border-left:3px solid transparent;transition:box-shadow .2s,background .2s,border-color .2s}
  .in{align-self:flex-start;background:var(--card)}
  .out{align-self:flex-end;background:var(--wa)}
  .xable{cursor:pointer}.xable:hover{box-shadow:0 0 0 1px #2563eb40,0 2px 7px #0000001f}
  .bubble .who{font-size:11px;color:var(--em2);margin-bottom:3px;font-weight:700}
  .bubble .bt{display:block;font-size:10px;color:var(--mut);margin-top:4px;text-align:right}
  .bubble.ext{border-left-color:var(--em);background:#eaf7ee}
  .bubble.done{border-left-color:var(--em);background:#e9f2ec}
  .sb{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;border-radius:8px;padding:1px 7px;margin-left:6px;vertical-align:middle}
  .sb.e{background:var(--em);color:#04210f}.sb.d{background:var(--emdim);color:var(--em2);border:1px solid #a7f3d0}
  .xrow{margin-top:6px}
  .xbtn{background:#eafaf0;border:1px solid #a7f3d0;color:var(--em2);font-size:11px;font-weight:600;border-radius:8px;padding:4px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .15s,border-color .15s,color .15s}
  .xbtn:hover{background:#d1fae5;border-color:var(--em)}
  .xbtn.on{background:var(--em);border-color:var(--em);color:#04210f}
  .xbtn.done{background:#0000;border-color:var(--line);color:var(--mut)}.xbtn.done:hover{border-color:var(--em);color:var(--em2)}
  .xbtn:disabled{cursor:default;opacity:.85}
  .spin{width:11px;height:11px;border:2px solid #04210f44;border-top-color:#04210f;border-radius:50%;display:inline-block;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes flash{0%,100%{box-shadow:0 1px 1px #0000001f}30%{box-shadow:0 0 0 3px var(--em2),0 0 16px var(--em)}}
  .flash{animation:flash 1s ease}
  .right{width:60%;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:16px;background:var(--bg)}
  .sect h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut);margin:0 0 10px}
  .row{border:1px solid var(--line);border-radius:12px;margin-bottom:8px;background:var(--panel);border-left:3px solid var(--line);transition:border-color .15s,box-shadow .15s;box-shadow:0 1px 2px #0000000f;overflow:hidden}
  .row.matched{border-left-color:var(--em)}.row.unmatched{border-left-color:var(--amber)}.row.resolved{border-left-color:var(--em)}
  .row.open{box-shadow:0 2px 8px #00000014}
  .row .top{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer}
  .row .top:hover{background:#f9fbfd}
  .qty{width:52px;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:6px;font-size:13px;text-align:center;outline:none;flex-shrink:0}
  .qty:focus{border-color:var(--blue)}
  .pinfo{flex:1;min-width:0}
  .pmain{font-size:13px;line-height:1.4;word-break:break-word}
  .cust{font-size:11px;color:var(--mut);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cust b{color:var(--em2);font-weight:600}
  .code{color:var(--blue);font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;font-weight:600}
  .sep{color:var(--mut);margin:0 3px}
  .stock{display:inline-block;font-size:10px;font-weight:700;border-radius:10px;padding:1px 7px;white-space:nowrap;vertical-align:middle;background:var(--emdim);color:var(--em2);border:1px solid #a7f3d0}
  .stock.low{background:#fef3c7;color:#b45309;border-color:#fcd34d}
  .stock.out{background:#fde8e8;color:var(--red);border-color:#f6b9b9}
  .exp{color:var(--mut);font-size:11px;flex-shrink:0;transition:transform .2s,color .2s}
  .row.open .exp{transform:rotate(90deg);color:var(--blue)}
  .expand{max-height:0;opacity:0;overflow:hidden;transition:max-height .25s ease,opacity .25s ease}
  .expand.show{max-height:320px;opacity:1}
  .expand .inner{padding:0 12px 12px}
  .psearch{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:8px 10px;font-size:13px;outline:none;transition:border-color .15s}
  .psearch:focus{border-color:var(--blue)}
  .results{margin-top:8px;max-height:220px;overflow-y:auto;border:1px solid var(--line);border-radius:8px}
  .opt{display:block;width:100%;text-align:left;background:#fff;border:0;border-bottom:1px solid var(--line);color:var(--tx);padding:8px 10px;font-size:12px;cursor:pointer}
  .opt:last-child{border-bottom:0}.opt:hover{background:#eef4fb}
  .opt .code{margin-right:2px}
  .noopt{padding:9px 10px;color:var(--mut);font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 9px;border-bottom:1px solid var(--line)}
  th{color:var(--mut);font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .finalbox{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;box-shadow:0 2px 8px #0000001a}
  .finalbox .h{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px}
  .finalbox .h h2{font-size:14px;margin:0;font-weight:700}
  .rmfinal{border:0;background:none;color:var(--mut);cursor:pointer;font-size:14px;line-height:1;padding:3px 7px;border-radius:6px;transition:background .12s,color .12s}
  .rmfinal:hover{background:#fee2e2;color:#dc2626}
  .placeholder{color:var(--mut);text-align:center;padding:34px 16px;font-size:13px;line-height:1.6}
</style></head><body>
<header><h1>WhatsApp Order Matching</h1><span class="muted" id="catmeta"></span><div class="spacer"></div><a class="navlink" href="/aliases">Aliases</a><a class="navlink" href="/">← Dashboard</a></header>
<div class="wrap">
  <div class="left">
    <div class="chatcol"><input id="chatsearch" class="chatsearch" placeholder="search chats…" autocomplete="off"><div class="chatlist" id="chatlist"></div></div>
    <div class="thread">
      <div class="threadhead"><span id="threadtitle" class="muted">Select a chat</span><button class="btn iconbtn ghost" id="renamebtn" disabled title="Rename this chat">&#9998;</button><div class="spacer"></div><span class="muted" id="navlabel" style="display:none">extracted</span><button class="btn iconbtn ghost" id="navprev" title="Previous extracted message">&#9650;</button><button class="btn iconbtn ghost" id="navnext" title="Next extracted message">&#9660;</button></div>
      <div class="msgs" id="msgs"><div class="placeholder">Pick a conversation on the left.</div></div>
    </div>
  </div>
  <div class="right" id="right"><div class="placeholder">Click <b>Extract</b> on any customer message to add its products here.</div></div>
</div>
<script>
var chats=[],curChat=null,items=[],active={},sources=[],proc={},openIdx=null;
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function debounce(fn,ms){var t;return function(){var a=arguments,x=this;clearTimeout(t);t=setTimeout(function(){fn.apply(x,a);},ms);};}
function cssq(s){return window.CSS&&CSS.escape?CSS.escape(s):s;}
function stockBadge(p){if(!p||p.stock==null)return '';var s=+p.stock||0;var cls=s<=0?'out':(s<=5?'low':'');var n=Number.isInteger(s)?s:Math.round(s*100)/100;var txt=s<=0?'out of stock':(n.toLocaleString()+' in stock');return ' <span class="stock '+cls+'">'+txt+'</span>';}
function fmt(p){var d=p.description||"";if(d.length>62)d=d.slice(0,62)+"…";return '<span class="code">'+esc(p.code)+'</span><span class="sep">—</span>'+esc(d)+stockBadge(p);}
function isOut(m){return m.outgoing!=null?!!m.outgoing:(m.fromMe||/warehouse/i.test(m.pushName||""));}
function isBareUrl(s){s=String(s||"").trim().toLowerCase();return (s.indexOf("http://")===0||s.indexOf("https://")===0)&&s.indexOf(" ")<0&&s.indexOf("\\n")<0;}

async function loadCat(){try{var d=await(await fetch("/api/products/count")).json();el("catmeta").textContent=(d.count||0).toLocaleString()+" products · "+(d.aliases||0)+" learned";}catch(e){}}
async function loadChats(){try{var d=await(await fetch("/api/chats")).json();chats=d.chats||[];renderChats();}catch(e){}}
function renderChats(){var q=((el("chatsearch")&&el("chatsearch").value)||"").toLowerCase().trim();var list=q?chats.filter(function(c){return (String(c.title||"").toLowerCase().indexOf(q)>=0)||(String(c.id||"").toLowerCase().indexOf(q)>=0);}):chats;var capped=list.slice(0,300);var more=list.length-capped.length;var html=capped.length?capped.map(function(c){return '<div class="chatrow'+(c.id===curChat?" active":"")+'" data-id="'+esc(c.id)+'"><div class="t"><span>'+(c.isGroup?"👥 ":"")+esc(c.title||c.id)+'</span>'+(c.unread>0?'<span class="badge">'+c.unread+'</span>':"")+'</div><div class="p">'+esc(c.lastText||"")+'</div></div>';}).join(""):'<div class="placeholder">'+(chats.length?"No chats match.":"Loading chats…")+'</div>';if(more>0)html+='<div class="more">+'+more+' more — refine search</div>';el("chatlist").innerHTML=html;}
async function selectChat(id){curChat=id;items=[];active={};sources=[];proc={};navIdx=-1;renderChats();el("renamebtn").disabled=false;var t=(chats.find(function(c){return c.id===id;})||{}).title||id;el("threadtitle").textContent=t;el("threadtitle").className="tt";var d=await(await fetch("/api/chats/"+encodeURIComponent(id)+"/messages")).json();var ms=d.messages||[];el("msgs").innerHTML=ms.length?ms.map(function(m){var out=isOut(m);var body=m.text||(m.hasMedia?("["+(m.kind||"media")+"]"):("["+(m.kind||"msg")+"]"));var tm=m.ts?new Date(m.ts*1000).toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"";var xable=(!out&&m.text&&!isBareUrl(m.text));if(xable&&m.processed)proc[m.messageId]=true;var mid=esc(m.messageId);var inner=(out?"":'<div class="who">'+esc(m.pushName||"customer")+'</div>')+esc(body)+'<span class="bt">'+tm+'<span class="sb" style="display:none"></span></span>'+(xable?'<div class="xrow"><button class="xbtn" data-mid="'+mid+'">Extract</button></div>':"");return '<div class="bubble '+(out?"out":"in")+(xable?" xable":"")+'" data-mid="'+mid+'">'+inner+'</div>';}).join(""):'<div class="placeholder">No messages captured for this chat yet. Messages are stored from the moment they arrive; older history is not available.</div>';applyStates();renderRight();var mb=el("msgs");mb.scrollTop=mb.scrollHeight;}

function rebuildSources(){sources=Object.keys(active).map(function(m){return {messageId:m,text:active[m]};});}
// Single source of truth for message visual state: extracted (active) vs processed (proc) vs plain.
function applyStates(){
  var bubbles=document.querySelectorAll(".msgs .xable");
  for(var i=0;i<bubbles.length;i++){
    var b=bubbles[i],mid=b.dataset.mid,on=!!active[mid],done=!!proc[mid],busy=b.classList.contains("busy");
    b.classList.toggle("ext",on);
    b.classList.toggle("done",done&&!on);
    var sb=b.querySelector(".sb");
    if(sb){if(on){sb.className="sb e";sb.textContent="Extracted";sb.style.display="";}
      else if(done){sb.className="sb d";sb.textContent="✓ Processed";sb.style.display="";}
      else{sb.style.display="none";sb.textContent="";}}
    var btn=b.querySelector(".xbtn");
    if(btn&&!busy){btn.disabled=false;btn.classList.toggle("on",on);btn.classList.toggle("done",done&&!on);
      btn.textContent=on?"Extracted ✓":(done?"Re-Extract":"Extract");}
  }
  var any=document.querySelectorAll(".msgs .bubble.ext, .msgs .bubble.done").length;
  el("navlabel").style.display=any?"":"none";
}
// Toggle one message: OFF removes only that message's items; ON appends its items (others untouched).
async function toggleExtract(mid){
  var b=document.querySelector('.xable[data-mid="'+cssq(mid)+'"]');
  if(active[mid]){delete active[mid];items=items.filter(function(it){return it.mid!==mid;});rebuildSources();renderRight();applyStates();return;}
  if(b)b.classList.add("busy");
  var btn=b&&b.querySelector(".xbtn");
  if(btn){btn.disabled=true;btn.className="xbtn on";btn.innerHTML='<span class="spin"></span>Extracting…';}
  try{
    var d=await(await fetch("/api/extract",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chatId:curChat,messageId:mid})})).json();
    active[mid]=(d.sources&&d.sources[0]&&d.sources[0].text)||"(no text)";
    var add=(d.items||[]).map(function(it){return {mid:mid,phrase:it.phrase,quantity:it.quantity||"1",matched:it.matched,chosen:it.matched||null,suggestions:it.suggestions||[],results:[]};});
    items=items.concat(add);rebuildSources();renderRight();
  }catch(e){}
  finally{if(b)b.classList.remove("busy");applyStates();}
}
// Whole bubble is the extract trigger (button included, since it lives inside .xable).
el("msgs").addEventListener("click",function(e){var b=e.target.closest(".xable");if(b&&!b.classList.contains("busy"))toggleExtract(b.dataset.mid);});
// Jump between extracted/processed messages in a long thread.
var navIdx=-1;
function navExtracted(dir){var list=Array.prototype.slice.call(document.querySelectorAll(".msgs .bubble.ext, .msgs .bubble.done"));if(!list.length)return;navIdx+=dir;if(navIdx<0)navIdx=list.length-1;if(navIdx>=list.length)navIdx=0;var t=list[navIdx];t.scrollIntoView({behavior:"smooth",block:"center"});t.classList.remove("flash");void t.offsetWidth;t.classList.add("flash");}
el("navprev").addEventListener("click",function(){navExtracted(-1);});
el("navnext").addEventListener("click",function(){navExtracted(1);});

el("renamebtn").addEventListener("click",async function(){if(!curChat)return;var cur=(chats.find(function(c){return c.id===curChat;})||{}).title||"";var name=window.prompt("Chat name:",cur);if(!name||!name.trim())return;await fetch("/api/chats/rename",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chatId:curChat,name:name.trim()})});await loadChats();el("threadtitle").textContent=name.trim();});

el("chatlist").addEventListener("click",function(e){var r=e.target.closest(".chatrow");if(r)selectChat(r.dataset.id);});
el("chatsearch").addEventListener("input",renderChats);

// One compact row: qty + primary line; chosen rows also show "↳ Customer wrote: <text>".
// The whole header is clickable to expand an inline search (accordion, one open at a time).
function rowHtml(i){
  var it=items[i],ch=it.chosen;
  var cls=ch?(it.matched?"matched":"resolved"):"unmatched";
  var head=ch
    ? '<div class="pinfo"><div class="pmain">'+fmt(ch)+'</div><div class="cust">&#8627; <b>Customer wrote:</b> '+esc(it.phrase)+(it.learned?' <span class="learned">learned &#10003;</span>':'')+'</div></div>'
    : '<div class="pinfo"><div class="pmain">'+esc(it.phrase)+'</div></div>';
  var top='<div class="top" data-idx="'+i+'"><input class="qty" data-idx="'+i+'" value="'+esc(it.quantity)+'">'+head+'<span class="exp">&#9656;</span></div>';
  var body='<div class="expand"><div class="inner"><input class="psearch" data-idx="'+i+'" placeholder="search products…" autocomplete="off"><div class="results" data-res="'+i+'"></div></div></div>';
  return '<div class="row '+cls+'" data-row="'+i+'">'+top+body+'</div>';
}
function renderRight(){
  openIdx=null;
  if(!items.length){el("right").innerHTML='<div class="placeholder">'+(sources.length?"No products found in the selected message(s).":"Click Extract on a customer message to begin.")+'</div>';return;}
  var matched=[],unmatched=[];
  items.forEach(function(it,i){(it.chosen?matched:unmatched).push(i);});
  var h='<div class="sect"><h2>Matched ('+matched.length+')</h2>';
  h+=matched.length?matched.map(rowHtml).join(""):'<div class="muted" style="font-size:12px;padding:0 2px 8px">None yet — resolve items below.</div>';
  h+='</div><div class="sect"><h2>Unmatched ('+unmatched.length+')</h2>';
  h+=unmatched.length?unmatched.map(rowHtml).join(""):'<div class="muted" style="font-size:12px;padding:0 2px 8px">All items matched.</div>';
  h+='</div><div class="finalbox"><div class="h"><h2>Final Order</h2><button class="btn green" id="copybtn">Copy</button></div><table><thead><tr><th style="width:54px">Qty</th><th style="width:118px">SKU</th><th>Product</th><th style="width:30px" aria-label="remove"></th></tr></thead><tbody id="finalbody"></tbody></table></div>';
  el("right").innerHTML=h;
  updateFinal();
}
// Accordion: expand one row's inline search, fade/slide in, auto-focus, collapse any other.
function renderResults(i,list){var box=el("right").querySelector('.results[data-res="'+i+'"]');if(!box)return;box.innerHTML=(list&&list.length)?list.slice(0,5).map(function(p){return '<button class="opt" data-idx="'+i+'" data-code="'+esc(p.code)+'">'+fmt(p)+'</button>';}).join(""):'<div class="noopt">No suggestions — type to search.</div>';}
function collapseRow(){if(openIdx==null)return;var row=el("right").querySelector('.row[data-row="'+openIdx+'"]');if(row){row.classList.remove("open");var ex=row.querySelector(".expand");if(ex)ex.classList.remove("show");}openIdx=null;}
function expandRow(i){
  if(openIdx===i){collapseRow();return;}
  collapseRow();openIdx=i;
  var row=el("right").querySelector('.row[data-row="'+i+'"]');if(!row)return;
  row.classList.add("open");
  var ex=row.querySelector(".expand");void ex.offsetWidth;ex.classList.add("show"); // reflow → transition = fade/slide in
  renderResults(i,items[i].suggestions||[]);
  var ps=row.querySelector(".psearch");if(ps)ps.focus();
}
function findProduct(i,code){var it=items[i];var pool=(it.results||[]).concat(it.suggestions||[]);for(var k=0;k<pool.length;k++)if(pool[k].code===code)return pool[k];return null;}
function choose(i,code){var p=findProduct(i,code);if(!p)return;var learn=!items[i].matched;items[i].chosen=p;items[i].learned=learn;if(learn){fetch("/api/alias",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phrase:items[i].phrase,code:p.code,description:p.description})}).then(function(){loadCat();}).catch(function(){});}openIdx=null;renderRight();}
function updateFinal(){var body=el("finalbody");if(!body)return;var html="";items.forEach(function(it,i){if(!it.chosen)return;html+='<tr><td>'+esc(it.quantity)+'</td><td><span class="code">'+esc(it.chosen.code)+'</span></td><td>'+esc(it.chosen.description)+stockBadge(it.chosen)+'</td><td style="text-align:right"><button class="rmfinal" data-idx="'+i+'" title="Remove — move back to Unmatched" aria-label="Remove">&#10005;</button></td></tr>';});body.innerHTML=html||'<tr><td colspan="4" class="muted">Resolve products to build the order.</td></tr>';}

// Typing in a row's search: <2 chars falls back to its suggestions; else live catalog search into .results.
var doSearch=debounce(async function(i,q){if(!q||q.length<2){renderResults(i,items[i].suggestions||[]);return;}try{var d=await(await fetch("/api/products/search?limit=6&q="+encodeURIComponent(q))).json();items[i].results=d.results||[];var box=el("right").querySelector('.results[data-res="'+i+'"]');if(box)box.innerHTML=items[i].results.length?items[i].results.map(function(p){return '<button class="opt" data-idx="'+i+'" data-code="'+esc(p.code)+'">'+fmt(p)+'</button>';}).join(""):'<div class="noopt">No matches.</div>';}catch(e){}},220);

el("right").addEventListener("input",function(e){var t=e.target;if(t.classList.contains("qty")){items[t.dataset.idx].quantity=t.value;updateFinal();}else if(t.classList.contains("psearch")){doSearch(t.dataset.idx,t.value);}});
el("right").addEventListener("click",function(e){
  var o=e.target.closest(".opt");if(o){choose(o.dataset.idx,o.dataset.code);return;}
  var rm=e.target.closest(".rmfinal");if(rm){var ri=+rm.dataset.idx;if(items[ri]){items[ri].chosen=null;items[ri].learned=false;}renderRight();return;}
  if(e.target.closest("#copybtn")){copyCsv();return;}
  if(e.target.closest(".psearch")||e.target.closest(".expand"))return; // don't toggle when interacting inside the open panel
  var top=e.target.closest(".top");
  if(top&&!e.target.closest(".qty"))expandRow(+top.dataset.idx);
});
// Copy = complete the order: copy "qty,SKU", mark every extracted message Processed, then reset the panel.
async function copyCsv(){
  var rows=items.filter(function(it){return it.chosen;});
  // Nothing resolved → don't copy an empty order and (crucially) don't mark messages processed.
  if(!rows.length){var cb=el("copybtn");if(cb){var o=cb.textContent;cb.textContent="Resolve a product first";setTimeout(function(){cb.textContent=o;},1600);}return;}
  var csv=rows.map(function(it){return (it.quantity||"1")+","+it.chosen.code;}).join("\\n");
  try{await navigator.clipboard.writeText(csv);}catch(e){}
  var mids=Object.keys(active),cnt=mids.length;
  if(!cnt)return;
  var saveItems=rows.map(function(it){return {qty:it.quantity||"1",code:it.chosen.code,description:it.chosen.description,phrase:it.phrase};});
  try{await fetch("/api/save",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chatId:curChat,sources:sources,items:saveItems})});}catch(e){}
  mids.forEach(function(m){proc[m]=true;});
  active={};items=[];rebuildSources();applyStates();
  el("right").innerHTML='<div class="placeholder"><b style="color:var(--em2)">✓ Copied to clipboard</b><br>'+rows.length+' line item(s) · '+cnt+' message(s) marked <b>Processed</b>.<br><span class="muted">Click Extract on a message to start a new order.</span></div>';
}

loadCat();loadChats();setInterval(loadChats,6000);
</script></body></html>`;
}

// --- Product Alias Management page (at /aliases) ---
function aliasPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Product Alias Management</title>
<style>
  :root{color-scheme:light;
    --bg:#f0f2f5;--panel:#ffffff;--line:#e5e7eb;
    --em:#10b981;--em2:#059669;--emdim:#d1fae5;--blue:#2563eb;--amber:#d97706;--red:#dc2626;
    --tx:#111b21;--mut:#667781}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;background:var(--bg);color:var(--tx)}
  ::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:#00000026;border-radius:6px}
  header{display:flex;align-items:center;gap:12px;padding:13px 20px;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:0 1px 3px #0000001a;position:sticky;top:0;z-index:5}
  header h1{font-size:16px;margin:0;font-weight:700}
  .spacer{flex:1}.navlink{color:var(--blue);text-decoration:none;font-size:13px;font-weight:600}.navlink:hover{text-decoration:underline}
  .muted{color:var(--mut);font-size:12px}
  .wrap{max-width:1000px;margin:0 auto;padding:20px 18px}
  .toolbar{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
  .search{flex:1;min-width:220px;position:relative}
  .search input{width:100%;padding:11px 13px 11px 34px;background:var(--panel);border:1px solid var(--line);color:var(--tx);border-radius:10px;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}
  .search input:focus{border-color:var(--blue);box-shadow:0 0 0 3px #2563eb1f}
  .search .ic{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--mut);font-size:15px}
  .count{font-size:13px;color:var(--mut);white-space:nowrap}
  .cardbox{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 2px 8px #0000000f}
  table{width:100%;border-collapse:collapse;font-size:14px}
  thead th{text-align:left;padding:11px 14px;background:#f8fafc;border-bottom:1px solid var(--line);color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}
  tbody td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
  tbody tr:last-child td{border-bottom:0}tbody tr{transition:background .12s}tbody tr:hover{background:#f7f9fc}
  .sku{font-family:ui-monospace,SFMono-Regular,monospace;color:var(--blue);font-weight:600;font-size:13px}
  .pill{display:inline-block;min-width:26px;text-align:center;background:var(--emdim);color:var(--em2);border:1px solid #a7f3d0;border-radius:20px;padding:2px 10px;font-size:12px;font-weight:700}
  .pill.zero{background:#f1f5f9;color:var(--mut);border-color:var(--line)}
  .tright{text-align:right}
  .btn{background:var(--blue);color:#fff;border:0;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;transition:filter .15s,transform .05s;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{filter:brightness(1.08)}.btn:active{transform:translateY(1px)}.btn:disabled{opacity:.5;cursor:default;filter:none}
  .btn.sm{padding:6px 12px;font-size:12px}
  .btn.green{background:var(--em)}.btn.ghost{background:#0000;border:1px solid var(--line);color:var(--mut)}.btn.ghost:hover{border-color:var(--blue);color:var(--blue)}
  .btn.danger{background:var(--red)}
  .pager{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 4px;font-size:13px;color:var(--mut)}
  .pager .pg{display:flex;gap:8px;align-items:center}
  .empty{padding:40px 16px;text-align:center;color:var(--mut);font-size:14px;line-height:1.6}
  .spinner{width:22px;height:22px;border:3px solid #0000001a;border-top-color:var(--blue);border-radius:50%;display:inline-block;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .loadrow{padding:34px;text-align:center}
  .prow{cursor:pointer}
  .prow .chev{display:inline-block;color:var(--mut);font-size:12px;transition:transform .22s,color .22s}
  .prow.open{background:#eef4fb}.prow.open:hover{background:#eef4fb}.prow.open .chev{transform:rotate(90deg);color:var(--blue)}
  .drow>td{padding:0;border-bottom:1px solid var(--line);background:#f8fafc}
  .detail{opacity:0;transform:translateY(-6px);transition:opacity .3s ease,transform .3s ease}
  .detail.show{opacity:1;transform:translateY(0)}
  .detail .inner{padding:14px 16px}
  .detail h3{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--mut);margin:0 0 10px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;min-height:22px;align-items:center}
  .chip{display:inline-flex;align-items:center;gap:5px;background:#f8fafc;border:1px solid var(--line);border-radius:20px;padding:5px 6px 5px 12px;font-size:13px;transition:border-color .12s,box-shadow .12s}
  .chip:hover{border-color:#c9d3e0;box-shadow:0 1px 3px #0000000f}
  .chip .txt{color:var(--tx)}
  .chip .ib{background:#0000;border:0;cursor:pointer;font-size:12px;line-height:1;padding:3px 4px;border-radius:50%;color:var(--mut)}
  .chip .ib:hover{background:#e8eef7;color:var(--blue)}
  .chip .ib.del:hover{background:#fde8e8;color:var(--red)}
  .chip input{border:1px solid var(--blue);border-radius:14px;padding:3px 8px;font-size:13px;outline:none;width:130px}
  .padd{margin-top:16px;display:flex;gap:8px}
  .padd input{flex:1;padding:9px 11px;background:#f8fafc;border:1px solid var(--line);color:var(--tx);border-radius:9px;font-size:13px;outline:none}
  .padd input:focus{border-color:var(--blue)}
  .pempty{color:var(--mut);font-size:13px;padding:8px 0}
  .toasts{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:40}
  .toast{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--em);border-radius:10px;padding:11px 14px;font-size:13px;box-shadow:0 4px 14px #00000022;min-width:220px;max-width:340px;animation:slidein .2s ease}
  .toast.err{border-left-color:var(--red)}
  @keyframes slidein{from{transform:translateX(20px);opacity:0}to{transform:translateX(0);opacity:1}}
  .modal{position:fixed;inset:0;background:#0f172a66;display:none;align-items:center;justify-content:center;z-index:50;padding:16px}
  .modal.on{display:flex}
  .modal .box{background:var(--panel);border-radius:14px;padding:20px;max-width:360px;width:100%;box-shadow:0 12px 40px #00000033}
  .modal h4{margin:0 0 8px;font-size:16px}
  .modal p{margin:0 0 18px;color:var(--mut);font-size:14px;line-height:1.5;word-break:break-word}
  .modal .r{display:flex;justify-content:flex-end;gap:10px}
</style></head><body>
<header><h1>Product Alias Management</h1><span class="muted" id="stat"></span><div class="spacer"></div><a class="navlink" href="/match">Order Matching</a><a class="navlink" href="/" style="margin-left:14px">Dashboard</a></header>
<div class="wrap">
  <div class="toolbar">
    <div class="search"><span class="ic">&#9906;</span><input id="q" placeholder="Search by SKU, product name, or alias…" autocomplete="off"></div>
    <span class="count" id="count"></span>
  </div>
  <div class="cardbox"><table><thead><tr><th style="width:150px">SKU</th><th>Product Name</th><th style="width:96px">Aliases</th><th style="width:104px" class="tright">Actions</th></tr></thead><tbody id="tbody"></tbody></table></div>
  <div class="pager"><span id="pinfo"></span><span class="pg"><button class="btn ghost sm" id="prev">&#8249; Prev</button><button class="btn ghost sm" id="next">Next &#8250;</button></span></div>
</div>
<div class="toasts" id="toasts"></div>
<div class="modal" id="modal"><div class="box"><h4>Delete alias?</h4><p id="mText"></p><div class="r"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn danger" id="mOk">Delete</button></div></div></div>
<script>
var q="",page=1,limit=25,total=0,curCode=null,curAliases=[],curDetail=null;
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function debounce(fn,ms){var t;return function(){var a=arguments,x=this;clearTimeout(t);t=setTimeout(function(){fn.apply(x,a);},ms);};}
function toast(msg,type){var t=document.createElement('div');t.className='toast'+(type==='err'?' err':'');t.textContent=msg;el('toasts').appendChild(t);setTimeout(function(){t.style.transition='opacity .3s';t.style.opacity='0';setTimeout(function(){t.remove();},300);},2600);}
async function post(url,body){try{return await(await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();}catch(e){return {ok:false,error:'Network error'};}}

async function loadList(){
  curCode=null;curDetail=null; // any expanded row is destroyed when tbody re-renders
  el('tbody').innerHTML='<tr><td colspan="4" class="loadrow"><span class="spinner"></span></td></tr>';
  try{
    var d=await(await fetch('/api/aliases?q='+encodeURIComponent(q)+'&page='+page+'&limit='+limit)).json();
    total=d.total||0;var rows=d.rows||[];
    if(!rows.length){el('tbody').innerHTML='<tr><td colspan="4"><div class="empty">'+(q?'No products match &ldquo;'+esc(q)+'&rdquo;.':'No products have aliases yet.<br>Search for a product above to add its first alias.')+'</div></td></tr>';}
    else{el('tbody').innerHTML=rows.map(function(r){var z=r.count?'':' zero';return '<tr class="prow" data-code="'+esc(r.code)+'" data-name="'+esc(r.description||'')+'"><td><span class="sku">'+esc(r.code||'—')+'</span></td><td>'+esc(r.description||'')+'</td><td><span class="pill'+z+'">'+r.count+'</span></td><td class="tright"><span class="chev">&#9656;</span></td></tr>';}).join('');}
    var pages=Math.max(1,Math.ceil(total/limit));
    el('pinfo').textContent=total?('Page '+page+' of '+pages+' · '+total+' product'+(total===1?'':'s')):'';
    el('count').textContent=total?(total+' result'+(total===1?'':'s')):'';
    el('prev').disabled=page<=1;el('next').disabled=page>=pages;
  }catch(e){el('tbody').innerHTML='<tr><td colspan="4"><div class="empty">Failed to load. Is the service running?</div></td></tr>';}
}
async function loadStat(){try{var d=await(await fetch('/api/products/count')).json();el('stat').textContent=(d.count||0).toLocaleString()+' products · '+(d.aliases||0)+' aliases';}catch(e){}}
function updateRowCount(code,n){var rows=el('tbody').querySelectorAll('tr[data-code]');for(var i=0;i<rows.length;i++){if(rows[i].getAttribute('data-code')===code){var p=rows[i].querySelector('.pill');if(p){p.textContent=n;p.className='pill'+(n?'':' zero');}return;}}}

el('q').addEventListener('input',debounce(function(){q=el('q').value.trim();page=1;loadList();},250));
el('prev').addEventListener('click',function(){if(page>1){page--;loadList();}});
el('next').addEventListener('click',function(){page++;loadList();});
// Click a product row to expand its aliases inline (accordion: one open at a time, fade in/out).
el('tbody').addEventListener('click',function(e){var tr=e.target.closest('.prow');if(tr)toggleRow(tr);});

function collapse(){
  if(!curDetail)return;
  var d=curDetail,dt=d.querySelector('.detail');
  var openTr=el('tbody').querySelector('.prow.open');if(openTr)openTr.classList.remove('open');
  if(dt)dt.classList.remove('show');               // fade out
  setTimeout(function(){if(d.parentNode)d.parentNode.removeChild(d);},300);
  curDetail=null;curCode=null;curAliases=[];
}
function toggleRow(tr){
  var code=tr.getAttribute('data-code');
  if(curCode===code){collapse();return;}           // clicking the open row closes it
  collapse();                                        // close any other open row
  curCode=code;curAliases=[];tr.classList.add('open');
  var drow=document.createElement('tr');drow.className='drow';
  drow.innerHTML='<td colspan="4"><div class="detail"><div class="inner"><h3>Aliases (<span class="pCount">0</span>)</h3><div class="chips"><span class="spinner"></span></div><div class="pempty" style="display:none">No aliases yet — add the first one below.</div><div class="padd"><input class="newAlias" placeholder="Enter new alias…" maxlength="255" autocomplete="off"><button class="btn green addBtn">Add Alias</button></div></div></div></td>';
  tr.after(drow);curDetail=drow;
  var dt=drow.querySelector('.detail');void dt.offsetWidth;dt.classList.add('show'); // reflow commits opacity:0, then transition to 1 = fade in
  drow.querySelector('.chips').addEventListener('click',chipClick);
  drow.querySelector('.addBtn').addEventListener('click',addAlias);
  drow.querySelector('.newAlias').addEventListener('keydown',function(e){if(e.key==='Enter')addAlias();});
  loadAliases(code);
}
async function loadAliases(code){try{var d=await(await fetch('/api/aliases/product?code='+encodeURIComponent(code))).json();if(curCode!==code)return;curAliases=d.aliases||[];renderChips();}catch(e){if(curDetail)curDetail.querySelector('.chips').innerHTML='';toast('Failed to load aliases','err');}}
function renderChips(){
  if(!curDetail)return;
  curDetail.querySelector('.pCount').textContent=curAliases.length;
  curDetail.querySelector('.pempty').style.display=curAliases.length?'none':'block';
  curDetail.querySelector('.chips').innerHTML=curAliases.map(function(a,i){return '<span class="chip" data-i="'+i+'"><span class="txt">'+esc(a.text)+'</span><button class="ib edit" title="Edit" data-i="'+i+'">&#9998;</button><button class="ib del" title="Delete" data-i="'+i+'">&#128465;</button></span>';}).join('');
  updateRowCount(curCode,curAliases.length);
}
function chipClick(e){var ed=e.target.closest('.edit');if(ed){startEdit(+ed.dataset.i);return;}var dl=e.target.closest('.del');if(dl){askDelete(+dl.dataset.i);return;}}
function startEdit(i){
  if(!curDetail)return;var chip=curDetail.querySelector('.chip[data-i="'+i+'"]');if(!chip)return;var a=curAliases[i];
  chip.innerHTML='<input value="'+esc(a.text)+'" maxlength="255"><button class="ib save" title="Save">&#10003;</button><button class="ib cancel" title="Cancel">&#10005;</button>';
  var inp=chip.querySelector('input');inp.focus();inp.select();
  function done(save){if(save){commitEdit(i,inp.value);}else{renderChips();}}
  chip.querySelector('.save').addEventListener('click',function(){done(true);});
  chip.querySelector('.cancel').addEventListener('click',function(){done(false);});
  inp.addEventListener('keydown',function(ev){if(ev.key==='Enter'){done(true);}else if(ev.key==='Escape'){done(false);}});
}
async function commitEdit(i,val){var a=curAliases[i],code=curCode;var text=val.trim();if(text===a.text){renderChips();return;}var d=await post('/api/aliases/edit',{code:code,oldNorm:a.norm,alias:text});if(d.ok){curAliases=d.aliases;renderChips();toast('Alias updated');}else{toast(d.error||'Edit failed','err');renderChips();}}
function askDelete(i){var a=curAliases[i],code=curCode;el('mText').textContent='Delete alias “'+a.text+'”?';el('modal').classList.add('on');el('mOk').onclick=async function(){el('modal').classList.remove('on');var d=await post('/api/aliases/delete',{code:code,norm:a.norm});if(d.ok){curAliases=d.aliases;renderChips();toast('Alias deleted');}else{toast('Delete failed','err');}};}
el('mCancel').addEventListener('click',function(){el('modal').classList.remove('on');});
el('modal').addEventListener('click',function(e){if(e.target===el('modal'))el('modal').classList.remove('on');});

async function addAlias(){if(!curDetail)return;var inp=curDetail.querySelector('.newAlias');var btn=curDetail.querySelector('.addBtn');var text=inp.value.trim();if(!text){toast('Alias cannot be empty','err');return;}btn.disabled=true;var d=await post('/api/aliases/add',{code:curCode,alias:text});btn.disabled=false;if(d.ok){curAliases=d.aliases;renderChips();inp.value='';inp.focus();toast('Alias added');}else{toast(d.error||'Add failed','err');}}

loadStat();loadList();
</script></body></html>`;
}
