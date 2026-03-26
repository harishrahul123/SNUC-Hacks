function normalizeWhitespace(s) {
  return (s || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function parseMoney(m) {
  if (!m) return null;
  // Allow: "Rs.380.00", "Rs 380", "₹ 1,234.50"
  const cleaned = String(m).replace(/[₹$€£,\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseUpiDate(d) {
  // Matches: DD-MM-YY (e.g. 23-03-26)
  if (!d) return null;
  const m = String(d).match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const yy = parseInt(m[3], 10);
  const year = yy <= 50 ? 2000 + yy : 1900 + yy; // heuristic
  // YYYY-MM-DD for your UI
  const iso = new Date(Date.UTC(year, mm - 1, dd)).toISOString().slice(0, 10);
  return iso;
}

function guessCategory(description) {
  const d = (description || '').toLowerCase();
  if (d.includes('salary') || d.includes('payroll')) return 'payroll';
  if (d.includes('gst') || d.includes('tax') || d.includes('gst portal')) return 'tax';
  if (d.includes('rent')) return 'rent';
  if (d.includes('emi') || d.includes('loan')) return 'loan';
  if (d.includes('utility') || d.includes('electric') || d.includes('water') || d.includes('gas')) return 'utility';
  return 'supplier'; // most UPI debits are to merchants/suppliers
}

function extractVpaAndCounterparty(body, type) {
  // Sample debit: "to VPA amazon@yapl Amazon India on ..."
  // We'll try:
  // - VPA: word@word
  // - Counterparty: the merchant name right after VPA (best-effort)
  const vpaMatch = body.match(/(?:to\s+(?:VPA\s+)?)([a-z0-9._%+-]+@[a-z0-9._%+-]+)/i);
  const vpa = vpaMatch ? vpaMatch[1] : null;

  if (!vpa) return { vpa: null, counterparty: guessCategory(body) === 'supplier' ? 'UPI Counterparty' : 'Counterparty' };

  // Pull merchant name between "VPA <vpa>" and "on <date>"
  const re = type === 'debit'
    ? new RegExp(`to\\s+(?:VPA\\s+)?${vpa.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s+(.+?)\\s+on\\s+\\d{2}-\\d{2}-\\d{2}`, 'i')
    : new RegExp(`by\\s+${vpa.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s+(.+?)\\s+on\\s+\\d{2}-\\d{2}-\\d{2}`, 'i');
  const nameMatch = body.match(re);
  const counterparty = nameMatch ? nameMatch[1].trim() : vpa;
  return { vpa, counterparty };
}

function extractBalance(body) {
  const re = /(Avail Bal|Available balance|Available Balance|Avail Balance)[:\\s]*([₹]?\s*[\d,]+(?:\.\d{1,2})?)/i;
  const m = body.match(re);
  if (!m) return null;
  return parseMoney(m[2]);
}

function parseTransactionEmail(subject, body) {
  const text = normalizeWhitespace(`${subject || ''}\n${body || ''}`);
  const lower = text.toLowerCase();

  const isDebit = /has been debited|debited from|has been debited from/i.test(lower);
  const isCredit = /has been credited|credited to|has been credited to/i.test(lower);
  if (!isDebit && !isCredit) return null;

  const type = isDebit ? 'debit' : 'credit';

  // Amount: "Rs.380.00" (or with ₹ / Rs / Rs.)
  const amountMatch =
    text.match(/(?:Rs\.?\s*|₹\s*|\bRS\.?\b)[₹]?\s*([0-9,]+(?:\.\d{1,2})?)/i) ||
    text.match(/Rs\.?\s*([0-9,]+(?:\.\d{1,2})?)/i) ||
    text.match(/₹\s*([0-9,]+(?:\.\d{1,2})?)/i);
  const amount = amountMatch ? parseMoney(amountMatch[1] || amountMatch[0]) : null;
  if (!amount) return null;

  // Date: "on 23-03-26"
  const dateMatch = text.match(/\bon\s+(\d{2}-\d{2}-\d{2})\b/);
  const date = dateMatch ? parseUpiDate(dateMatch[1]) : null;
  if (!date) return null;

  const { vpa, counterparty } = extractVpaAndCounterparty(text, type);

  const description = counterparty
    ? (type === 'debit' ? `Paid to ${counterparty}` : `Received from ${counterparty}`)
    : (type === 'debit' ? 'UPI debit' : 'UPI credit');

  // Reference number (optional)
  const refMatch = text.match(/transaction reference number is\s+(\d+)/i) || text.match(/\bRef[:\\s]*([0-9]+)/i);
  const reference = refMatch ? refMatch[1] : null;

  // Best-effort category mapping
  const category = type === 'debit' ? guessCategory(text) : 'other';

  return {
    type,
    amount,
    date, // YYYY-MM-DD
    description,
    counterparty,
    vpa,
    reference,
    category,
    balance: extractBalance(text),
  };
}

module.exports = {
  parseTransactionEmail,
};

