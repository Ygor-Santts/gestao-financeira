// PDF reader for statements and card bills that only come as PDF (Caixa, Santander).
// Text is extracted with pdftotext (poppler); scanned PDFs (images) have no text and are refused.
import { execFile } from 'node:child_process';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMoney } from './csv.js';

function run(file, password) {
  const args = ['-layout', ...(password ? ['-upw', password] : []), file, '-'];
  return new Promise((resolve, reject) => {
    execFile('pdftotext', args, { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 }, (err, out, errOut) =>
      err ? reject(Object.assign(new Error('Não consegui ler este PDF.'), { locked: /password|senha|encrypt/i.test(String(errOut)) })) : resolve(out));
  });
}

// Bank bills often come locked with a password (usually digits of the CPF).
// The passwords saved in Ajustes are tried one by one.
export async function pdfToText(buf, passwords = []) {
  const dir = await mkdtemp(join(tmpdir(), 'fin-'));
  const file = join(dir, 'in.pdf');
  try {
    await writeFile(file, buf);
    try {
      return await run(file);
    } catch (e) {
      if (!e.locked) throw e;
      for (const pw of passwords) {
        try { return await run(file, pw); } catch { /* next */ }
      }
      throw new Error('Este PDF tem senha. Cadastre a senha em Mais › Ajustes › Senhas de PDF e tente de novo.');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MONEY = /(?:R\$\s*)?[−–-]?\s?\d{1,3}(?:\.\d{3})*,\d{2}\s?[CD]?(?![\d,])/g;
const MONEY_ONE = /\d{1,3}(?:\.\d{3})*,\d{2}/;
const SKIP = /SALDO|TOTAL|OBRIGADO PELO PAGAMENTO|PAGAMENTO EFETUADO|PAGAMENTO DE FATURA|PAGAMENTO RECEBIDO|FATURA ANTERIOR|LIMITE|ENCARGOS|JUROS DO ROTATIVO PREVISTO|\bCET\b|PARCELAMENTO DE FATURA|VALOR M[ÍI]NIMO|COTA[ÇC][ÃA]O/i;

function detectBank(text) {
  const t = text.slice(0, 20000).toUpperCase();
  if (t.includes('SANTANDER')) return 'Santander';
  if (t.includes('CAIXA')) return 'Caixa';
  if (t.includes('NUBANK') || t.includes('NU PAGAMENTOS')) return 'Nubank';
  if (t.includes('BTG')) return 'BTG';
  return null;
}

// Due date of a card bill, used to put a year on "dd/mm" lines.
function findDueDate(text) {
  const m = text.match(/vencimento[^\d]{0,40}(\d{2})\/(\d{2})\/(\d{4})/i) || text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? { y: +m[3], m: +m[2], d: +m[1] } : null;
}

function toAmount(tok, isCard) {
  const t = tok.replace(/\s/g, '');
  const cd = t.match(/[CD]$/)?.[0];
  let v = parseMoney(t.replace(/[CD]$/, ''));
  if (v == null) return null;
  if (isCard) {
    // On a bill a purchase (D) is positive, a credit (C) negative.
    if (cd === 'C') v = -Math.abs(v);
    return v;
  }
  if (cd === 'D') v = -Math.abs(v);
  if (cd === 'C') v = Math.abs(v);
  return v;
}

function parseEntry(dm, rest, isCard, due) {
  const money = rest.match(MONEY);
  if (!money) return null;
  // Bills may show the original US$ value before the R$ one: take the last value
  // marked C/D there. Account statements show value then balance: take the first.
  const marked = money.filter((t) => /[CD]\s*$/.test(t));
  const tok = isCard && marked.length ? marked[marked.length - 1] : money[0];
  let desc = rest.slice(0, rest.indexOf(money[0]))
    .replace(/^\s*\d{5,}\s+/, '') // document number
    .replace(/\s+/g, ' ').trim();
  if (!desc || SKIP.test(desc)) return null;
  let y = dm[3] ? (dm[3].length === 2 ? 2000 + +dm[3] : +dm[3]) : null;
  const mo = +dm[2];
  if (!y) {
    if (!due) return null;
    y = mo > due.m ? due.y - 1 : due.y;
  }
  const amount = toAmount(tok, isCard);
  if (amount == null || amount === 0) return null;
  return { date: `${y}-${String(mo).padStart(2, '0')}-${dm[1]}`, description: desc, amount, extId: null };
}

export function parsePdfText(text) {
  const bank = detectBank(text);
  const isCard = /FATURA/i.test(text) && /(vencimento|cart[ãa]o)/i.test(text) && !/Extrato por per[íi]odo|EXTRATO DE CONTA/i.test(text);
  const due = findDueDate(text);
  const items = [];
  // A line may hold two entries side by side (two-column bills): split it at every date.
  const DATE = /(?<![\d/])(\d{2})\/(\d{2})(?:\/(\d{2,4}))?(?:\s*-\s*\d{2}:\d{2}:\d{2})?(?=\s+\S)/g;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const starts = [];
    for (const m of line.matchAll(DATE)) {
      // Real entry dates start the line, follow a wide gap, or a short marker such as "3".
      const before = line.slice(0, m.index);
      if (!(/(^|\s{2,})$/.test(before) || /^\s*\S{1,3}\s+$/.test(before))) continue;
      // A later date only opens a new entry once the previous one has its value
      // (so an installment like "06/06" inside a description is not a date).
      if (starts.length) {
        const prev = starts[starts.length - 1];
        if (!MONEY_ONE.test(line.slice(prev.index + prev[0].length, m.index))) continue;
      }
      starts.push(m);
    }
    starts.forEach((m, k) => {
      const seg = line.slice(m.index + m[0].length, k + 1 < starts.length ? starts[k + 1].index : undefined);
      const item = parseEntry(m, seg, isCard, due);
      if (item) items.push(item);
    });
  }
  if (!items.length) {
    throw new Error(text.trim().length < 50
      ? 'Este PDF é uma imagem (escaneado), sem texto para ler. Exporte em OFX ou CSV.'
      : 'Não reconheci lançamentos neste PDF. Se puder, exporte em OFX ou CSV.');
  }
  const invoice = isCard && due ? `${due.y}-${String(due.m).padStart(2, '0')}` : null;
  return { format: 'pdf', isCard, bank, invoice, items };
}
