// Automatic backups: a JSON (restorable in the app, Mais › Backup) and a copy of the
// database file, one of each per day, kept for 30 days.
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { backup } from './api.js';
import { now } from './clock.js';

export const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const KEEP_DAYS = 30;
const NAME = /^financas-(\d{4}-\d{2}-\d{2})\.(json|db)$/;

export function makeBackup(db, dir = BACKUP_DIR) {
  mkdirSync(dir, { recursive: true });
  const day = now().date;
  const json = join(dir, `financas-${day}.json`);
  const file = join(dir, `financas-${day}.db`);
  writeFileSync(json, JSON.stringify(backup(db)));
  if (existsSync(file)) unlinkSync(file);
  // VACUUM INTO writes a consistent copy even while the app is in use.
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  prune(dir);
  return { day, json, db: file };
}

export function listBackups(dir = BACKUP_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => NAME.test(f)).map((f) => {
    const st = statSync(join(dir, f));
    return { name: f, day: f.match(NAME)[1], kind: f.match(NAME)[2], size: st.size };
  }).sort((a, b) => (a.name < b.name ? 1 : -1));
}

function prune(dir) {
  const files = listBackups(dir);
  const days = [...new Set(files.map((f) => f.day))].sort().reverse();
  const keep = new Set(days.slice(0, KEEP_DAYS));
  for (const f of files) if (!keep.has(f.day)) unlinkSync(join(dir, f.name));
}

export function backupPath(name, dir = BACKUP_DIR) {
  return NAME.test(name) ? join(dir, name) : null;
}
