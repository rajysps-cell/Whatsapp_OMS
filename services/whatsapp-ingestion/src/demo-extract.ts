// Standalone smoke test for the extractor — no WhatsApp needed.
// Requires ANTHROPIC_API_KEY. Run: npm run demo
import { config } from './config';
import { extractOrder } from './extractor';

const SAMPLE = `38 Dodworth
14 4" NH 45   1 2" Grooved Check Valve   1 1/2 x 5 Black Nipple   1 1/2 x 3/4 Black Elbow   1 3/4 Drip Valve
Pickup in Brooklyn`;

async function main(): Promise<void> {
  if (!config.anthropicKey) {
    console.error('Set ANTHROPIC_API_KEY first (export it or put it in .env).');
    process.exit(1);
  }
  const result = await extractOrder({
    text: SAMPLE,
    groupName: 'Brooklyn Orders',
    sender: 'Mike Brown',
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
