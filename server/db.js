// SQLite database (node:sqlite, built into Node 22). One file, kept in a Docker volume.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const TYPES = ['entrada', 'saida', 'investimento', 'transferencia'];

export const DEFAULT_CATEGORIES = [
  // [name, group, color]
  ['Salário PJ', 'entrada', '#16a34a'],
  ['Salário CLT', 'entrada', '#22c55e'],
  ['Outros recebimentos', 'entrada', '#4ade80'],
  ['Estornos e reembolsos', 'entrada', '#86efac'],
  ['Cartões de crédito', 'gasto', '#f97316'],
  ['Moradia', 'gasto', '#3b82f6'],
  ['Casa e eletrodomésticos', 'gasto', '#60a5fa'],
  ['Veículo', 'gasto', '#eab308'],
  ['Transporte', 'gasto', '#facc15'],
  ['Alimentação', 'gasto', '#fb923c'],
  ['Saúde', 'gasto', '#f87171'],
  ['Educação', 'gasto', '#14b8a6'],
  ['Celular', 'gasto', '#94a3b8'],
  ['Assinaturas e serviços', 'gasto', '#a1a1aa'],
  ['Compras', 'gasto', '#d946ef'],
  ['Lazer e cuidados', 'gasto', '#2dd4bf'],
  ['Família', 'gasto', '#ec4899'],
  ['Contabilidade', 'gasto', '#0d9488'],
  ['Impostos e taxas', 'gasto', '#ea580c'],
  ['Juros e tarifas bancárias', 'gasto', '#dc2626'],
  ['Saque', 'gasto', '#71717a'],
  ['Pix e outros', 'gasto', '#78716c'],
  ['Outros gastos', 'gasto', '#a8a29e'],
  ['A confirmar', 'gasto', '#ef4444'],
  ['Caixinhas', 'neutro', '#8b5cf6'],
  ['Nu Reserva', 'neutro', '#a78bfa'],
  ['Cripto', 'neutro', '#c4b5fd'],
  ['Transferência própria', 'neutro', '#9ca3af'],
  ['Receita PJ', 'neutro', '#86efac'],
  ['Conta Santander', 'neutro', '#9ca3af'],
  ['Conta Caixa', 'neutro', '#9ca3af'],
  ['Conta BTG', 'neutro', '#9ca3af'],
];

export const DEFAULT_ACCOUNTS = ['Nubank', 'Caixa', 'Santander', 'Nu Empresas', 'BTG'];
export const DEFAULT_CARDS = ['Nubank', 'Santander', 'Caixa'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY, grp TEXT NOT NULL DEFAULT 'gasto', color TEXT NOT NULL DEFAULT '#a8a29e');
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY, filename TEXT, source TEXT, kind TEXT, account TEXT,
  count INTEGER, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('entrada','saida','investimento','transferencia')),
  category TEXT NOT NULL DEFAULT 'A confirmar', account TEXT NOT NULL DEFAULT 'Nubank',
  ext_id TEXT, import_id INTEGER, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
CREATE UNIQUE INDEX IF NOT EXISTS tx_ext ON transactions(account, ext_id) WHERE ext_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS card_items (
  id INTEGER PRIMARY KEY, card TEXT NOT NULL, invoice TEXT NOT NULL, date TEXT NOT NULL,
  description TEXT NOT NULL, amount REAL NOT NULL, category TEXT NOT NULL DEFAULT 'A confirmar',
  ext_id TEXT, import_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS card_inv ON card_items(card, invoice);
CREATE UNIQUE INDEX IF NOT EXISTS card_ext ON card_items(card, ext_id) WHERE ext_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, current REAL NOT NULL DEFAULT 0,
  target REAL NOT NULL DEFAULT 0, monthly REAL NOT NULL DEFAULT 0, sort INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY, month TEXT NOT NULL, description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Contas fixas', amount REAL NOT NULL DEFAULT 0,
  due TEXT, paid INTEGER NOT NULL DEFAULT 0, sort INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS bills_month ON bills(month);
CREATE TABLE IF NOT EXISTS incomes (
  id INTEGER PRIMARY KEY, month TEXT NOT NULL, description TEXT NOT NULL, kind TEXT,
  amount REAL NOT NULL DEFAULT 0, expected TEXT, received INTEGER NOT NULL DEFAULT 0, note TEXT);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'Bem',
  account TEXT, value REAL NOT NULL DEFAULT 0, updated TEXT);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO categories (name, grp, color) VALUES (?, ?, ?)');
  for (const c of DEFAULT_CATEGORIES) ins.run(...c);
  migrate(db);
  return db;
}

// Columns and tables added after the first version.
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('bills').includes('tx_id')) db.exec('ALTER TABLE bills ADD COLUMN tx_id INTEGER');
  if (!cols('transactions').includes('goal_id')) db.exec('ALTER TABLE transactions ADD COLUMN goal_id INTEGER');
  db.exec('CREATE TABLE IF NOT EXISTS budgets (category TEXT PRIMARY KEY, monthly REAL NOT NULL)');
  if (!cols('incomes').includes('tx_id')) db.exec('ALTER TABLE incomes ADD COLUMN tx_id INTEGER');
  // 'previsto' = created by marking a bill as paid or an income as received in Contas;
  // replaced by the bank's own line when the statement is imported.
  if (!cols('transactions').includes('origin')) db.exec('ALTER TABLE transactions ADD COLUMN origin TEXT');
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
