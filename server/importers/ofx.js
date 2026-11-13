// OFX reader (SGML or XML flavour). Works for Nubank, Nu Empresas, Caixa, Santander,
// BTG and card bills exported as OFX.

export function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('latin1').decode(buf);
  }
}

function tag(src, name) {
  const m = src.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : null;
}

function ofxDate(v) {
  if (!v) return null;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function num(v) {
  if (v == null) return null;
  let s = String(v).trim();
  // Some banks write 1.234,56 or 1234,56
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function looksLikeOfx(text) {
  return /OFXHEADER|<OFX>/i.test(text.slice(0, 2000));
}

export function parseOfx(text) {
  const isCard = /<CREDITCARDMSGSRSV1>|<CCSTMTRS>/i.test(text);
  const org = tag(text, 'ORG') || '';
  const fid = tag(text, 'FID') || '';
  const bankId = tag(text, 'BANKID') || '';
  const acctId = tag(text, 'ACCTID') || '';
  const start = ofxDate(tag(text, 'DTSTART'));
  const end = ofxDate(tag(text, 'DTEND'));
  let balance = null;
  const ledger = text.match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>)/i);
  if (ledger) {
    balance = { amount: num(tag(ledger[1], 'BALAMT')), date: ofxDate(tag(ledger[1], 'DTASOF')) };
  }
  const items = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi;
  let m;
  while ((m = re.exec(text))) {
    const t = m[1];
    const amount = num(tag(t, 'TRNAMT'));
    const date = ofxDate(tag(t, 'DTPOSTED'));
    if (amount == null || !date) continue;
    const memo = tag(t, 'MEMO') || '';
    const name = tag(t, 'NAME') || '';
    const description = [name, memo].filter(Boolean).join(' – ') || tag(t, 'TRNTYPE') || 'Lançamento';
    items.push({ date, amount, description: clean(description), extId: tag(t, 'FITID') || null });
  }
  return { format: 'ofx', isCard, org, fid, bankId, acctId, start, end, balance, items };
}

function clean(s) {
  return s.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

export function bankFromOfx(o) {
  const s = `${o.org} ${o.fid} ${o.bankId}`.toUpperCase();
  if (/NU PAGAMENTOS|NUBANK|\b260\b|0260/.test(s)) return 'Nubank';
  if (/CAIXA|\b104\b|0104/.test(s)) return 'Caixa';
  if (/SANTANDER|\b033\b|0033/.test(s)) return 'Santander';
  if (/BTG|\b208\b/.test(s)) return 'BTG';
  return null;
}
