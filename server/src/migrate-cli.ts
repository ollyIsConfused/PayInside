import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';

const config = loadConfig();
const db = createDb(config.databaseUrl);
await migrate(db, (m) => console.log(m));
await db.close();
console.log('Datenbank ist aktuell.');
