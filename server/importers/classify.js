// Suggests type and category for imported lines: fixed rules first (caixinhas, own
// transfers, card bills), then what you chose before for the same description, then keywords.

export const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/^(nubank|caixa|santander|btg|nu empresas)\s*[–-]\s*/, '')
  .replace(/[•*]+/g, ' ')
  .replace(/\b[\d.,/:-]+\b/g, ' ')
  .replace(/[^a-z ]+/g, ' ')
  .replace(/\b(transferencia|enviada|recebida|pelo|pix|compra|no|debito|credito|de|do|da|ltda|sa|s a)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const KEYWORDS = [
  [/ifood|ifd\b|restaurante|lanch|padaria|panific|acai|pizz|burger|espeto|sorvet|gelat|mercad|supermerc|hortifr|acougue|adega|cafe\b|bar\b|food|delivery/, 'Alimentação'],
  [/posto|combust|uber|\b99\b|estacion|pedagio|shell|ipiranga/, 'Transporte'],
  [/autozone|oficina|moto|pneu|mecanic|capacete|detran|ipva|licenciamento/, 'Veículo'],
  [/\btim\b|vivo|claro|oi movel/, 'Celular'],
  [/spotify|netflix|google|youtube|crunchyroll|hbo|max\b|microsoft|anthropic|claude|hostinger|apple|amazon prime|prime video|disney|openai|github|steam/, 'Assinaturas e serviços'],
  [/farmac|drogar|droga|clinica|hospital|laborat|odonto|medic|saude|imagem/, 'Saúde'],
  [/tarifa|iof|juros|anuidade|encargo|cesta de servico/, 'Juros e tarifas bancárias'],
  [/faculdade|cruzeiro do sul|curso|escola|udemy|alura/, 'Educação'],
  [/contabil/, 'Contabilidade'],
  [/das\b|simples nacional|darf|receita federal|imposto|prefeitura/, 'Impostos e taxas'],
  [/mercado ?livre|mercadolivre|shopee|temu|amazon|magalu|shein|aliexpress|loja|moda|renner|riachuelo|c a\b/, 'Compras'],
  [/saque/, 'Saque'],
  [/cinema|ingresso|show|parque|barbear|salao|academia|smartfit|lazer|viagem|hotel|airbnb/, 'Lazer e cuidados'],
];

export function keywordCategory(desc) {
  const d = norm(desc);
  for (const [re, cat] of KEYWORDS) if (re.test(d)) return cat;
  return null;
}

export function buildHistory(rows) {
  // rows: [{description, type, category}] — most frequent choice per normalized description
  const counts = new Map();
  for (const r of rows) {
    const k = norm(r.description);
    if (!k || r.category === 'A confirmar') continue;
    const key = `${r.type || ''}|${r.category}`;
    const m = counts.get(k) || new Map();
    m.set(key, (m.get(key) || 0) + 1);
    counts.set(k, m);
  }
  const best = new Map();
  for (const [k, m] of counts) {
    const [choice] = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const [type, category] = choice[0].split('|');
    best.set(k, { type: type || null, category });
  }
  return best;
}

export function classifyAccountLine(item, { account, owners = [], company = [], history }) {
  const d = norm(item.description);
  const raw = item.description.toUpperCase();
  const pos = item.amount > 0;
  const has = (list) => list.some((n) => n && raw.includes(n.toUpperCase()));

  if (/cripto|bitcoin|btc\b|ethereum/.test(d)) return { type: 'investimento', category: 'Cripto' };
  if (/resgate|aplicacao|aplicacao rdb|caixinha|nu reserva|guardad/.test(d) && !/fatura/.test(d)) {
    return { type: 'investimento', category: /nu reserva/.test(d) ? 'Nu Reserva' : 'Caixinhas' };
  }
  if (account === 'Nu Empresas') {
    if (!pos && has(owners)) return { type: 'transferencia', category: 'Transferência própria' };
    if (pos) return { type: 'transferencia', category: 'Receita PJ' };
  }
  if (pos && has(company)) return { type: 'entrada', category: 'Salário PJ' };
  if (has(owners) || /minha conta|mesma titularidade/.test(d)) {
    if (pos && /btg/.test(d) && item.amount >= 1500) return { type: 'entrada', category: 'Salário CLT' };
    return { type: 'transferencia', category: 'Transferência própria' };
  }
  if (!pos && /pagamento de fatura|fatura|sx master|cartao de credito|cartoes caixa/.test(d)) {
    return { type: 'saida', category: 'Cartões de crédito' };
  }
  const h = history?.get(d);
  if (h && h.type) {
    // Learned choice, but never flip the direction of money
    if ((h.type === 'entrada' && pos) || (h.type === 'saida' && !pos) || h.type === 'investimento' || h.type === 'transferencia') {
      return { type: h.type, category: h.category };
    }
  }
  if (pos) return { type: 'entrada', category: /estorno|reembolso|devolu/.test(d) ? 'Estornos e reembolsos' : 'Outros recebimentos' };
  return { type: 'saida', category: keywordCategory(item.description) || 'A confirmar' };
}

export function classifyCardLine(item, { history }) {
  const h = history?.get(norm(item.description));
  if (h) return { category: h.category };
  if (item.amount < 0) return { category: 'Estornos e reembolsos' };
  return { category: keywordCategory(item.description) || 'A confirmar' };
}
