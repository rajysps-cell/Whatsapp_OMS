import fs from 'node:fs';
import { ChatStore } from './chat-store';
import { config } from './config';
import { extractOrder, type Extraction } from './extractor';
import { logger } from './logger';
import { toMessageEvent, toReactionEvent } from './normalize';
import { OrderStore } from './order-store';
import { runProductImportWithReport } from './product-import';
import * as products from './products';
import { scheduleDailyTimes } from './scheduler';
import { saveMessage, upsertCatalog } from './store';
import { startWaClient } from './wa-client';
import { closeWebServer, setQr, setStatus, startWebServer } from './web';

/** Hours since products.csv was last written (Infinity if it's missing). */
function catalogAgeHours(): number {
  try {
    return (Date.now() - fs.statSync(config.productsCsvPath).mtimeMs) / 3_600_000;
  } catch {
    return Infinity;
  }
}

/** Wire up the daily DDI product-export import (+ a startup catch-up if the catalog is stale). */
function startProductImport(): void {
  const cfg = config.productImport;
  if (!cfg.enabled || !cfg.imapPassword) {
    logger.info('daily product import off (disabled or no PRODUCT_IMAP_PASSWORD) — using bundled products.csv');
    return;
  }
  if (cfg.catchUpHours > 0) {
    const ageH = catalogAgeHours();
    if (ageH >= cfg.catchUpHours) {
      logger.info({ ageHours: Math.round(ageH) }, 'products.csv is stale — running catch-up import now');
      void runProductImportWithReport().then((r) => logger.info({ result: r }, 'catch-up product import complete'));
    }
  }
  if (!cfg.dailyTimes.length) {
    logger.warn('PRODUCT_IMPORT_TIME is empty — no scheduled imports (manual npm run import:products still works)');
    return;
  }
  logger.info({ times: cfg.dailyTimes }, 'scheduling daily product imports');
  scheduleDailyTimes(cfg.dailyTimes, async () => {
    const r = await runProductImportWithReport();
    logger.info({ result: r }, 'scheduled product import complete');
  });
}

function main(): void {
  products.load(); // load the product catalog once at startup
  const orders = new OrderStore();
  const chats = new ChatStore();

  const client = startWaClient({
    onMessage: async (msg) => {
      const event = await toMessageEvent(msg);
      if (!event) return;
      chats.record(event);
      logger.info({ event }, 'wa-event');

      let extraction: Extraction | null = null;
      const text = event.text ?? event.media?.transcript;
      if (config.anthropicKey && text) {
        extraction = await extractOrder({
          text,
          groupName: event.groupId,
          sender: event.pushName ?? event.sender,
        });
      }

      const order = orders.ingestMessage(event, extraction);
      logger.info(
        {
          orderId: order.id,
          status: order.status,
          customer: order.customerName,
          group: order.groupId,
          items: order.items.length,
          messages: order.messages.length,
          summary: order.summary,
        },
        'order-card',
      );
    },
    onSent: async (msg) => {
      // The account's own outgoing messages: record them so warehouse replies show in history
      // and chats where our side spoke also appear. No order extraction on our own messages.
      const event = await toMessageEvent(msg);
      if (event) chats.record(event);
    },
    onReaction: async (reaction) => {
      const event = toReactionEvent(reaction);
      if (!event) return;
      logger.info({ event }, 'wa-event');
      const order = orders.ingestReaction(event);
      if (order) {
        logger.info(
          { orderId: order.id, status: order.status, finalizedBy: order.finalizedBy },
          'order-updated',
        );
      }
    },
    onQr: (qr) => {
      void setQr(qr);
    },
    onStatus: setStatus,
    onCatalog: upsertCatalog,
    // Recovered history goes straight to the messages table (dedup on msg id) — no order
    // extraction on backfill; the /match "only new messages" flow decides what to process.
    onHistory: (rows) => rows.forEach(saveMessage),
  });

  const server = startWebServer(() => orders.all(), chats);

  startProductImport(); // daily catalog refresh from the DDI export email (in-process, hot-reloads)

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'shutting down');
    await client.stop();
    await closeWebServer(server);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
