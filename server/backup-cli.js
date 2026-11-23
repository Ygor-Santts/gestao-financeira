// Makes a backup right now (used by the Windows update script before updating):
//   docker compose exec -T financas node server/backup-cli.js
import { openDb } from './db.js';
import { makeBackup } from './backup.js';

const db = openDb(process.env.DB_FILE || '/data/financas.db');
const r = makeBackup(db);
console.log(`Backup feito: ${r.json}`);
db.close();
