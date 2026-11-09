import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const { app, ctx } = await buildApp({ config });

await app.listen({ port: config.port, host: config.host });
console.log(
  `Pay Inside läuft auf ${config.publicUrl} (Zahlungen: ${ctx.payments.name}, TSE: ${ctx.fiscal.name}, Umgebung: ${config.env})`,
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
