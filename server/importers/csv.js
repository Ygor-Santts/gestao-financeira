// CSV reader: Nubank account (Data,Valor,Identificador,Descrição), Nubank card
// (date,title,amount) and a generic fallback that guesses the columns by their names.

export function splitCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

export function parseMoney(s) {
  if (s == null) return null;
  let v = String(s).replace(/R\$|\s/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(v)) { neg = true; v = v.slice(1, -1); }
  if (/[−–-]/.test(v[0])) { neg = true; v = v.slice(1); }
  if (/,\d{1,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
  else v = v.replace(/,/g, '');
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export function parseDate(s) {
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function parseCsv(text) {
  const rows = splitCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('CSV vazio ou sem cabeçalho.');
  const head = rows[0].map(norm);
  const find = (...names) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  // Nubank card: date,title,amount — amount > 0 is a purchase
  if (head.join(',') === 'date,title,amount') {
    const items = rows.slice(1).map((r) => ({
      date: parseDate(r[0]), description: r[1], amount: parseMoney(r[2]), extId: null,
    })).filter((i) => i.date && i.amount != null);
    return { format: 'csv-nubank-cartao', isCard: true, bank: 'Nubank', items };
  }

  const iDate = find('data', 'date');
  const iValue = find('valor', 'amount', 'value', 'quantia');
  const iDesc = find('descricao', 'historico', 'title', 'memo', 'lancamento', 'descri');
  const iId = find('identificador', 'id', 'fitid', 'documento');
  if (iDate < 0 || iValue < 0) throw new Error('Não achei as colunas de data e valor neste CSV.');
  const isNubank = head.includes('identificador') && head.includes('descricao');
  const items = rows.slice(1).map((r) => ({
    date: parseDate(r[iDate]),
    amount: parseMoney(r[iValue]),
    description: (iDesc >= 0 ? r[iDesc] : '') || 'Lançamento',
    extId: iId >= 0 && r[iId] ? r[iId] : null,
  })).filter((i) => i.date && i.amount != null);
  return { format: isNubank ? 'csv-nubank-conta' : 'csv', isCard: false, bank: isNubank ? 'Nubank' : null, items };
}
