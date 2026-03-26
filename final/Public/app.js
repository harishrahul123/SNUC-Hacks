/* =========================================================
   PocketCFO — app.js
   All React components and app logic.
   Depends on: React 18 (UMD), ReactDOM 18 (UMD)
   External API: Groq (called client-side via user-supplied key)
   ========================================================= */

'use strict';

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ─── GROQ API ─────────────────────────────────────────────────────────────────
async function callGroq(apiKey, messages, systemPrompt = '') {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages
      ],
      temperature: 0.3,
      max_tokens: 2048
    })
  });
  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

// ─── DETERMINISTIC ENGINE ─────────────────────────────────────────────────────
function computeRunway(balance, obligations = [], receivables = []) {
  const today = new Date();

  const events = [
    ...obligations.map(o => ({
      type: 'obligation',
      date: new Date(o.dueDate),
      amount: Number(o.amount) || 0,
      item: o
    })),
    ...receivables.map(r => ({
      type: 'receivable',
      date: new Date(r.expectedDate),
      amount: Number(r.amount) || 0,
      item: r
    }))
  ].sort((a, b) => a.date - b.date);

  let cash = Number(balance) || 0;

  for (const e of events) {
    const d = Math.max(0, Math.floor((e.date - today) / 86400000));

    if (e.type === 'receivable') {
      cash += e.amount;
    } else {
      if (cash < e.amount) {
        return {
          days: d,
          shortfall: e.amount - cash,
          nextCrisis: e.item
        };
      }
      cash -= e.amount;
    }
  }

  return { days: 90, shortfall: 0, nextCrisis: null };
}

function prioritizeObligations(obligations = [], balance = 0, receivables = []) {
  const PRIORITY_WEIGHTS = {
    payroll: 5,
    tax: 4,
    loan: 4,
    rent: 4,
    supplier: 3,
    utility: 2,
    other: 1
  };

  const today = new Date();

  const sortedObligations = obligations
    .map(o => {
      const due = new Date(o.dueDate);
      const daysLeft = Math.floor((due - today) / 86400000);
      const urgency =
        daysLeft <= 3 ? 'critical' :
        daysLeft <= 7 ? 'high' :
        daysLeft <= 14 ? 'medium' : 'low';

      const weight =
        (PRIORITY_WEIGHTS[o.category] || 1) +
        (urgency === 'critical' ? 3 :
         urgency === 'high' ? 2 :
         urgency === 'medium' ? 1 : 0);

      return { ...o, daysLeft, urgency, weight };
    })
    .sort((a, b) => {
      const dueDiff = new Date(a.dueDate) - new Date(b.dueDate);
      if (dueDiff !== 0) return dueDiff;
      return b.weight - a.weight;
    });

  const receivableEvents = receivables
    .map(r => ({
      date: new Date(r.expectedDate),
      amount: Number(r.amount) || 0
    }))
    .sort((a, b) => a.date - b.date);

  let cash = Number(balance) || 0;
  let recIdx = 0;

  return sortedObligations.map(o => {
    const dueDate = new Date(o.dueDate);

    while (recIdx < receivableEvents.length && receivableEvents[recIdx].date <= dueDate) {
      cash += receivableEvents[recIdx].amount;
      recIdx++;
    }

    const canPay = cash >= o.amount;
    if (canPay) cash -= o.amount;

    return {
      ...o,
      canPay,
      remainingAfter: cash
    };
  });
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDateLabel(date) {
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

/** Local calendar YYYY-MM-DD (avoids UTC vs local day mismatch in cash buckets). */
function calendarDayKey(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getProjectedEvents(balance, obligations = [], receivables = []) {
  const today = new Date();
  const events = [
    ...obligations.map(o => ({
      id: `obl-${o.id}`,
      type: 'outflow',
      label: o.name || 'Obligation',
      date: new Date(o.dueDate),
      amount: Number(o.amount) || 0,
      category: o.category || 'other'
    })),
    ...receivables.map(r => ({
      id: `rec-${r.id}`,
      type: 'inflow',
      label: r.from ? `Receivable from ${r.from}` : 'Receivable',
      date: new Date(r.expectedDate),
      amount: Number(r.amount) || 0,
      category: 'receivable'
    }))
  ]
    .filter(e => !Number.isNaN(e.date.getTime()))
    .sort((a, b) => a.date - b.date);

  let runningBalance = Number(balance) || 0;
  const timeline = [{
    id: 'start',
    type: 'start',
    label: 'Today',
    date: today,
    amount: 0,
    runningBalance
  }];

  for (const event of events) {
    runningBalance += event.type === 'inflow' ? event.amount : -event.amount;
    timeline.push({
      ...event,
      runningBalance
    });
  }

  return timeline;
}

// ─── LOCAL INVOICE EXTRACTION (PDF TEXT + OCR) ───────────────────────────────
let ocrWorkerPromise = null;

function safeNumber(value) {
  if (value == null) return 0;
  const cleaned = String(value).replace(/[^\d.-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Net cash impact of history: credits add, debits subtract. */
function netFromTransactions(transactions) {
  if (!Array.isArray(transactions)) return 0;
  return transactions.reduce((sum, t) => {
    const amt = Number(t.amount) || 0;
    if (t.type === 'credit') return sum + amt;
    return sum - amt;
  }, 0);
}

function toISODate(raw) {
  if (!raw) return '';
  const cleaned = String(raw).replace(/\s+/g, ' ').trim();
  const direct = new Date(cleaned);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString().slice(0, 10);
  const m = cleaned.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${month}-${day}`;
  }
  return '';
}

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getOcrWorker() {
  if (!window.Tesseract) throw new Error('Tesseract OCR not loaded.');
  if (!ocrWorkerPromise) ocrWorkerPromise = window.Tesseract.createWorker('eng');
  return ocrWorkerPromise;
}

async function extractTextFromImageLocal(file) {
  const worker = await getOcrWorker();
  const result = await worker.recognize(file);
  return normalizeWhitespace(result?.data?.text || '');
}

async function extractTextFromPdfLocal(file) {
  if (!window.pdfjsLib) throw new Error('PDF.js not loaded.');
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = normalizeWhitespace(content.items.map(item => item.str).join(' '));
    pages.push(`--- PAGE ${pageNum} ---\n${pageText}`);
  }
  return normalizeWhitespace(pages.join('\n\n'));
}

async function ocrPdfLocal(file) {
  if (!window.pdfjsLib) throw new Error('PDF.js not loaded.');
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const worker = await getOcrWorker();
  const pages = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const result = await worker.recognize(canvas);
    const pageText = normalizeWhitespace(result?.data?.text || '');
    pages.push(`--- PAGE ${pageNum} ---\n${pageText}`);
  }
  return normalizeWhitespace(pages.join('\n\n'));
}

async function extractDocumentTextLocal(file) {
  if (file.type === 'application/pdf') {
    const directText = await extractTextFromPdfLocal(file);
    const textDensity = directText.replace(/\s/g, '').length;
    if (textDensity >= 120) return directText;
    return await ocrPdfLocal(file);
  }
  if (file.type.startsWith('image/')) return await extractTextFromImageLocal(file);
  return normalizeWhitespace(await file.text());
}

async function extractTextWithCloudOCR(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('apikey', 'helloworld');
  formData.append('language', 'eng');
  formData.append('isTable', 'true');
  formData.append('OCREngine', '2');

  const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`Cloud OCR failed (${res.status})`);
  const data = await res.json();
  if (data.IsErroredOnProcessing) throw new Error((data.ErrorMessage && data.ErrorMessage.join(' ')) || 'Cloud OCR failed');
  const parsedText = (data.ParsedResults || []).map(r => normalizeWhitespace(r.ParsedText || '')).filter(Boolean).join('\n\n');
  if (!parsedText) throw new Error('Cloud OCR returned no readable text');
  return normalizeWhitespace(parsedText);
}

function assessExtractionConfidence(text, filename = '') {
  const raw = normalizeWhitespace(text || '');
  const compactLen = raw.replace(/\s/g, '').length;
  const hasInvoiceMarkers = /invoice\s*no\.?|customer\s*invoice|tax\s*invoice/i.test(raw);
  const hasAmounts = /(?:₹|rs\.?|inr)?\s*[\d,]{3,}(?:\.\d{2})?/i.test(raw);
  const hasDates = /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i.test(raw);
  const invoiceHint = /invoice|bill|receipt/i.test(filename) || hasInvoiceMarkers;
  let score = 0;
  if (compactLen >= 120) score += 35;
  else if (compactLen >= 60) score += 20;
  else if (compactLen >= 25) score += 10;
  if (hasAmounts) score += 20;
  if (hasDates) score += 15;
  if (invoiceHint) score += 15;
  return { score, isLow: score < 55 };
}

function parseInvoicePages(text) {
  const normalized = normalizeWhitespace(text);
  const pageBlocks = normalized.split(/--- PAGE \d+ ---/g).map(s => s.trim()).filter(Boolean);
  const blocks = pageBlocks.length ? pageBlocks : [normalized];
  const invoices = [];

  for (const block of blocks) {
    if (!/invoice/i.test(block)) continue;
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const vendor = lines[0] || 'Unknown Vendor';
    const invoiceNo = (block.match(/Invoice\s*No\.?\s*:?\s*([A-Z0-9/-]+)/i) || [])[1] || '';
    const invoiceDateRaw = (block.match(/Invoice\s*Date\s*:?\s*([^\n]+)/i) || [])[1] || '';
    const dueDateRaw = (block.match(/Due\s*Date\s*:?\s*([^\n]+)/i) || [])[1] || invoiceDateRaw;
    let totalRaw = (block.match(/Total\s*Amount\s*After\s*Tax\s*:?\s*([\d,]+(?:\.\d{2})?)/i) || [])[1] || '';
    if (!totalRaw) {
      const altTotals = [...block.matchAll(/\b([\d,]{4,}(?:\.\d{2})?)\b/g)].map(m => m[1]);
      totalRaw = altTotals.at(-1) || '';
    }
    const amount = safeNumber(totalRaw);
    if (!invoiceNo && !amount) continue;

    invoices.push({
      vendor,
      invoiceNumber: invoiceNo,
      invoiceDate: toISODate(invoiceDateRaw),
      dueDate: toISODate(dueDateRaw) || toISODate(invoiceDateRaw) || new Date().toISOString().slice(0, 10),
      total: amount,
      description: invoiceNo ? `${vendor} • ${invoiceNo}` : `${vendor} invoice`,
    });
  }
  return invoices;
}

// ─── SAMPLE DATA ──────────────────────────────────────────────────────────────
const SAMPLE_OBLIGATIONS = [];

const SAMPLE_RECEIVABLES = [];

// ─── TOAST SYSTEM ─────────────────────────────────────────────────────────────
function ToastContainer({ toasts }) {
  return React.createElement('div', { className: 'toast-container' },
    toasts.map(t => React.createElement('div', { key: t.id, className: `toast ${t.type}` },
      React.createElement('span', null, t.type === 'success' ? '✓' : '✗'),
      React.createElement('span', null, t.msg)
    ))
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
function Sidebar({ page, setPage, apiKey, setApiKey, theme, toggleTheme }) {
  const items = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'reality', label: 'Reality' },
    { id: 'obligations', label: 'Obligations' },
    { id: 'receivables', label: 'Receivables' },
    { id: 'transactions', label: 'Transactions' },
    { id: 'future', label: 'Future' },
    { id: 'actions', label: 'Actions' }
  ];
  const navIcon = '◈';
  return React.createElement('div', { className: 'sidebar' },
    React.createElement('div', { className: 'logo' }, 'Pocket', React.createElement('span', { className: 'logo-cfo' }, 'CFO')),
    React.createElement('nav', { className: 'nav' },
      items.map(i => React.createElement('div', {
        key: i.id, className: `nav-item ${page === i.id ? 'active' : ''}`,
        onClick: () => setPage(i.id)
      },
        React.createElement('span', { className: 'icon' }, navIcon),
        i.label
      ))
    ),
    React.createElement('button', {
      type: 'button',
      className: 'theme-toggle theme-toggle--sidebar',
      onClick: toggleTheme,
      'aria-label': theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
    }, theme === 'dark' ? '☼ Light mode' : '🌙 Dark mode'),
    React.createElement('div', { className: 'api-key-section' },
      React.createElement('label', null, 'GROQ API KEY'),
      React.createElement('input', {
        type: 'password', className: 'api-key-input',
        placeholder: 'gsk_...', value: apiKey,
        onChange: e => setApiKey(e.target.value)
      })
    )
  );
}

// ─── CASH FLOW CHART ──────────────────────────────────────────────────────────
function CashFlowChart({ balance, obligations, receivables }) {
  const days = 30;
  const points = [];
  let cash = balance;
  for (let i = 0; i <= days; i += 3) {
    const date = new Date(Date.now() + i * 86400000);
    const oblOnDay = obligations.filter(o => {
      const d = new Date(o.dueDate);
      return d >= date && d < new Date(date.getTime() + 3 * 86400000);
    }).reduce((s, o) => s + o.amount, 0);
    const recOnDay = receivables.filter(r => {
      const d = new Date(r.expectedDate);
      return d >= date && d < new Date(date.getTime() + 3 * 86400000);
    }).reduce((s, r) => s + r.amount, 0);
    cash = cash - oblOnDay + recOnDay;
    points.push({ label: `D${i}`, value: Math.max(0, cash), raw: cash });
  }
  const max = Math.max(...points.map(p => p.value), 1);

  return React.createElement('div', { className: 'bar-chart' },
    points.map((p, i) =>
      React.createElement('div', { key: i, className: 'bar-wrap', title: `Day ${i * 3}: ₹${p.raw.toLocaleString()}` },
        React.createElement('div', {
          className: 'bar',
          style: {
            height: Math.max(2, (p.value / max) * 68) + 'px',
            background: p.raw < 0 ? 'var(--danger)' : p.raw < balance * 0.3 ? 'var(--warn)' : 'var(--accent)',
            opacity: 0.7 + (i / points.length) * 0.3
          }
        }),
        i % 3 === 0 && React.createElement('div', { className: 'bar-label' }, p.label)
      )
    )
  );
}

function ScenarioLineChart({ points }) {
  if (!points || points.length === 0) return null;
  const width = 520;
  const height = 170;
  const pad = 22;
  const vals = points.map(p => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const rawRange = max - min;
  const padY = Math.max(rawRange * 0.08, Math.max(Math.abs(max), Math.abs(min)) * 0.02, 500);
  const minV = min - padY;
  const maxV = max + padY;
  const range = Math.max(1, maxV - minV);
  const x = i => pad + (i / Math.max(1, points.length - 1)) * (width - pad * 2);
  const y = v => (height - pad) - ((v - minV) / range) * (height - pad * 2);
  const polyline = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  const areaPath = `M ${x(0)},${height - pad} L ${points.map((p, i) => `${x(i)},${y(p.value)}`).join(' L ')} L ${x(points.length - 1)},${height - pad} Z`;
  return React.createElement('svg', {
    viewBox: `0 0 ${width} ${height}`,
    className: 'scenario-svg',
    preserveAspectRatio: 'xMidYMid meet',
    'aria-label': 'Projected cash balance over ~60 days'
  },
    React.createElement('defs', null,
      React.createElement('linearGradient', { id: 'scenarioGrad', x1: '0', y1: '0', x2: '0', y2: '1' },
        React.createElement('stop', { offset: '0%', stopColor: 'var(--accent2)', stopOpacity: 0.5 }),
        React.createElement('stop', { offset: '100%', stopColor: 'var(--accent2)', stopOpacity: 0 })
      )
    ),
    React.createElement('path', {
      key: `area-${polyline}`,
      d: areaPath,
      fill: 'url(#scenarioGrad)',
      opacity: 0.35
    }),
    React.createElement('polyline', {
      key: `line-${polyline}`,
      points: polyline,
      fill: 'none',
      stroke: 'var(--accent2)',
      strokeWidth: 2.5,
      strokeLinejoin: 'round',
      strokeLinecap: 'round',
      opacity: 0.95
    }),
    points.map((p, i) => React.createElement('circle', {
      key: `${p.label}-${i}-${Math.round(p.value)}`,
      cx: x(i),
      cy: y(p.value),
      r: 3,
      fill: p.value < 0 ? 'var(--danger)' : 'var(--accent)'
    }))
  );
}

function BusinessSurvivalSimulator({ balance, obligations, receivables }) {
  const [sliders, setSliders] = useState({
    supplierDelayDays: 10,
    marketingSpendChange: 10,
    inventoryTurnoverChange: 5,
    salesGrowthChange: 8
  });

  const applyPreset = (preset) => setSliders(prev => ({ ...prev, ...preset }));

  const scenario = useMemo(() => {
    const delay = Number(sliders.supplierDelayDays) || 0;
    const marketing = Number(sliders.marketingSpendChange) || 0;
    const inventory = Number(sliders.inventoryTurnoverChange) || 0;
    const sales = Number(sliders.salesGrowthChange) || 0;

    const hasSupplierObligations = obligations.some(o => o.category === 'supplier');
    const turnoverEffect = Math.min(1.25, Math.max(0.75, 1 - (inventory / 100) * 0.4));
    const invGlobal = Math.min(1.12, Math.max(0.88, 1 - (inventory / 100) * 0.06));
    const salesEffect = Math.min(2, Math.max(0.6, 1 + (sales / 100)));
    const receivableDateShift = Math.round((sales / 100) * -6 + (inventory / 100) * -3);

    const totalOblBase = obligations.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
    const balanceN = Number(balance) || 0;
    const scaleBase = Math.max(totalOblBase, Math.abs(balanceN) * 0.45, 18000);

    const adjustedObligations = obligations.map(o => {
      const isSupplier = o.category === 'supplier';
      const applyDelay = hasSupplierObligations ? isSupplier : true;
      const baseAmount = Number(o.amount) || 0;
      const inventoryAdjusted = isSupplier
        ? Math.round(baseAmount * turnoverEffect)
        : Math.round(baseAmount * invGlobal);
      return {
        ...o,
        amount: Math.max(0, inventoryAdjusted),
        dueDate: applyDelay ? addDays(new Date(o.dueDate), delay).toISOString().slice(0, 10) : o.dueDate
      };
    });

    const adjustedReceivables = receivables.map(r => {
      const baseAmount = Number(r.amount) || 0;
      const growthAdjustedAmount = Math.round(baseAmount * salesEffect);
      return {
        ...r,
        amount: Math.max(0, growthAdjustedAmount),
        expectedDate: addDays(new Date(r.expectedDate), receivableDateShift).toISOString().slice(0, 10)
      };
    });

    const projectedInflowBase = Math.max(8000, Math.round(scaleBase * 0.35));
    const growthProjection = receivables.length === 0
      ? [{
          id: 'proj-sales-1',
          from: 'Projected sales',
          amount: Math.round(projectedInflowBase * salesEffect),
          expectedDate: addDays(new Date(), 30).toISOString().slice(0, 10),
          status: 'projected'
        }, {
          id: 'proj-sales-2',
          from: 'Projected sales',
          amount: Math.round(projectedInflowBase * salesEffect * 1.05),
          expectedDate: addDays(new Date(), 60).toISOString().slice(0, 10),
          status: 'projected'
        }]
      : [];

    const scenarioReceivables = [...adjustedReceivables, ...growthProjection];

    const mktIntensity = Math.max(0, marketing) / 100;
    const marketingOutflows = mktIntensity > 0
      ? [{
          id: 'mkt-1',
          name: 'Marketing push',
          category: 'other',
          amount: Math.round(scaleBase * mktIntensity * 0.12),
          dueDate: addDays(new Date(), 15).toISOString().slice(0, 10)
        }, {
          id: 'mkt-2',
          name: 'Marketing push',
          category: 'other',
          amount: Math.round(scaleBase * mktIntensity * 0.12),
          dueDate: addDays(new Date(), 45).toISOString().slice(0, 10)
        }]
      : [];

    const scenarioObligations = [...adjustedObligations, ...marketingOutflows];

    const scenarioTimeline = getProjectedEvents(balance, scenarioObligations, scenarioReceivables);

    const buildDailySeries = (eventTimeline) => {
      const horizonDays = 60;
      const start = new Date();
      const eventMap = {};
      for (const e of eventTimeline) {
        if (e.type === 'start') continue;
        const k = calendarDayKey(e.date);
        eventMap[k] = (eventMap[k] || 0) + (e.type === 'inflow' ? e.amount : -e.amount);
      }

      const daily = [];
      let running = Number(balance) || 0;
      for (let day = 0; day <= horizonDays; day++) {
        const targetDate = addDays(start, day);
        running += eventMap[calendarDayKey(targetDate)] || 0;
        daily.push({ label: `D${day}`, value: running });
      }

      return daily.filter((_, idx) => idx % 3 === 0);
    };

    const points = buildDailySeries(scenarioTimeline);

    const finalBalance = points[points.length - 1]?.value || balance;
    const minBalance = Math.min(...points.map(p => p.value));
    const peakBalance = Math.max(...points.map(p => p.value));
    const negativeDays = scenarioTimeline.filter(t => t.runningBalance < 0).length;

    return { adjustedObligations: scenarioObligations, adjustedReceivables: scenarioReceivables, points, finalBalance, minBalance, peakBalance, negativeDays };
  }, [
    balance,
    obligations,
    receivables,
    sliders.supplierDelayDays,
    sliders.marketingSpendChange,
    sliders.inventoryTurnoverChange,
    sliders.salesGrowthChange
  ]);

  const scenarioChartKey = [
    sliders.supplierDelayDays,
    sliders.marketingSpendChange,
    sliders.inventoryTurnoverChange,
    sliders.salesGrowthChange,
    ...scenario.points.map(p => Math.round(p.value))
  ].join('|');

  return React.createElement('div', { className: 'card section-gap' },
    React.createElement('div', { className: 'card-title' }, 'Business Survival Simulator'),
    React.createElement('div', { className: 'sim-grid' },
      React.createElement('div', null,
        React.createElement('div', { className: 'sim-control' },
          React.createElement('label', null, `Delay supplier payment: ${sliders.supplierDelayDays} days`),
          React.createElement('input', { type: 'range', min: 0, max: 45, step: 1, value: sliders.supplierDelayDays, onChange: e => setSliders(s => ({ ...s, supplierDelayDays: Number(e.target.value) })) })
        ),
        React.createElement('div', { className: 'sim-control' },
          React.createElement('label', null, `Increase marketing spend: ${sliders.marketingSpendChange}%`),
          React.createElement('input', { type: 'range', min: -20, max: 60, step: 1, value: sliders.marketingSpendChange, onChange: e => setSliders(s => ({ ...s, marketingSpendChange: Number(e.target.value) })) })
        ),
        React.createElement('div', { className: 'sim-control' },
          React.createElement('label', null, `Change inventory turnover: ${sliders.inventoryTurnoverChange}%`),
          React.createElement('input', { type: 'range', min: -30, max: 40, step: 1, value: sliders.inventoryTurnoverChange, onChange: e => setSliders(s => ({ ...s, inventoryTurnoverChange: Number(e.target.value) })) })
        ),
        React.createElement('div', { className: 'sim-control' },
          React.createElement('label', null, `Adjust sales growth: ${sliders.salesGrowthChange}%`),
          React.createElement('input', { type: 'range', min: -20, max: 80, step: 1, value: sliders.salesGrowthChange, onChange: e => setSliders(s => ({ ...s, salesGrowthChange: Number(e.target.value) })) })
        ),
        React.createElement('div', { className: 'sim-presets' },
          React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: () => applyPreset({ supplierDelayDays: 20, marketingSpendChange: 40, inventoryTurnoverChange: -10, salesGrowthChange: 35 }) }, 'Aggressive growth'),
          React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: () => applyPreset({ supplierDelayDays: 10, marketingSpendChange: -10, inventoryTurnoverChange: 20, salesGrowthChange: 5 }) }, 'Conservative survival'),
          React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: () => applyPreset({ supplierDelayDays: 30, marketingSpendChange: 55, inventoryTurnoverChange: -15, salesGrowthChange: 50 }) }, 'Investor-dependent growth')
        )
      ),
      React.createElement('div', null,
        React.createElement(ScenarioLineChart, { key: scenarioChartKey, points: scenario.points }),
        React.createElement('div', { className: 'sim-kpis' },
          React.createElement('div', null, React.createElement('strong', null, 'Final: '), `₹${Math.round(scenario.finalBalance).toLocaleString()}`),
          React.createElement('div', null, React.createElement('strong', null, 'Lowest: '), `₹${Math.round(scenario.minBalance).toLocaleString()}`),
          React.createElement('div', null, React.createElement('strong', null, 'Peak: '), `₹${Math.round(scenario.peakBalance).toLocaleString()}`),
          React.createElement('div', null, React.createElement('strong', null, 'Negative events: '), String(scenario.negativeDays))
        )
      )
    )
  );
}

function CashFlowTimeline({ balance, obligations, receivables }) {
  const timeline = useMemo(() => getProjectedEvents(balance, obligations, receivables), [balance, obligations, receivables]);
  return React.createElement('div', { className: 'card section-gap' },
    React.createElement('div', { className: 'card-title' }, 'Cash Flow Timeline'),
    React.createElement('div', { className: 'timeline futuristic' },
      timeline.slice(0, 14).map((event, index) => React.createElement('div', { key: event.id + index, className: 'timeline-item' },
        React.createElement('div', { className: 'timeline-dot', style: { background: event.type === 'inflow' ? 'var(--accent)' : event.type === 'outflow' ? 'var(--danger)' : 'var(--accent2)' } }),
        React.createElement('div', { className: 'timeline-content' },
          React.createElement('div', { className: 'timeline-date' }, event.type === 'start' ? 'Today' : formatDateLabel(event.date)),
          React.createElement('div', { className: 'timeline-main-row' },
            React.createElement('span', null, event.label),
            event.type !== 'start' && React.createElement('span', { className: 'timeline-amount', style: { color: event.type === 'inflow' ? 'var(--accent)' : 'var(--danger)' } },
              `${event.type === 'inflow' ? '+' : '-'}₹${event.amount.toLocaleString()}`
            )
          ),
          React.createElement('div', { className: 'timeline-balance' }, `Balance: ₹${Math.round(event.runningBalance).toLocaleString()}`)
        )
      ))
    )
  );
}

function daysUntilCalendar(iso) {
  const end = new Date(iso);
  if (Number.isNaN(end.getTime())) return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - start) / 86400000);
}

/** Round rupee amounts for on-screen copy so we don’t echo exact invoice lines. */
function roundRupeeForCopy(n) {
  const x = Math.abs(Number(n) || 0);
  if (x === 0) return 0;
  const step = x >= 500000 ? 50000 : x >= 100000 ? 10000 : x >= 25000 ? 5000 : 1000;
  return Math.round(x / step) * step;
}

function receivableTimingBucket(iso) {
  const d = daysUntilCalendar(iso);
  if (d <= 0) return 'Due now / overdue';
  if (d <= 7) return 'Within a week';
  if (d <= 30) return 'Within ~30 days';
  if (d <= 60) return 'Within ~2 months';
  return 'Further out';
}

// ─── REALITY (you finance your customers) ───────────────────────────────────
function RealityPage({ obligations, receivables }) {
  const model = useMemo(() => {
    const INPUT = new Set(['supplier', 'utility']);
    let inputOb = obligations.filter(o => INPUT.has(o.category));
    if (inputOb.length === 0) {
      inputOb = obligations.filter(o => ['supplier', 'utility', 'rent', 'other'].includes(o.category));
    }
    if (inputOb.length === 0) inputOb = [...obligations];

    const totalInput = inputOb.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    const totalAR = receivables.reduce((s, r) => s + (Number(r.amount) || 0), 0);

    const inputDays = inputOb.map(o => daysUntilCalendar(o.dueDate));
    const recDays = receivables.map(r => daysUntilCalendar(r.expectedDate));

    const avgIn = inputDays.length ? inputDays.reduce((a, b) => a + b, 0) / inputDays.length : 0;
    const avgRec = recDays.length ? recDays.reduce((a, b) => a + b, 0) / recDays.length : 0;
    const gapDays =
      inputDays.length > 0 && recDays.length > 0
        ? Math.round(avgRec - avgIn)
        : null;

    const topSupplier = [...inputOb].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))[0] || null;
    const topRec = [...receivables].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))[0] || null;
    const sortedRecs = [...receivables].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));

    const overlapFloat = Math.round(Math.min(totalInput || 0, totalAR || 0));

    let narrativeShort = '';
    let narrativeDetail =
      'Small businesses often finance their own clients: you pay for raw materials, stock, or suppliers first, then wait weeks for customer invoices to turn into bank balance. Until that cash lands, the gap is your working capital — not the bank’s.';

    if (obligations.length === 0 && receivables.length === 0) {
      narrativeShort = 'Add obligations and receivables to see your real “client financing” picture in rupees and days.';
    } else {
      const topPayRounded = topSupplier ? roundRupeeForCopy(topSupplier.amount) : 0;
      const topRecRounded = topRec ? roundRupeeForCopy(topRec.amount) : 0;
      const totalInputR = roundRupeeForCopy(totalInput);
      const totalARR = roundRupeeForCopy(totalAR);

      const exPay =
        totalInput > 0
          ? (topSupplier
            ? `You have roughly ₹${totalInputR.toLocaleString()} in input-style payables (your largest single line is on the order of ₹${topPayRounded.toLocaleString()})`
            : `Your cost-side payables total roughly ₹${totalInputR.toLocaleString()}`)
          : 'As you add supplier-style payables';
      const exRec =
        totalAR > 0
          ? (topRec
            ? `while about ₹${totalARR.toLocaleString()} is still receivable overall (the biggest open balance is roughly ₹${topRecRounded.toLocaleString()})`
            : `while roughly ₹${totalARR.toLocaleString()} is still tied up in receivables`)
          : 'before customer collections fully cover what you’ve already spent';
      const gapPhrase =
        gapDays == null
          ? ' Add both input payables and receivables to see whether customers pay you slower than you pay suppliers.'
          : gapDays > 3
            ? ` On average, money from customers is showing up ~${gapDays} days after those input-side payments — so you’re carrying them with your cash.`
            : gapDays < -3
              ? ' Collections are, on average, ahead of your big input payments — that helps, but one slow payer can still flip the stress.'
              : ' Pay-in and pay-out timing is close; small slips on either side hit cash quickly.';
      narrativeShort = `${exPay}, ${exRec}.${gapPhrase}`;
    }

    const earlyDiscTop = topRec ? roundRupeeForCopy((Number(topRec.amount) || 0) * 0.02) : 0;
    const topRecRoundedForCopy = topRec ? roundRupeeForCopy(topRec.amount) : 0;

    const actions = [
      {
        title: 'Prioritize collections first',
        tag: 'Cash in',
        body:
          totalAR > 0
            ? `Roughly ₹${roundRupeeForCopy(totalAR).toLocaleString()} is still outstanding from customers — that cash costs you nothing to “borrow.” Start with your largest open balances first: firm reminders, payment plans, or pausing discretionary delivery until a deposit lands.`
            : 'Log receivables so PocketCFO can rank who to call first. Until they’re in the app, you’re flying blind on who owes you the most.'
      },
      {
        title: 'Ask customers for money up front',
        tag: 'Deposits',
        body: topSupplier
          ? `Payables on the input side include a largest line on the order of ₹${roundRupeeForCopy(topSupplier.amount).toLocaleString()}. On new orders, quote a deposit or milestone billing so part of the sale is paid before you fund the next round of inputs.`
          : 'For new work, tie customer deposits or milestones to when you must pay suppliers. That way you’re not the only balance sheet funding the gap.'
      },
      {
        title: 'Try a ~2% early payment discount',
        tag: '2% / 10',
        body: topRec
          ? `On your largest open balance (roughly ₹${topRecRoundedForCopy.toLocaleString()}), a 2% early-pay incentive is on the order of ₹${earlyDiscTop.toLocaleString()} — often cheaper than waiting an extra month or using short-term credit. Example line: “Pay within 10 days, save 2%.”`
          : 'Early-pay discounts (commonly 1–2% for payment within 10 days) turn receivables into bank cash faster. Compare the discount to your cost of waiting or borrowing.'
      },
      {
        title: 'Align supplier terms with how customers pay you',
        tag: 'Terms',
        body:
          gapDays == null
            ? 'Once payables and receivables are both in the system, compare supplier due dates with customer payment dates — then negotiate terms or deposits to close any hole.'
            : gapDays > 5
              ? `Your data suggests customers pay on a slower timeline than your input costs (~${gapDays} day average gap). Negotiate longer supplier terms, staged payments, or smaller order sizes so outflows line up closer to when clients pay.`
              : gapDays < -3
                ? 'You tend to collect before the heaviest supplier dues — good pattern. Still use deposits where margin is thin so one late customer doesn’t strand you.'
                : 'If customers pay slower than you pay suppliers, stretch vendor terms or bring forward customer cash (deposits, shorter invoice terms). If the gap is small, discipline on both sides still matters.'
      }
    ];

    return {
      totalInput,
      totalAR,
      gapDays,
      topSupplier,
      topRec,
      sortedRecs,
      overlapFloat,
      narrativeShort,
      narrativeDetail,
      actions,
      hasData: obligations.length > 0 || receivables.length > 0
    };
  }, [obligations, receivables]);

  return React.createElement('div', null,
    React.createElement('div', { className: 'page-header' },
      React.createElement('div', { className: 'page-title' }, 'Reality'),
      React.createElement('div', { className: 'page-sub' },
        'When your cash funds customers before it funds you — and what to do about it')
    ),

    React.createElement('div', { className: 'card section-gap reality-hero' },
      React.createElement('div', { className: 'card-title' }, 'The hidden loan to your clients'),
      React.createElement('div', { className: 'reality-lead' }, model.narrativeShort),
      React.createElement('p', { className: 'reality-detail' }, model.narrativeDetail),
      model.overlapFloat > 0 && model.hasData && React.createElement('div', { className: 'reality-float-hint' },
        React.createElement('span', { className: 'badge badge-warn' }, 'Working capital overlap'),
        ` On the order of ₹${roundRupeeForCopy(model.overlapFloat).toLocaleString()} sits between what you owe on inputs and what you’re still owed — money in motion, not in your pocket.`)
    ),

    React.createElement('div', { className: 'grid-3 section-gap' },
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-label' }, 'Input-side payables (approx.)'),
        React.createElement('div', { className: 'stat-value warn' }, '≈ ₹' + roundRupeeForCopy(model.totalInput).toLocaleString()),
        React.createElement('div', { className: 'stat-sub' }, 'Suppliers, utilities, COGS-style — rounded on this page')
      ),
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-label' }, 'Still in receivables (approx.)'),
        React.createElement('div', { className: 'stat-value', style: { color: 'var(--accent2)' } }, '≈ ₹' + roundRupeeForCopy(model.totalAR).toLocaleString()),
        React.createElement('div', { className: 'stat-sub' }, 'Outstanding from customers — see Receivables for exacts')
      ),
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-label' }, 'Timing gap (avg. days)'),
        React.createElement('div', {
          className: `stat-value ${
            model.gapDays == null ? '' : model.gapDays > 5 ? 'red' : model.gapDays < -3 ? 'green' : 'warn'
          }`
        }, model.gapDays == null ? '—' : `${model.gapDays > 0 ? '+' : ''}${model.gapDays}`),
        React.createElement('div', { className: 'stat-sub' },
          model.gapDays == null
            ? 'Need receivables and input-style payables to estimate'
            : 'Positive = you wait longer to collect than to pay inputs (you fund the gap)')
      )
    ),

    React.createElement('div', { className: 'card section-gap' },
      React.createElement('div', { className: 'card-title' }, 'Suggested moves (from your books)'),
      React.createElement('div', { className: 'reality-actions' },
        model.actions.map((a, i) =>
          React.createElement('div', { key: i, className: 'reality-action' },
            React.createElement('div', { className: 'reality-action-head' },
              React.createElement('span', { className: 'reality-action-title' }, a.title),
              React.createElement('span', { className: 'badge badge-blue' }, a.tag)
            ),
            React.createElement('p', { className: 'reality-action-body' }, a.body)
          ))
      )
    ),

    model.sortedRecs.length > 0 && React.createElement('div', { className: 'card section-gap' },
      React.createElement('div', { className: 'card-title' }, 'Collection priority (largest first)'),
      React.createElement('p', { style: { fontSize: 13, color: 'var(--text2)', marginBottom: 12 } },
        'Largest balances first — amounts and timing are rounded so this stays a briefing, not a full invoice list. Use Receivables for exact names and figures.'),
      React.createElement('table', { className: 'table' },
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', null, 'Rank'),
            React.createElement('th', null, 'Timing'),
            React.createElement('th', null, 'Approx. balance'),
            React.createElement('th', null, '')
          )
        ),
        React.createElement('tbody', null,
          model.sortedRecs.slice(0, 8).map((r, idx) =>
            React.createElement('tr', { key: r.id || idx },
              React.createElement('td', null,
                React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' } }, `#${idx + 1}`)),
              React.createElement('td', null, receivableTimingBucket(r.expectedDate)),
              React.createElement('td', null,
                React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12 } }, '≈ ₹' + roundRupeeForCopy(r.amount).toLocaleString())),
              React.createElement('td', null,
                idx === 0
                  ? React.createElement('span', { className: 'badge badge-warn' }, 'Call first')
                  : React.createElement('span', { className: 'badge badge-gray' }, 'Next')
              )
            ))
        )
      )
    ),

    React.createElement('div', { className: 'reasoning-box section-gap', style: { marginBottom: 0 } },
      React.createElement('span', { className: 'cot-label' }, 'How to read this'),
      'PocketCFO uses your obligations (especially supplier- and cost-like lines) and receivables to illustrate the working-capital gap. It is not tax or legal advice — use it to steer conversations with customers and suppliers and to prioritize collections before you add more supplier spend.'
    )
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ balance, obligations, receivables }) {
  const prioritized = prioritizeObligations(obligations, balance, receivables);
  const runway = computeRunway(balance, obligations, receivables);
  const totalObl = obligations.reduce((s, o) => s + o.amount, 0);
  const totalRec = receivables.reduce((s, r) => s + r.amount, 0);
  const runwayPct = Math.min(100, (runway.days / 90) * 100);
  const runwayColor = runway.days < 7 ? '#ff4757' : runway.days < 14 ? '#ffa502' : '#00e5a0';

  const upcomingWeek = obligations.filter(o => {
    const d = Math.floor((new Date(o.dueDate) - new Date()) / 86400000);
    return d >= 0 && d <= 7;
  });

  return React.createElement('div', null,
    React.createElement('div', { className: 'page-header' },
      React.createElement('div', { className: 'page-title' }, 'Financial Overview'),
      React.createElement('div', { className: 'page-sub' }, 'Real-time cash position and upcoming obligations')
    ),

    runway.shortfall > 0 && React.createElement('div', {
      className: 'section-gap',
      style: {
        background: 'rgba(255,71,87,0.08)', border: '1px solid rgba(255,71,87,0.3)',
        borderRadius: 10, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12
      }
    },
      React.createElement('span', { style: { fontSize: 20 } }, '⚠'),
      React.createElement('div', null,
        React.createElement('div', { style: { fontFamily: 'Syne', fontWeight: 700, color: 'var(--danger)', marginBottom: 2 } }, 'Cash Shortfall Detected'),
        React.createElement('div', { style: { fontSize: 13, color: 'var(--text2)' } },
          `₹${runway.shortfall.toLocaleString()} shortfall on "${runway.nextCrisis?.name}". Go to Actions for recommendations.`)
      )
    ),

    React.createElement('div', { className: 'grid-4 section-gap' },
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-label' }, 'Cash Balance'),
        React.createElement('div', { className: `stat-value ${balance < totalObl ? 'red' : 'green'}` }, '₹' + balance.toLocaleString()),
        React.createElement('div', { className: 'stat-sub' }, 'Available now')
      ),
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-label' }, 'Total Payables'),
        React.createElement('div', { className: 'stat-value red' }, '₹' + totalObl.toLocaleString()),
        React.createElement('div', { className: 'stat-sub' }, `${obligations.length} obligations`)
      ),
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-label' }, 'Expected Receivables'),
        React.createElement('div', { className: 'stat-value', style: { color: '#0091ff' } }, '₹' + totalRec.toLocaleString()),
        React.createElement('div', { className: 'stat-sub' }, `${receivables.length} invoices`)
      ),
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-label' }, 'Days to Zero'),
        React.createElement('div', { className: `stat-value ${runway.days < 7 ? 'red' : runway.days < 14 ? 'warn' : 'green'}` },
          runway.days >= 90 ? '90+' : runway.days),
        React.createElement('div', { className: 'runway-bar' },
          React.createElement('div', { className: 'runway-fill', style: { width: runwayPct + '%', background: runwayColor } })
        )
      )
    ),

    React.createElement('div', { className: 'grid-2 section-gap' },
      React.createElement('div', { className: 'card' },
        React.createElement('div', { className: 'card-title' }, 'Obligation Priority Queue'),
        React.createElement('table', { className: 'table' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, 'Obligation'),
              React.createElement('th', null, 'Due'),
              React.createElement('th', null, 'Amount'),
              React.createElement('th', null, 'Status')
            )
          ),
          React.createElement('tbody', null,
            prioritized.slice(0, 6).map(o =>
              React.createElement('tr', { key: o.id },
                React.createElement('td', null,
                  React.createElement('div', { style: { color: 'var(--text)', fontWeight: 500 } }, o.name),
                  React.createElement('span', { className: `priority ${o.urgency}` },
                    o.urgency === 'critical' ? '● ' : o.urgency === 'high' ? '◆ ' : '◇ ',
                    o.urgency.toUpperCase()
                  )
                ),
                React.createElement('td', null,
                  React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12 } },
                    o.daysLeft <= 0 ? 'TODAY' : `${o.daysLeft}d`)
                ),
                React.createElement('td', null, React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12 } }, '₹' + o.amount.toLocaleString())),
                React.createElement('td', null,
                  React.createElement('span', { className: `badge ${o.canPay ? 'badge-green' : 'badge-red'}` },
                    o.canPay ? 'CAN PAY' : 'SHORTFALL')
                )
              )
            )
          )
        )
      ),

      React.createElement('div', { className: 'card' },
        React.createElement('div', { className: 'card-title' }, 'Projected Cash Flow (30d)'),
        CashFlowChart({ balance, obligations, receivables }),
        React.createElement('div', { style: { marginTop: 16 } },
          React.createElement('div', { className: 'card-title' }, "This Week's Obligations"),
          upcomingWeek.length === 0
            ? React.createElement('div', { style: { color: 'var(--text3)', fontSize: 13, padding: '8px 0' } }, 'No obligations due this week')
            : upcomingWeek.map(o => React.createElement('div', {
                key: o.id,
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }
              },
                React.createElement('span', { style: { fontSize: 13, color: 'var(--text2)' } }, o.name),
                React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12, color: 'var(--danger)' } }, '₹' + o.amount.toLocaleString())
              ))
        )
      )
    ),

    React.createElement(BusinessSurvivalSimulator, { balance, obligations, receivables }),
    React.createElement(CashFlowTimeline, { balance, obligations, receivables })
  );
}

// ─── OBLIGATIONS ──────────────────────────────────────────────────────────────
function Obligations({ obligations, setObligations, addToast }) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'other', amount: '', dueDate: '', vendor: '', flexible: false, penalty: '' });

  const add = () => {
    if (!form.name || !form.amount || !form.dueDate) { addToast('Fill required fields', 'error'); return; }
    setObligations(prev => [...prev, { ...form, id: Date.now(), amount: parseFloat(form.amount) }]);
    setShowModal(false);
    setForm({ name: '', category: 'other', amount: '', dueDate: '', vendor: '', flexible: false, penalty: '' });
    addToast('Obligation added', 'success');
  };

  const remove = (id) => setObligations(prev => prev.filter(o => o.id !== id));

  return React.createElement('div', null,
    React.createElement('div', { className: 'page-header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
      React.createElement('div', null,
        React.createElement('div', { className: 'page-title' }, 'Obligations'),
        React.createElement('div', { className: 'page-sub' }, 'Manage upcoming payables and commitments')
      ),
      React.createElement('button', { className: 'btn btn-primary', onClick: () => setShowModal(true) }, '+ Add Obligation')
    ),

    React.createElement('div', { className: 'card' },
      obligations.length === 0
        ? React.createElement('div', { className: 'empty' },
            React.createElement('div', { className: 'icon' }, '◉'),
            React.createElement('div', { className: 'title' }, 'No obligations yet'),
            React.createElement('div', { className: 'sub' }, 'Add your upcoming payments to get started')
          )
        : React.createElement('table', { className: 'table' },
            React.createElement('thead', null,
              React.createElement('tr', null,
                React.createElement('th', null, 'Name'),
                React.createElement('th', null, 'Category'),
                React.createElement('th', null, 'Amount'),
                React.createElement('th', null, 'Due Date'),
                React.createElement('th', null, 'Days Left'),
                React.createElement('th', null, 'Flexible'),
                React.createElement('th', null, 'Penalty'),
                React.createElement('th', null, '')
              )
            ),
            React.createElement('tbody', null,
              obligations.map(o => {
                const days = Math.floor((new Date(o.dueDate) - new Date()) / 86400000);
                const urgency = days <= 3 ? 'critical' : days <= 7 ? 'high' : days <= 14 ? 'medium' : 'low';
                return React.createElement('tr', { key: o.id },
                  React.createElement('td', null, React.createElement('span', { style: { color: 'var(--text)', fontWeight: 500 } }, o.name)),
                  React.createElement('td', null, React.createElement('span', { className: 'badge badge-blue' }, o.category)),
                  React.createElement('td', null, React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12 } }, '₹' + o.amount.toLocaleString())),
                  React.createElement('td', null, React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12 } }, o.dueDate)),
                  React.createElement('td', null,
                    React.createElement('span', { className: `priority ${urgency}` }, days <= 0 ? 'TODAY' : `${days}d`)
                  ),
                  React.createElement('td', null, React.createElement('span', { className: `badge ${o.flexible ? 'badge-green' : 'badge-red'}` }, o.flexible ? 'YES' : 'NO')),
                  React.createElement('td', null, React.createElement('span', { style: { fontSize: 12, color: 'var(--text3)' } }, o.penalty || '—')),
                  React.createElement('td', null,
                    React.createElement('button', { className: 'btn btn-danger btn-sm', onClick: () => remove(o.id) }, '✕')
                  )
                );
              })
            )
          )
    ),

    showModal && React.createElement('div', { className: 'modal-overlay', onClick: () => setShowModal(false) },
      React.createElement('div', { className: 'modal', onClick: e => e.stopPropagation() },
        React.createElement('div', { className: 'modal-header' },
          React.createElement('div', { className: 'modal-title' }, 'New Obligation'),
          React.createElement('button', { className: 'close-btn', onClick: () => setShowModal(false) }, '✕')
        ),
        React.createElement('div', { className: 'modal-body' },
          React.createElement('div', { className: 'grid-2' },
            React.createElement('div', { className: 'form-group' },
              React.createElement('label', { className: 'form-label' }, 'Name *'),
              React.createElement('input', { className: 'input', value: form.name, onChange: e => setForm(f => ({ ...f, name: e.target.value })), placeholder: 'e.g. Staff Payroll' })
            ),
            React.createElement('div', { className: 'form-group' },
              React.createElement('label', { className: 'form-label' }, 'Category'),
              React.createElement('select', {
                className: 'select', style: { width: '100%' },
                value: form.category, onChange: e => setForm(f => ({ ...f, category: e.target.value }))
              },
                ['payroll', 'tax', 'rent', 'loan', 'supplier', 'utility', 'other'].map(c =>
                  React.createElement('option', { key: c, value: c }, c.charAt(0).toUpperCase() + c.slice(1))
                )
              )
            ),
            React.createElement('div', { className: 'form-group' },
              React.createElement('label', { className: 'form-label' }, 'Amount (₹) *'),
              React.createElement('input', { className: 'input', type: 'number', value: form.amount, onChange: e => setForm(f => ({ ...f, amount: e.target.value })), placeholder: '0' })
            ),
            React.createElement('div', { className: 'form-group' },
              React.createElement('label', { className: 'form-label' }, 'Due Date *'),
              React.createElement('input', { className: 'input', type: 'date', value: form.dueDate, onChange: e => setForm(f => ({ ...f, dueDate: e.target.value })) })
            ),
            React.createElement('div', { className: 'form-group' },
              React.createElement('label', { className: 'form-label' }, 'Vendor Name'),
              React.createElement('input', { className: 'input', value: form.vendor, onChange: e => setForm(f => ({ ...f, vendor: e.target.value })), placeholder: 'Counterparty name' })
            ),
            React.createElement('div', { className: 'form-group' },
              React.createElement('label', { className: 'form-label' }, 'Penalty if Late'),
              React.createElement('input', { className: 'input', value: form.penalty, onChange: e => setForm(f => ({ ...f, penalty: e.target.value })), placeholder: 'e.g. 2% per month' })
            )
          ),
          React.createElement('div', { className: 'form-group', style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('input', { type: 'checkbox', id: 'flex', checked: form.flexible, onChange: e => setForm(f => ({ ...f, flexible: e.target.checked })) }),
            React.createElement('label', { htmlFor: 'flex', style: { fontSize: 13, color: 'var(--text2)', cursor: 'pointer' } }, 'Payment date is flexible / negotiable')
          )
        ),
        React.createElement('div', { className: 'modal-footer' },
          React.createElement('button', { className: 'btn btn-secondary', onClick: () => setShowModal(false) }, 'Cancel'),
          React.createElement('button', { className: 'btn btn-primary', onClick: add }, 'Add Obligation')
        )
      )
    )
  );
}

// ─── RECEIVABLES ──────────────────────────────────────────────────────────────
function Receivables({ receivables, setReceivables, addToast }) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ from: '', amount: '', expectedDate: '', status: 'pending' });

  const add = () => {
    if (!form.from || !form.amount || !form.expectedDate) { addToast('Fill required fields', 'error'); return; }
    setReceivables(prev => [...prev, { ...form, id: Date.now(), amount: parseFloat(form.amount) }]);
    setShowModal(false);
    setForm({ from: '', amount: '', expectedDate: '', status: 'pending' });
    addToast('Receivable added', 'success');
  };

  return React.createElement('div', null,
    React.createElement('div', { className: 'page-header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
      React.createElement('div', null,
        React.createElement('div', { className: 'page-title' }, 'Receivables'),
        React.createElement('div', { className: 'page-sub' }, 'Track incoming payments and invoices')
      ),
      React.createElement('button', { className: 'btn btn-primary', onClick: () => setShowModal(true) }, '+ Add Receivable')
    ),
    React.createElement('div', { className: 'card' },
      receivables.length === 0
        ? React.createElement('div', { className: 'empty' },
            React.createElement('div', { className: 'icon' }, '◎'),
            React.createElement('div', { className: 'title' }, 'No receivables yet')
          )
        : React.createElement('table', { className: 'table' },
            React.createElement('thead', null,
              React.createElement('tr', null,
                React.createElement('th', null, 'From'),
                React.createElement('th', null, 'Amount'),
                React.createElement('th', null, 'Expected Date'),
                React.createElement('th', null, 'Days Away'),
                React.createElement('th', null, 'Status'),
                React.createElement('th', null, '')
              )
            ),
            React.createElement('tbody', null,
              receivables.map(r => {
                const days = Math.floor((new Date(r.expectedDate) - new Date()) / 86400000);
                return React.createElement('tr', { key: r.id },
                  React.createElement('td', null, React.createElement('span', { style: { color: 'var(--text)', fontWeight: 500 } }, r.from)),
                  React.createElement('td', null, React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12, color: 'var(--accent)' } }, '₹' + r.amount.toLocaleString())),
                  React.createElement('td', null, React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12 } }, r.expectedDate)),
                  React.createElement('td', null, React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12 } }, `${days}d`)),
                  React.createElement('td', null, React.createElement('span', { className: `badge ${r.status === 'confirmed' ? 'badge-green' : 'badge-warn'}` }, r.status)),
                  React.createElement('td', null,
                    React.createElement('button', { className: 'btn btn-danger btn-sm', onClick: () => setReceivables(prev => prev.filter(x => x.id !== r.id)) }, '✕')
                  )
                );
              })
            )
          )
    ),
    showModal && React.createElement('div', { className: 'modal-overlay', onClick: () => setShowModal(false) },
      React.createElement('div', { className: 'modal', onClick: e => e.stopPropagation() },
        React.createElement('div', { className: 'modal-header' },
          React.createElement('div', { className: 'modal-title' }, 'New Receivable'),
          React.createElement('button', { className: 'close-btn', onClick: () => setShowModal(false) }, '✕')
        ),
        React.createElement('div', { className: 'modal-body' },
          React.createElement('div', { className: 'grid-2' },
            React.createElement('div', { className: 'form-group' },
              React.createElement('label', { className: 'form-label' }, 'From (Client) *'),
              React.createElement('input', { className: 'input', value: form.from, onChange: e => setForm(f => ({ ...f, from: e.target.value })), placeholder: 'Client name' })
            ),
            React.createElement('div', { className: 'form-group' },
              React.createElement('label', { className: 'form-label' }, 'Amount (₹) *'),
              React.createElement('input', { className: 'input', type: 'number', value: form.amount, onChange: e => setForm(f => ({ ...f, amount: e.target.value })) })
            ),
            React.createElement('div', { className: 'form-group' },
              React.createElement('label', { className: 'form-label' }, 'Expected Date *'),
              React.createElement('input', { className: 'input', type: 'date', value: form.expectedDate, onChange: e => setForm(f => ({ ...f, expectedDate: e.target.value })) })
            ),
            React.createElement('div', { className: 'form-group' },
              React.createElement('label', { className: 'form-label' }, 'Status'),
              React.createElement('select', {
                className: 'select', style: { width: '100%' },
                value: form.status, onChange: e => setForm(f => ({ ...f, status: e.target.value }))
              },
                ['pending', 'confirmed', 'overdue'].map(s =>
                  React.createElement('option', { key: s, value: s }, s.charAt(0).toUpperCase() + s.slice(1))
                )
              )
            )
          )
        ),
        React.createElement('div', { className: 'modal-footer' },
          React.createElement('button', { className: 'btn btn-secondary', onClick: () => setShowModal(false) }, 'Cancel'),
          React.createElement('button', { className: 'btn btn-primary', onClick: add }, 'Add Receivable')
        )
      )
    )
  );
}

// ─── TRANSACTIONS (History + Gmail) ───────────────────────────────────────────
function TransactionHistory({ balance, setStartingBankBalance, transactions, setTransactions, setObligations, setReceivables, addToast }) {
  const [tab, setTab] = useState('history');
  const BACKEND_BASE = 'http://localhost:8080';

  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailEmail, setGmailEmail] = useState('');
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailLastSync, setGmailLastSync] = useState(null);
  const [autoSync, setAutoSync] = useState(false);
  const [gmailTransactions, setGmailTransactions] = useState([]);
  const [lookbackDays, setLookbackDays] = useState(7);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceDragging, setInvoiceDragging] = useState(false);
  const [useCloudOCR, setUseCloudOCR] = useState(false);
  const [invoiceResults, setInvoiceResults] = useState([]);
  const invoiceFileRef = useRef();

  const checkGmailStatus = async (silent = false) => {
    setGmailLoading(true);
    try {
      const res = await fetch(`${BACKEND_BASE}/api/gmail/status`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch Gmail status');
      setGmailConnected(!!data.connected);
      setGmailEmail(data.email || '');
      if (!silent && data.connected && data.email) addToast(`Connected Gmail: ${data.email}`, 'success');
      if (!silent && !data.connected) addToast('Gmail not connected yet', 'error');
      return data;
    } catch (e) {
      if (!silent) addToast(e.message, 'error');
      setGmailConnected(false);
      setGmailEmail('');
      return { connected: false };
    } finally {
      setGmailLoading(false);
    }
  };

  const syncGmail = async (silent = false) => {
    setGmailLoading(true);
    try {
      const res = await fetch(`${BACKEND_BASE}/api/gmail/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sinceDays: lookbackDays, maxResults: 50 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gmail sync failed');

      const imported = data.transactions || [];
      if (!silent) {
        addToast(imported.length ? `Imported ${imported.length} transaction(s) from Gmail` : 'No new Gmail transactions found', 'success');
      }

      let latestBalance = null;
      imported.forEach(t => { if (typeof t.balance === 'number') latestBalance = t.balance; });

      const historyEntries = imported.map(t => ({
        id: t.id || (Date.now() + Math.floor(Math.random() * 1000000)),
        date: t.date,
        description: t.description || t.counterparty || (t.type === 'debit' ? 'Debit' : 'Credit'),
        amount: t.amount,
        type: t.type,
        counterparty: t.counterparty || '',
        reference: t.reference || '',
        source: 'gmail',
        status: 'completed'
      }));

      if (historyEntries.length || latestBalance !== null) {
        setTransactions(prev => {
          const next = historyEntries.length ? [...historyEntries, ...prev] : prev;
          if (latestBalance !== null) {
            const net = netFromTransactions(next);
            setStartingBankBalance(latestBalance - net);
            if (!silent) addToast(`Balance aligned to bank SMS: ₹${latestBalance.toLocaleString()}`, 'success');
          }
          return next;
        });
      }

      setGmailTransactions(imported);
      setGmailLastSync(data.fetchedAt || new Date().toISOString());
      setGmailConnected(true);
      return imported;
    } catch (e) {
      if (!silent) addToast(e.message, 'error');
      setGmailTransactions([]);
      return [];
    } finally {
      setGmailLoading(false);
    }
  };

  const resetGmailImport = async () => {
    setGmailLoading(true);
    try {
      const res = await fetch(`${BACKEND_BASE}/api/gmail/reset`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reset failed');
      addToast('Gmail import memory cleared. You can sync again.', 'success');
      return data;
    } catch (e) {
      addToast(e.message, 'error');
      return null;
    } finally {
      setGmailLoading(false);
    }
  };

  const disconnectGmail = async () => {
    setGmailLoading(true);
    try {
      const res = await fetch(`${BACKEND_BASE}/api/gmail/disconnect`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Disconnect failed');
      setGmailConnected(false);
      setGmailEmail('');
      setAutoSync(false);
      setGmailTransactions([]);
      setGmailLastSync(null);
      addToast('Gmail disconnected. Click "Connect Gmail" to re-link.', 'success');
      return data;
    } catch (e) {
      addToast(e.message, 'error');
      return null;
    } finally {
      setGmailLoading(false);
    }
  };

  const importInvoices = async (fileList) => {
    if (!fileList || !fileList.length) return;
    setInvoiceLoading(true);
    let added = 0;
    const runResults = [];
    try {
      for (const file of fileList) {
        try {
          let text = await extractDocumentTextLocal(file);
          let extraction = 'local';
          const confidence = assessExtractionConfidence(text, file.name);
          if (confidence.isLow && useCloudOCR) {
            text = await extractTextWithCloudOCR(file);
            extraction = 'cloud';
          }

          const invoices = parseInvoicePages(text);
          if (!invoices.length) {
            runResults.push({ file: file.name, status: 'error', msg: 'No invoice data found' });
            continue;
          }

          // By default, uploaded invoices are treated as payables (Obligations).
          setObligations(prev => {
            const seen = new Set(prev.map(o => `${o.vendor || ''}|${o.invoiceNumber || ''}|${o.amount || 0}|${o.dueDate || ''}`));
            const mapped = invoices.map((inv, i) => ({
              id: Date.now() + i + Math.random(),
              name: inv.invoiceNumber ? `${inv.vendor} • ${inv.invoiceNumber}` : `${inv.vendor} Invoice`,
              amount: Number(inv.total) || 0,
              dueDate: inv.dueDate || inv.invoiceDate || new Date().toISOString().slice(0, 10),
              vendor: inv.vendor || 'Unknown Vendor',
              category: 'supplier',
              flexible: false,
              penalty: 'Late payment risk',
              invoiceNumber: inv.invoiceNumber || '',
              invoiceDate: inv.invoiceDate || '',
              sourceType: 'invoice'
            })).filter(o => {
              const key = `${o.vendor}|${o.invoiceNumber}|${o.amount}|${o.dueDate}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            added += mapped.length;
            return [...prev, ...mapped];
          });

          runResults.push({
            file: file.name,
            status: 'success',
            msg: `${invoices.length} invoice(s) parsed via ${extraction}`,
          });
        } catch (e) {
          runResults.push({ file: file.name, status: 'error', msg: e.message });
        }
      }

      setInvoiceResults(prev => [...runResults, ...prev].slice(0, 20));
      addToast(added > 0 ? `Imported ${added} invoice transaction(s)` : 'No new invoice transactions imported', added > 0 ? 'success' : 'error');
    } finally {
      setInvoiceLoading(false);
    }
  };

  useEffect(() => {
    checkGmailStatus(true).catch(() => null);
  }, []);

  useEffect(() => {
    if (!autoSync || !gmailConnected) return undefined;
    const timer = setInterval(() => {
      syncGmail(true).catch(() => null);
    }, 60000);
    return () => clearInterval(timer);
  }, [autoSync, gmailConnected, lookbackDays]);

  return React.createElement('div', null,
    React.createElement('div', { className: 'page-header' },
      React.createElement('div', { className: 'page-title' }, 'Transactions'),
      React.createElement('div', { className: 'page-sub' }, 'Gmail-synced transaction alerts + your full history')
    ),

    React.createElement('div', { className: 'tabs' },
      ['history', 'gmail', 'invoice'].map(t => React.createElement('div', {
        key: t, className: `tab ${tab === t ? 'active' : ''}`,
        onClick: () => setTab(t)
      }, t === 'history' ? '⟲ History' : t === 'gmail' ? '✉ Gmail Auto-Import' : '⊕ Invoice Upload'))
    ),

    tab === 'history' && React.createElement('div', { className: 'section-gap' },
      React.createElement('div', { className: 'grid-2 section-gap' },
        React.createElement('div', { className: 'stat-card' },
          React.createElement('div', { className: 'stat-label' }, 'Cash Balance'),
          React.createElement('div', { className: 'stat-value green' }, '₹' + (balance || 0).toLocaleString()),
          React.createElement('div', { className: 'stat-sub' }, 'Opening balance ± transaction history (Gmail SMS can realign)')
        ),
        React.createElement('div', { className: 'stat-card' },
          React.createElement('div', { className: 'stat-label' }, 'Transactions'),
          React.createElement('div', { className: 'stat-value', style: { color: '#0091ff' } }, (transactions || []).length.toLocaleString()),
          React.createElement('div', { className: 'stat-sub' }, 'Full history list')
        )
      ),

      React.createElement('div', { className: 'card' },
        React.createElement('div', { className: 'card-title' }, 'History'),
        (transactions || []).length === 0
          ? React.createElement('div', { className: 'empty' },
            React.createElement('div', { className: 'icon' }, '⊕'),
            React.createElement('div', { className: 'title' }, 'No transactions yet'),
            React.createElement('div', { className: 'sub' }, 'Use Gmail Auto-Import to populate your history')
          )
          : React.createElement('table', { className: 'table' },
            React.createElement('thead', null,
              React.createElement('tr', null,
                React.createElement('th', null, 'Date'),
                React.createElement('th', null, 'Description'),
                React.createElement('th', null, 'Type'),
                React.createElement('th', null, 'Amount'),
                React.createElement('th', null, 'Status'),
                React.createElement('th', null, 'Source')
              )
            ),
            React.createElement('tbody', null,
              (transactions || []).slice(0, 100).map(t =>
                React.createElement('tr', { key: t.id },
                  React.createElement('td', null, React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12 } }, t.date || '—')),
                  React.createElement('td', null, React.createElement('span', { style: { color: 'var(--text)', fontWeight: 500 } }, (t.description || '').slice(0, 60))),
                  React.createElement('td', null, React.createElement('span', { className: `badge ${t.type === 'credit' ? 'badge-green' : 'badge-red'}` }, t.type || '—')),
                  React.createElement('td', null,
                    React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12, color: t.type === 'credit' ? 'var(--accent)' : 'var(--danger)' } },
                      `${t.type === 'credit' ? '+' : '-'}₹${(t.amount || 0).toLocaleString()}`
                    )
                  ),
                  React.createElement('td', null, React.createElement('span', { className: 'badge badge-gray' }, t.status || 'completed')),
                  React.createElement('td', null, React.createElement('span', { className: 'badge badge-blue' }, t.source || '—'))
                )
              )
            )
          )
      )
    ),

    tab === 'gmail' && React.createElement('div', { className: 'section-gap' },
      React.createElement('div', { className: 'card', style: { marginBottom: 16 } },
        React.createElement('div', { className: 'card-title' }, 'Gmail Auto-Import'),
        React.createElement('div', { style: { display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' } },
          React.createElement('div', null,
            React.createElement('div', { style: { fontSize: 13, color: 'var(--text)', fontWeight: 700 } }, gmailConnected ? 'Connected' : 'Not connected'),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--text2)', marginTop: 4 } }, gmailConnected ? gmailEmail : 'Connect your Gmail to auto-import UPI debit/credit alerts')
          ),
          React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' } },
            React.createElement('button', {
              className: 'btn btn-primary',
              onClick: () => { window.location.href = `${BACKEND_BASE}/auth/google/start`; },
              disabled: gmailLoading
            }, gmailLoading ? React.createElement('span', { className: 'loader' }) : 'Connect Gmail'),
            React.createElement('button', { className: 'btn btn-secondary', onClick: () => checkGmailStatus(false), disabled: gmailLoading }, 'Check status')
          )
        ),
        React.createElement('div', { className: 'reasoning-box', style: { marginTop: 16, borderColor: 'rgba(0,229,160,0.18)' } },
          React.createElement('div', { style: { fontWeight: 700, marginBottom: 6, color: 'var(--text)' } }, 'How it works'),
          React.createElement('div', null, 'Every minute, we poll Gmail for new transaction-alert emails and add them into your Transactions history.')
        )
      ),

      React.createElement('div', { className: 'card' },
        React.createElement('div', { className: 'card-title' }, 'Sync'),
        React.createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' } },
          React.createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            React.createElement('button', { className: 'btn btn-primary', onClick: () => syncGmail(false), disabled: gmailLoading || !gmailConnected },
              gmailLoading ? React.createElement('span', { className: 'loader' }) : 'Sync now'
            ),
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              React.createElement('span', { style: { fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' } }, 'LOOKBACK (DAYS)'),
              React.createElement('input', {
                className: 'input',
                type: 'number',
                min: 1,
                max: 30,
                value: lookbackDays,
                onChange: e => setLookbackDays(Math.min(30, Math.max(1, parseInt(e.target.value || '7', 10)))),
                style: { width: 90, padding: '6px 10px', fontSize: 13, fontFamily: 'DM Mono' }
              })
            ),
            React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: gmailConnected ? 'pointer' : 'not-allowed', color: 'var(--text2)', fontSize: 13 } },
              React.createElement('input', { type: 'checkbox', checked: autoSync, onChange: e => setAutoSync(e.target.checked), disabled: !gmailConnected }),
              'Auto-sync every 60s'
            )
          ),
          React.createElement('div', { style: { fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' } },
            gmailLastSync ? `Last sync: ${new Date(gmailLastSync).toLocaleString()}` : 'No sync yet'
          )
        ),

        React.createElement('div', { style: { display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' } },
          React.createElement('button', { className: 'btn btn-secondary', onClick: resetGmailImport, disabled: gmailLoading || !gmailConnected }, 'Reset import memory'),
          React.createElement('button', { className: 'btn btn-danger', onClick: disconnectGmail, disabled: gmailLoading || !gmailConnected }, 'Disconnect Gmail')
        ),

        gmailTransactions.length > 0
          ? React.createElement('div', { style: { marginTop: 16 } },
            React.createElement('div', { className: 'card-title', style: { marginBottom: 10 } }, `Imported (${gmailTransactions.length})`),
            React.createElement('div', { className: 'timeline' },
              gmailTransactions.slice(0, 10).map((t, i) =>
                React.createElement('div', { key: t.id || i, className: 'timeline-item' },
                  React.createElement('div', { className: 'timeline-dot', style: { background: t.type === 'credit' ? 'var(--accent)' : 'var(--danger)' } }),
                  React.createElement('div', { className: 'timeline-content' },
                    React.createElement('span', { className: 'timeline-amount', style: { color: t.type === 'credit' ? 'var(--accent)' : 'var(--danger)' } },
                      `${t.type === 'credit' ? '+' : '-'}₹${t.amount?.toLocaleString()}`
                    ),
                    React.createElement('span', { style: { color: 'var(--text3)', fontSize: 12, marginLeft: 8, whiteSpace: 'nowrap' } },
                      `${(t.date || '').toString().replace('T', ' ')}${t.counterparty ? ` • ${t.counterparty}` : ''}`
                    )
                  )
                )
              )
            )
          )
          : React.createElement('div', { className: 'empty', style: { marginTop: 16 } },
            React.createElement('div', { className: 'icon' }, '✉'),
            React.createElement('div', { className: 'title' }, 'Nothing imported yet'),
            React.createElement('div', { className: 'sub' }, 'Click "Sync now" to import new Gmail transaction alerts')
          )
      )
    ),

    tab === 'invoice' && React.createElement('div', { className: 'section-gap' },
      React.createElement('div', { className: 'card', style: { marginBottom: 16 } },
        React.createElement('div', { className: 'card-title' }, 'Invoice Upload'),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
        React.createElement('div', { style: { fontSize: 13, color: 'var(--text2)' } }, 'Upload PDF/image invoices. Extracted invoices are added to Obligations by default.'),
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text2)', fontSize: 13, cursor: 'pointer' } },
            React.createElement('input', { type: 'checkbox', checked: useCloudOCR, onChange: e => setUseCloudOCR(e.target.checked) }),
            'Enable cloud OCR fallback'
          )
        )
      ),

      React.createElement('div', {
        className: `upload-zone ${invoiceDragging ? 'drag' : ''}`,
        onClick: () => invoiceFileRef.current && invoiceFileRef.current.click(),
        onDragOver: e => { e.preventDefault(); setInvoiceDragging(true); },
        onDragLeave: () => setInvoiceDragging(false),
        onDrop: e => {
          e.preventDefault();
          setInvoiceDragging(false);
          importInvoices([...(e.dataTransfer.files || [])]);
        }
      },
        React.createElement('div', { className: 'icon' }, '⊕'),
        React.createElement('div', { className: 'title' }, 'Drop invoice files or click to browse'),
        React.createElement('div', { className: 'sub' }, 'Supported: PDF, JPG, JPEG, PNG'),
        React.createElement('input', {
          ref: invoiceFileRef,
          type: 'file',
          multiple: true,
          accept: '.pdf,.jpg,.jpeg,.png',
          style: { display: 'none' },
          onChange: e => importInvoices([...(e.target.files || [])])
        })
      ),

      invoiceLoading && React.createElement('div', { style: { textAlign: 'center', padding: '20px', color: 'var(--text2)', fontSize: 13 } },
        React.createElement('span', { className: 'loader' }),
        React.createElement('span', { style: { marginLeft: 8 } }, ' Extracting invoice text...')
      ),

      invoiceResults.length > 0 && React.createElement('div', { className: 'card', style: { marginTop: 20 } },
        React.createElement('div', { className: 'card-title' }, 'Recent Invoice Imports'),
        invoiceResults.map((r, i) => React.createElement('div', { key: `${r.file}_${i}`, style: { padding: '10px 0', borderBottom: '1px solid var(--border)' } },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 5, gap: 10 } },
            React.createElement('span', { style: { fontWeight: 600, color: 'var(--text)', fontSize: 13 } }, r.file),
            React.createElement('span', { className: `badge ${r.status === 'success' ? 'badge-green' : 'badge-red'}` }, r.status)
          ),
          React.createElement('div', { style: { fontSize: 12, color: 'var(--text2)' } }, r.msg)
        ))
      )
    )
  );
}

// ─── FUTURE PAGE ──────────────────────────────────────────────────────────────
function FuturePage({ balance, obligations, receivables }) {
  const [activeMetric, setActiveMetric] = useState(null);

  const totalObl = obligations.reduce((s, o) => s + o.amount, 0);
  const totalRec = receivables.reduce((s, r) => s + r.amount, 0);
  const monthlyExpenses = totalObl;
  const monthlyRevenue = totalRec;
  const netBurn = monthlyExpenses - monthlyRevenue;
  const runwayMonths = netBurn > 0 ? (balance / Math.max(netBurn, 1)).toFixed(1) : '∞';

  const currentRatio = totalObl > 0 ? ((balance + totalRec) / totalObl).toFixed(2) : 'N/A';
  const burnRate = Math.max(0, netBurn);
  const operatingCashFlow = monthlyRevenue - Math.round(monthlyExpenses * 0.7);
  const arTurnover = totalRec > 0 ? (monthlyRevenue / Math.max(totalRec / 2, 1)).toFixed(2) : '0.00';
  const inventoryTurnover = totalObl > 0 ? (monthlyRevenue / Math.max(totalObl * 0.4, 1)).toFixed(2) : '0.00';
  const capexEstimate = Math.round(monthlyExpenses * 0.15);
  const opexEstimate = Math.round(monthlyExpenses * 0.85);

  const metrics = [
    {
      id: 'currentRatio',
      label: 'Current Ratio',
      value: currentRatio,
      unit: 'x',
      icon: '◈',
      description: 'Your ability to meet short-term obligations with available assets',
      formula: '(Cash + Receivables) / Total Payables',
      computed: `(₹${balance.toLocaleString()} + ₹${totalRec.toLocaleString()}) / ₹${totalObl.toLocaleString()}`,
      color: parseFloat(currentRatio) >= 1.5 ? '#00e5a0' : parseFloat(currentRatio) >= 1 ? '#ffa502' : '#ff4757',
      status: parseFloat(currentRatio) >= 1.5 ? 'Healthy' : parseFloat(currentRatio) >= 1 ? 'Borderline' : 'Critical',
      pathways: [
        {
          label: 'Conservative Path',
          color: '#00e5a0',
          description: 'You collect receivables on time and reduce obligations by 20%. Ratio climbs steadily and liquidity strengthens.',
          months: [1, 1.1, 1.25, 1.4, 1.6, 1.75, 2.1].map(m => parseFloat((parseFloat(currentRatio || 0) * m).toFixed(2)))
        },
        {
          label: 'Steady State',
          color: '#0091ff',
          description: 'Business continues at current pace. Ratio remains stable around current level with only a thin emergency buffer.',
          months: [1, 0.97, 1.02, 0.99, 1.01, 1.0, 1.03].map(m => parseFloat((parseFloat(currentRatio || 0) * m).toFixed(2)))
        },
        {
          label: 'High-Growth Strain',
          color: '#ff4757',
          description: 'Aggressive expansion increases obligations faster than receivables. Liquidity drops below safety levels.',
          months: [1, 0.88, 0.76, 0.65, 0.58, 0.52, 0.48].map(m => parseFloat((parseFloat(currentRatio || 0) * m).toFixed(2)))
        }
      ]
    },
    {
      id: 'burnRate',
      label: 'Burn Rate',
      value: burnRate > 0 ? `₹${Math.round(burnRate / 1000)}K` : '₹0',
      unit: '/mo',
      icon: '◎',
      description: `Net cash consumed per month. At current rate, runway is ${runwayMonths} months`,
      formula: 'Total Expenses − Total Revenue (monthly)',
      computed: `₹${monthlyExpenses.toLocaleString()} − ₹${monthlyRevenue.toLocaleString()} = ₹${netBurn.toLocaleString()}`,
      color: burnRate === 0 ? '#00e5a0' : burnRate < Math.max(balance, 1) * 0.1 ? '#ffa502' : '#ff4757',
      status: burnRate === 0 ? 'Cash Flow Positive' : burnRate < Math.max(balance, 1) * 0.1 ? 'Manageable' : 'High Burn',
      pathways: [
        {
          label: 'Controlled Burn',
          color: '#00e5a0',
          description: 'Reduce non-essential expenses by 30%. Runway extends significantly and profitability becomes realistic.',
          months: [burnRate, burnRate * 0.88, burnRate * 0.78, burnRate * 0.65, burnRate * 0.5, burnRate * 0.3, 0].map(v => Math.max(0, Math.round(v / 1000)))
        },
        {
          label: 'Revenue-Driven Recovery',
          color: '#0091ff',
          description: 'New revenue offsets burn gradually. Breakeven becomes possible within a few months.',
          months: [burnRate, burnRate * 0.85, burnRate * 0.7, burnRate * 0.5, burnRate * 0.2, 0, 0].map(v => Math.max(0, Math.round(v / 1000)))
        },
        {
          label: 'Unchecked Burn',
          color: '#ff4757',
          description: 'No action taken. Payroll and supplier costs compound and burn worsens every month.',
          months: [burnRate, burnRate * 1.1, burnRate * 1.22, burnRate * 1.35, burnRate * 1.5, burnRate * 1.65, burnRate * 1.8].map(v => Math.round(v / 1000))
        }
      ]
    },
    {
      id: 'operatingCashFlow',
      label: 'Operating Cash Flow',
      value: operatingCashFlow >= 0 ? `+₹${Math.round(operatingCashFlow / 1000)}K` : `-₹${Math.round(Math.abs(operatingCashFlow) / 1000)}K`,
      unit: '/mo',
      icon: '◫',
      description: 'Cash generated from core operations after essential costs',
      formula: 'Revenue − 70% of Operating Costs',
      computed: `₹${monthlyRevenue.toLocaleString()} − ₹${Math.round(monthlyExpenses * 0.7).toLocaleString()}`,
      color: operatingCashFlow >= 0 ? '#00e5a0' : '#ff4757',
      status: operatingCashFlow >= 0 ? 'Positive' : 'Negative',
      pathways: [
        {
          label: 'Margin Improvement',
          color: '#00e5a0',
          description: 'Upsell existing clients and automate workflows. Operating cash flow improves every month.',
          months: [1, 1.15, 1.3, 1.5, 1.7, 1.85, 2.0].map(m => Math.round(operatingCashFlow * m / 1000))
        },
        {
          label: 'Flat Operations',
          color: '#0091ff',
          description: 'Revenue and costs remain stable. OCF stays close to the current level.',
          months: [1, 1.02, 0.98, 1.01, 0.99, 1.0, 1.02].map(m => Math.round(operatingCashFlow * m / 1000))
        },
        {
          label: 'Cost Overrun Spiral',
          color: '#ff4757',
          description: 'Cloud infra, payroll and supplier costs increase. OCF turns negative and drains liquidity.',
          months: [1, 0.7, 0.4, 0.1, -0.3, -0.7, -1.1].map(m => Math.round(operatingCashFlow * m / 1000))
        }
      ]
    },
    {
      id: 'arTurnover',
      label: 'AR Turnover',
      value: arTurnover,
      unit: 'x',
      icon: '◆',
      description: 'How many times per month you collect outstanding customer payments',
      formula: 'Monthly Revenue / Avg. Accounts Receivable',
      computed: `₹${monthlyRevenue.toLocaleString()} / ₹${Math.round(totalRec / 2).toLocaleString()}`,
      color: parseFloat(arTurnover) >= 6 ? '#00e5a0' : parseFloat(arTurnover) >= 3 ? '#ffa502' : '#ff4757',
      status: parseFloat(arTurnover) >= 6 ? 'Fast Collections' : parseFloat(arTurnover) >= 3 ? 'Average' : 'Slow Collections',
      pathways: [
        {
          label: 'Tighter Credit Policy',
          color: '#00e5a0',
          description: 'Move clients to faster payment terms and automate reminders. Cash cycle shortens significantly.',
          months: [1, 1.2, 1.45, 1.7, 1.9, 2.1, 2.3].map(m => parseFloat((parseFloat(arTurnover || 0) * m).toFixed(2)))
        },
        {
          label: 'Status Quo Collections',
          color: '#0091ff',
          description: 'No process change. Collections remain predictable but cash stays tied up outside your account.',
          months: [1, 0.98, 1.01, 0.99, 1.0, 1.02, 1.0].map(m => parseFloat((parseFloat(arTurnover || 0) * m).toFixed(2)))
        },
        {
          label: 'Client Default Risk',
          color: '#ff4757',
          description: 'A key client delays payment and receivable turnover collapses, creating working-capital stress.',
          months: [1, 0.75, 0.55, 0.4, 0.3, 0.28, 0.25].map(m => parseFloat((parseFloat(arTurnover || 0) * m).toFixed(2)))
        }
      ]
    },
    {
      id: 'inventoryTurnover',
      label: 'Inventory Turnover',
      value: inventoryTurnover,
      unit: 'x/mo',
      icon: '◉',
      description: 'How quickly your business converts stock into revenue',
      formula: 'Monthly Revenue / (Avg. Inventory Cost)',
      computed: `₹${monthlyRevenue.toLocaleString()} / ₹${Math.round(totalObl * 0.4).toLocaleString()} (estimated)`,
      color: parseFloat(inventoryTurnover) >= 4 ? '#00e5a0' : '#ffa502',
      status: parseFloat(inventoryTurnover) >= 4 ? 'Efficient' : 'Moderate',
      pathways: [
        {
          label: 'Optimised Supply Chain',
          color: '#00e5a0',
          description: 'Supplier renegotiation and a faster sales cycle reduce holding time. Less cash is tied up in stock.',
          months: [1, 1.15, 1.32, 1.48, 1.6, 1.7, 1.75].map(m => parseFloat((parseFloat(inventoryTurnover || 0) * m).toFixed(2)))
        },
        {
          label: 'Market Expansion',
          color: '#ffa502',
          description: 'New demand temporarily increases inventory holding, then turnover recovers as revenue scales.',
          months: [1, 0.9, 0.85, 0.95, 1.1, 1.3, 1.5].map(m => parseFloat((parseFloat(inventoryTurnover || 0) * m).toFixed(2)))
        },
        {
          label: 'Demand Slowdown',
          color: '#ff4757',
          description: 'If sales slow, stock piles up and more cash gets locked into inventory.',
          months: [1, 0.8, 0.65, 0.5, 0.4, 0.38, 0.35].map(m => parseFloat((parseFloat(inventoryTurnover || 0) * m).toFixed(2)))
        }
      ]
    },
    {
      id: 'capexOpex',
      label: 'CapEx / OpEx',
      value: `${monthlyExpenses > 0 ? Math.round((capexEstimate / monthlyExpenses) * 100) : 0}%`,
      unit: ' CapEx ratio',
      icon: '⊕',
      description: 'Balance between long-term investment (CapEx) and day-to-day running costs (OpEx)',
      formula: 'CapEx = ~15% of expenses | OpEx = ~85%',
      computed: `CapEx ≈ ₹${Math.round(capexEstimate / 1000)}K | OpEx ≈ ₹${Math.round(opexEstimate / 1000)}K`,
      color: '#0091ff',
      status: 'Asset-Light',
      pathways: [
        {
          label: 'Invest in Infrastructure',
          color: '#00e5a0',
          description: 'Higher upfront CapEx can reduce recurring OpEx later and improve long-term margins.',
          months: [15, 22, 28, 28, 27, 25, 24]
        },
        {
          label: 'OpEx-Lean Model',
          color: '#0091ff',
          description: 'Keep operations asset-light and preserve cash flexibility while obligations remain tight.',
          months: [15, 14, 13, 13, 12, 12, 11]
        },
        {
          label: 'CapEx Overcommitment',
          color: '#ff4757',
          description: 'Large fixed investments before revenue stabilises can make cash flow illiquid.',
          months: [15, 25, 38, 42, 44, 43, 40]
        }
      ]
    }
  ];

  function PathwayChart({ pathways }) {
    const months = ['Now', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6'];
    const allVals = pathways.flatMap(p => p.months);
    const minV = Math.min(...allVals);
    const maxV = Math.max(...allVals);
    const range = maxV - minV || 1;
    const W = 520, H = 180, PL = 48, PR = 12, PT = 16, PB = 36;
    const cW = W - PL - PR, cH = H - PT - PB;
    const xPos = i => PL + (i / (months.length - 1)) * cW;
    const yPos = v => PT + cH - ((v - minV) / range) * cH;

    return React.createElement('svg', { viewBox: `0 0 ${W} ${H}`, style: { width: '100%', height: 'auto' } },
      [0, 0.25, 0.5, 0.75, 1].map((frac, i) => {
        const y = PT + cH * (1 - frac);
        const val = Math.round(minV + range * frac);
        return React.createElement('g', { key: i },
          React.createElement('line', { x1: PL, x2: W - PR, y1: y, y2: y, stroke: '#1e2530', strokeWidth: 1 }),
          React.createElement('text', { x: PL - 4, y: y + 4, textAnchor: 'end', fontSize: 9, fill: '#3d4a5c', fontFamily: 'DM Mono' }, val)
        );
      }),
      months.map((m, i) => React.createElement('text', { key: i, x: xPos(i), y: H - 6, textAnchor: 'middle', fontSize: 9, fill: '#3d4a5c', fontFamily: 'DM Mono' }, m)),
      pathways.map((p, pi) => {
        const pts = p.months.map((v, i) => `${xPos(i)},${yPos(v)}`).join(' ');
        return React.createElement('g', { key: pi },
          React.createElement('polyline', {
            points: pts,
            fill: 'none',
            stroke: p.color,
            strokeWidth: 2,
            strokeDasharray: pi === 2 ? '5,3' : pi === 1 ? '8,4' : 'none',
            opacity: 0.9
          }),
          p.months.map((v, i) => React.createElement('circle', { key: i, cx: xPos(i), cy: yPos(v), r: 3, fill: p.color, opacity: 0.9 }))
        );
      })
    );
  }

  const selected = activeMetric ? metrics.find(m => m.id === activeMetric) : null;

  return React.createElement('div', null,
    React.createElement('div', { className: 'page-header' },
      React.createElement('div', { className: 'page-title' }, 'Future'),
      React.createElement('div', { className: 'page-sub' }, 'Click any metric to see three possible growth pathways for your business')
    ),
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, marginBottom: 24 } },
      metrics.map(m => React.createElement('div', {
        key: m.id,
        onClick: () => setActiveMetric(activeMetric === m.id ? null : m.id),
        style: {
          background: activeMetric === m.id ? 'var(--surface2)' : 'var(--surface)',
          border: `1px solid ${activeMetric === m.id ? m.color : 'var(--border)'}`,
          borderRadius: 12,
          padding: 18,
          cursor: 'pointer',
          transition: 'all 0.2s',
          boxShadow: activeMetric === m.id ? `0 0 20px ${m.color}22` : 'none'
        }
      },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 } },
          React.createElement('span', { style: { fontSize: 18 } }, m.icon),
          React.createElement('span', { className: 'badge', style: { background: m.color + '22', color: m.color, fontSize: 9 } }, m.status)
        ),
        React.createElement('div', { style: { fontFamily: 'Syne', fontSize: 22, fontWeight: 700, color: m.color, letterSpacing: -1 } }, m.value + m.unit),
        React.createElement('div', { style: { fontFamily: 'Syne', fontSize: 11, fontWeight: 700, color: 'var(--text)', marginTop: 4 } }, m.label),
        React.createElement('div', { style: { fontSize: 11, color: 'var(--text3)', marginTop: 4, lineHeight: 1.4 } }, m.description)
      ))
    ),
    selected && React.createElement('div', { className: 'card', style: { border: `1px solid ${selected.color}44` } },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
        React.createElement('div', { className: 'card-title' }, selected.label + ' — 6-Month Pathways'),
        React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: () => setActiveMetric(null) }, '✕ Close')
      ),
      React.createElement('div', { style: { fontFamily: 'Syne', fontSize: 28, fontWeight: 700, color: selected.color, marginBottom: 6 } }, selected.value + selected.unit),
      React.createElement('div', { style: { fontSize: 12, color: 'var(--text2)', marginBottom: 10, lineHeight: 1.6 } }, selected.description),
      React.createElement('div', { className: 'reasoning-box', style: { marginBottom: 18 } },
        React.createElement('span', { className: 'cot-label' }, '◈ HOW IT IS COMPUTED'),
        React.createElement('strong', null, selected.formula),
        React.createElement('br'),
        React.createElement('span', { style: { color: 'var(--text2)' } }, '▸ Your Business: '),
        selected.computed
      ),
      React.createElement('div', { style: { marginBottom: 18 } }, PathwayChart({ pathways: selected.pathways })),
      React.createElement('div', { style: { display: 'flex', gap: 20, marginBottom: 18, flexWrap: 'wrap' } },
        selected.pathways.map((p, i) =>
          React.createElement('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement('div', { style: { width: 24, height: 2, background: p.color, borderRadius: 1 } }),
            React.createElement('span', { style: { fontSize: 11, color: 'var(--text2)', fontFamily: 'DM Mono' } }, p.label)
          )
        )
      ),
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 } },
        selected.pathways.map((p, i) =>
          React.createElement('div', { key: i, style: { background: p.color + '0d', border: `1px solid ${p.color}33`, borderRadius: 10, padding: 14 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
              React.createElement('div', { style: { width: 8, height: 8, borderRadius: '50%', background: p.color } }),
              React.createElement('span', { style: { fontSize: 11, fontWeight: 700, color: p.color, fontFamily: 'DM Mono' } }, p.label.toUpperCase())
            ),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--text2)', lineHeight: 1.6 } }, p.description)
          )
        )
      )
    ),
    !selected && React.createElement('div', { className: 'empty' },
      React.createElement('div', { className: 'icon' }, '⊞'),
      React.createElement('div', { className: 'title' }, 'Select a metric above'),
      React.createElement('div', { className: 'sub' }, 'See three personalized future pathways based on your actual accounts')
    )
  );
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────
function Actions({ apiKey, actions, setActions, addToast, balance, obligations, receivables }) {
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [customObligation, setCustomObligation] = useState({ vendor: '', amount: '', ask: '', relationship: 'neutral', type: 'defer' });
  const [showCustom, setShowCustom] = useState(false);

  const prioritized = prioritizeObligations(obligations, balance, receivables);
  const runway = computeRunway(balance, obligations, receivables);
  const shortfallObligations = prioritized.filter(o => !o.canPay);

  const runAnalysis = async () => {
    setAnalysisLoading(true);
    try {
      const financialState = { balance, runway: runway.days, shortfall: runway.shortfall, obligations: prioritized.map(o => ({ name: o.name, amount: o.amount, dueDate: o.dueDate, daysLeft: o.daysLeft, urgency: o.urgency, canPay: o.canPay, flexible: o.flexible, category: o.category, vendor: o.vendor, penalty: o.penalty })), receivables };
      let chainOfThought, recommendations;

      if (apiKey) {
        const prompt = `You are a cash flow decision engine. Analyze this financial state.\n\nFinancial State:\n${JSON.stringify(financialState, null, 2)}\n\nReturn ONLY valid JSON:\n{\n  "riskLevel": "critical|high|medium|low",\n  "chainOfThought": [{"step":1,"reasoning":"string"},{"step":2,"reasoning":"string"},{"step":3,"reasoning":"string"},{"step":4,"reasoning":"string"}],\n  "payNow": [{"name":"string","amount":number,"reason":"string"}],\n  "defer": [{"name":"string","amount":number,"suggestedDate":"YYYY-MM-DD","reason":"string","vendor":"string","relationship":"formal|friendly|neutral"}],\n  "negotiate": [{"name":"string","amount":number,"vendor":"string","ask":"string","relationship":"formal|friendly|neutral"}],\n  "accelerateReceivables": [{"from":"string","amount":number,"action":"string"}],\n  "summary": "2-3 sentence executive summary"\n}`;
        const raw = await callGroq(apiKey, [{ role: 'user', content: prompt }]);
        try {
          const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
          chainOfThought = parsed.chainOfThought;
          recommendations = parsed;
        } catch {
          chainOfThought = [{ step: 1, reasoning: raw }];
          recommendations = { summary: raw, riskLevel: 'unknown' };
        }
      } else {
        const payNow = prioritized.filter(o => o.canPay && o.urgency !== 'low');
        const defer = prioritized.filter(o => !o.canPay && o.flexible);
        const negotiate = prioritized.filter(o => !o.canPay && !o.flexible);
        const totalObl = obligations.reduce((s, o) => s + o.amount, 0);
        const totalRec = receivables.reduce((s, r) => s + r.amount, 0);
        chainOfThought = [
          {
            step: 1,
            reasoning: `Current cash balance: ₹${balance.toLocaleString()}. Total obligations: ₹${totalObl.toLocaleString()}. Expected receivables: ₹${totalRec.toLocaleString()}.`
          },
          {
            step: 2,
            reasoning: `Sequenced receivables by expected date and obligations by due date. ${shortfallObligations.length} obligations remain uncovered after projected inflows.`
          },
          {
            step: 3,
            reasoning: `Identified ${defer.length} flexible obligations to defer. ${negotiate.length} require vendor negotiation.`
          },
          {
            step: 4,
            reasoning: `Runway: ${runway.days} days. ${runway.shortfall > 0 ? `Projected shortfall of ₹${runway.shortfall.toLocaleString()}.` : 'Projected inflows are sufficient to meet obligations in sequence.'}`
          }
        ];
        recommendations = {
          payNow,
          defer,
          negotiate,
          riskLevel: runway.shortfall > 0
            ? (runway.days < 7 ? 'critical' : runway.days < 14 ? 'high' : 'medium')
            : 'low',
          summary:
            runway.shortfall > 0
              ? `${shortfallObligations.length} obligations still cannot be met even after expected receivables. Runway: ${runway.days} days.`
              : 'Expected receivables are sufficient to cover obligations in sequence. Runway secure.'
        };
      }

      setAnalysis({ chainOfThought, ...recommendations });
      const newActions = [];
      if (recommendations.defer?.length) recommendations.defer.forEach(d => newActions.push({ id: Date.now() + Math.random(), type: 'defer', obligation: d.name, vendor: d.vendor, amount: d.amount, reason: d.reason, suggestedDate: d.suggestedDate, relationship: d.relationship || 'neutral', status: 'pending' }));
      if (recommendations.negotiate?.length) recommendations.negotiate.forEach(n => newActions.push({ id: Date.now() + Math.random(), type: 'negotiate', obligation: n.name, vendor: n.vendor, amount: n.amount, ask: n.ask, relationship: n.relationship || 'neutral', status: 'pending' }));
      setActions(newActions);
      if (newActions.length) {
        addToast(`${newActions.length} actions generated`, 'success');
      } else {
        addToast('Analysis updated', 'success');
      }
    } catch (e) { addToast(e.message, 'error'); }
    setAnalysisLoading(false);
  };

  const generateEmail = async (action) => {
    setSelected(action);
    setLoading(true);
    setDraft(null);
    try {
      let emailContent;
      if (apiKey) {
        const toneMap = { formal: 'professional and formal', friendly: 'warm and friendly', neutral: 'polite and neutral' };
        const tone = toneMap[action.relationship] || 'polite';
        const prompt = `Draft a ${tone} business email.\nSituation: ${action.type === 'defer' ? `Request to defer payment of ₹${action.amount?.toLocaleString()} to ${action.vendor}` : `Negotiate payment terms of ₹${action.amount?.toLocaleString()} with ${action.vendor}`}\n${action.type === 'defer' ? `New proposed date: ${action.suggestedDate || 'to be agreed'}` : `Ask: ${action.ask}`}\n${action.reason ? `Reason: ${action.reason}` : ''}\n\nReturn ONLY valid JSON:\n{\n  "subject": "string",\n  "to": "${action.vendor || 'Vendor'}",\n  "body": "full email body"\n}`;
        const raw = await callGroq(apiKey, [{ role: 'user', content: prompt }]);
        try { emailContent = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim()); }
        catch { emailContent = { subject: `Re: Payment for ${action.obligation}`, to: action.vendor, body: raw }; }
      } else {
        emailContent = {
          subject: `Payment Schedule Discussion — ${action.obligation}`,
          to: action.vendor || 'Vendor',
          body: `Dear ${action.vendor || 'Team'},\n\nI hope this message finds you well.\n\nI am writing regarding the payment of ₹${action.amount?.toLocaleString()} for ${action.obligation}.\n\n${action.type === 'defer' ? `Due to temporary cash flow constraints, I would like to request a deferral to ${action.suggestedDate || 'a mutually agreed date'}.` : `I would like to discuss adjusted payment terms. ${action.ask || ''}`}\n\nI value our relationship and am committed to settling this at the earliest.\n\nBest regards,\n[Your Name]\n[Your Business]`
        };
      }
      setDraft(emailContent);
    } catch (e) { addToast(e.message, 'error'); }
    setLoading(false);
  };

  const markDone = (id) => {
    setActions(prev => prev.map(a => a.id === id ? { ...a, status: 'done' } : a));
    if (selected?.id === id) setSelected(null);
    addToast('Action marked as done', 'success');
  };

  const riskColors = { critical: 'var(--danger)', high: 'var(--warn)', medium: 'var(--accent2)', low: 'var(--accent)', unknown: 'var(--text3)' };

  return React.createElement('div', null,
    React.createElement('div', { className: 'page-header', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
      React.createElement('div', null,
        React.createElement('div', { className: 'page-title' }, 'Actions & Drafts'),
        React.createElement('div', { className: 'page-sub' }, 'AI-powered decision engine and negotiation email drafts')
      ),
      React.createElement('div', { style: { display: 'flex', gap: 8 } },
        React.createElement('button', { className: 'btn btn-primary', onClick: runAnalysis, disabled: analysisLoading || obligations.length === 0 },
          analysisLoading ? React.createElement('span', { className: 'loader' }) : '⊞', ' Run Analysis'),
        React.createElement('button', { className: 'btn btn-secondary', onClick: () => setShowCustom(true) }, '+ Custom Draft')
      )
    ),

    React.createElement('div', { className: 'grid-3 section-gap' },
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-label' }, 'Can Pay Now'),
        React.createElement('div', { className: 'stat-value green' }, prioritized.filter(o => o.canPay).length),
        React.createElement('div', { className: 'stat-sub' }, 'obligations covered')
      ),
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-label' }, 'Shortfall'),
        React.createElement('div', { className: 'stat-value red' }, shortfallObligations.length),
        React.createElement('div', { className: 'stat-sub' }, runway.shortfall > 0 ? `₹${runway.shortfall.toLocaleString()} gap` : 'No gap')
      ),
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-label' }, 'Flexible'),
        React.createElement('div', { className: 'stat-value', style: { color: 'var(--accent2)' } }, obligations.filter(o => o.flexible).length),
        React.createElement('div', { className: 'stat-sub' }, 'can be deferred')
      )
    ),

    analysis && React.createElement('div', null,
      React.createElement('div', { className: 'card section-gap', style: { borderColor: riskColors[analysis.riskLevel] + '44' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 10 } },
          React.createElement('div', { className: 'card-title' }, 'Executive Summary'),
          React.createElement('span', { className: 'badge', style: { background: riskColors[analysis.riskLevel] + '22', color: riskColors[analysis.riskLevel] } },
            (analysis.riskLevel || 'UNKNOWN').toUpperCase() + ' RISK')
        ),
        React.createElement('div', { style: { fontSize: 14, lineHeight: 1.7, color: 'var(--text2)' } }, analysis.summary)
      ),
      analysis.chainOfThought?.length > 0 && React.createElement('div', { className: 'card section-gap' },
        React.createElement('div', { className: 'card-title' }, 'Chain of Thought Reasoning'),
        analysis.chainOfThought.map(s =>
          React.createElement('div', { key: s.step, className: 'cot-step' },
            React.createElement('div', { className: 'cot-num' }, s.step),
            React.createElement('div', { className: 'cot-text' }, s.reasoning)
          )
        )
      )
    ),

    React.createElement('div', { className: 'grid-2' },
      React.createElement('div', null,
        actions.length === 0
          ? React.createElement('div', { className: 'empty' },
              React.createElement('div', { className: 'icon' }, '◧'),
              React.createElement('div', { className: 'title' }, 'No actions yet'),
              React.createElement('div', { className: 'sub' }, 'Click "Run Analysis" to generate recommended actions')
            )
          : actions.map(a =>
              React.createElement('div', {
                key: a.id, className: 'card',
                style: { marginBottom: 12, cursor: 'pointer', borderColor: selected?.id === a.id ? 'var(--accent)' : 'var(--border)', opacity: a.status === 'done' ? 0.5 : 1 },
                onClick: () => a.status !== 'done' && generateEmail(a)
              },
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 8 } },
                  React.createElement('span', { className: `badge ${a.type === 'defer' ? 'badge-warn' : 'badge-blue'}` }, a.type.toUpperCase()),
                  React.createElement('span', { className: `badge ${a.status === 'done' ? 'badge-green' : 'badge-gray'}` }, a.status)
                ),
                React.createElement('div', { style: { fontWeight: 600, color: 'var(--text)', fontSize: 14, marginBottom: 4 } }, a.obligation),
                a.vendor && React.createElement('div', { style: { fontSize: 12, color: 'var(--text3)' } }, 'Vendor: ' + a.vendor),
                a.amount && React.createElement('div', { style: { fontFamily: 'DM Mono', fontSize: 12, color: 'var(--warn)', marginTop: 4 } }, '₹' + a.amount?.toLocaleString()),
                a.status !== 'done' && React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
                  React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: e => { e.stopPropagation(); generateEmail(a); } }, '✎ Draft Email'),
                  React.createElement('button', { className: 'btn btn-primary btn-sm', onClick: e => { e.stopPropagation(); markDone(a.id); } }, '✓ Done')
                )
              )
            )
      ),
      React.createElement('div', null,
        loading && React.createElement('div', { className: 'card', style: { textAlign: 'center', padding: 30 } },
          React.createElement('span', { className: 'loader' }),
          React.createElement('div', { style: { marginTop: 8, color: 'var(--text2)', fontSize: 13 } }, 'Drafting email...')
        ),
        !loading && draft && React.createElement('div', null,
          React.createElement('div', { className: 'card-title' }, '✎ Draft Email'),
          React.createElement('div', { className: 'email-draft' },
            React.createElement('div', { className: 'email-header' },
              React.createElement('div', { className: 'email-field' }, React.createElement('span', null, 'TO: '), draft.to),
              React.createElement('div', { className: 'email-field' }, React.createElement('span', null, 'SUBJECT: '), draft.subject)
            ),
            React.createElement('div', { className: 'email-body' }, draft.body)
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
            React.createElement('button', {
              className: 'btn btn-secondary btn-sm',
              onClick: () => { navigator.clipboard.writeText(`To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`); addToast('Copied to clipboard', 'success'); }
            }, '⊕ Copy'),
            selected && React.createElement('button', { className: 'btn btn-primary btn-sm', onClick: () => markDone(selected.id) }, '✓ Mark Done')
          )
        ),
        !loading && !draft && React.createElement('div', { className: 'empty' },
          React.createElement('div', { className: 'icon' }, '✎'),
          React.createElement('div', { className: 'title' }, 'Select an action to draft'),
          React.createElement('div', { className: 'sub' }, 'Click an action on the left to generate a negotiation email')
        )
      )
    ),

    showCustom && React.createElement('div', { className: 'modal-overlay', onClick: () => setShowCustom(false) },
      React.createElement('div', { className: 'modal', onClick: e => e.stopPropagation() },
        React.createElement('div', { className: 'modal-header' },
          React.createElement('div', { className: 'modal-title' }, 'Custom Email Draft'),
          React.createElement('button', { className: 'close-btn', onClick: () => setShowCustom(false) }, '✕')
        ),
        React.createElement('div', { className: 'modal-body' },
          React.createElement('div', { className: 'form-group' },
            React.createElement('label', { className: 'form-label' }, 'Vendor / Counterparty'),
            React.createElement('input', { className: 'input', value: customObligation.vendor, onChange: e => setCustomObligation(f => ({ ...f, vendor: e.target.value })), placeholder: 'Vendor name' })
          ),
          React.createElement('div', { className: 'form-group' },
            React.createElement('label', { className: 'form-label' }, 'Amount (₹)'),
            React.createElement('input', { className: 'input', type: 'number', value: customObligation.amount, onChange: e => setCustomObligation(f => ({ ...f, amount: e.target.value })) })
          ),
          React.createElement('div', { className: 'form-group' },
            React.createElement('label', { className: 'form-label' }, 'What to ask / request'),
            React.createElement('textarea', { className: 'textarea', rows: 3, value: customObligation.ask, onChange: e => setCustomObligation(f => ({ ...f, ask: e.target.value })), placeholder: 'Extend payment by 15 days, partial payment plan, etc.' })
          ),
          React.createElement('div', { className: 'form-group' },
            React.createElement('label', { className: 'form-label' }, 'Email Type'),
            React.createElement('select', { className: 'select', style: { width: '100%' }, value: customObligation.type, onChange: e => setCustomObligation(f => ({ ...f, type: e.target.value })) },
              React.createElement('option', { value: 'defer' }, 'Defer Payment'),
              React.createElement('option', { value: 'negotiate' }, 'Negotiate Terms')
            )
          ),
          React.createElement('div', { className: 'form-group' },
            React.createElement('label', { className: 'form-label' }, 'Relationship Tone'),
            React.createElement('select', { className: 'select', style: { width: '100%' }, value: customObligation.relationship, onChange: e => setCustomObligation(f => ({ ...f, relationship: e.target.value })) },
              React.createElement('option', { value: 'formal' }, 'Formal / Professional'),
              React.createElement('option', { value: 'neutral' }, 'Neutral / Polite'),
              React.createElement('option', { value: 'friendly' }, 'Friendly / Warm')
            )
          )
        ),
        React.createElement('div', { className: 'modal-footer' },
          React.createElement('button', { className: 'btn btn-secondary', onClick: () => setShowCustom(false) }, 'Cancel'),
          React.createElement('button', {
            className: 'btn btn-primary',
            onClick: async () => {
              const action = { id: Date.now(), ...customObligation, obligation: customObligation.vendor + ' Payment', status: 'pending' };
              await generateEmail(action);
              setShowCustom(false);
            },
            disabled: loading || !customObligation.vendor
          }, 'Generate Draft')
        )
      )
    )
  );
}

// ─── AUTH STORE (localStorage) ────────────────────────────────────────────────
const AUTH_KEY = 'pocketcfo_users';
const SESSION_KEY = 'pocketcfo_session';
const USERDATA_KEY_PREFIX = 'pocketcfo_userdata_';

function getUsers() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || '[]'); } catch { return []; }
}
function saveUsers(users) { localStorage.setItem(AUTH_KEY, JSON.stringify(users)); }
function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function saveSession(user) { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }
function getUserDataKey(user) {
  return `${USERDATA_KEY_PREFIX}${user && user.id ? user.id : 'unknown'}`;
}
function loadUserData(user) {
  if (!user) return null;
  try {
    const raw = localStorage.getItem(getUserDataKey(user));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveUserData(user, data) {
  if (!user) return;
  try {
    localStorage.setItem(getUserDataKey(user), JSON.stringify(data));
  } catch {}
}
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── AUTH PAGE ────────────────────────────────────────────────────────────────
function AuthPage({ onLogin, theme, toggleTheme }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', age: '', business: '', bankBalance: '' });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [shake, setShake] = useState(false);

  const setField = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    setErrors(e => ({ ...e, [k]: '' }));
  };

  function triggerShake() {
    setShake(true);
    setTimeout(() => setShake(false), 600);
  }

  function parseBankBalanceField() {
    const raw = String(form.bankBalance || '').replace(/,/g, '').trim();
    if (raw === '') return { ok: false, error: 'Current bank balance is required', value: NaN };
    const v = parseFloat(raw);
    if (Number.isNaN(v) || v < 0) return { ok: false, error: 'Enter a valid balance (0 or more)', value: NaN };
    return { ok: true, value: v };
  }

  function validateLogin() {
    const e = {};
    if (!form.email) e.email = 'Email is required';
    else if (!validateEmail(form.email)) e.email = 'Enter a valid email address';
    if (!form.password) e.password = 'Password is required';
    const bal = parseBankBalanceField();
    if (!bal.ok) e.bankBalance = bal.error;
    return e;
  }

  function validateSignup() {
    const e = {};
    if (!form.name.trim()) e.name = 'Full name is required';
    if (!form.email) e.email = 'Email is required';
    else if (!validateEmail(form.email)) e.email = 'Enter a valid email address';
    if (!form.password || form.password.length < 6) e.password = 'Password must be at least 6 characters';
    if (!form.age || isNaN(form.age) || Number(form.age) < 18 || Number(form.age) > 100) e.age = 'Enter a valid age (18–100)';
    if (!form.business.trim()) e.business = 'Business name is required';
    const bal = parseBankBalanceField();
    if (!bal.ok) e.bankBalance = bal.error;
    return e;
  }

  function handleLogin(e) {
    e.preventDefault();
    const errs = validateLogin();
    if (Object.keys(errs).length) {
      setErrors(errs);
      triggerShake();
      return;
    }
    setLoading(true);
    setTimeout(() => {
      const users = getUsers();
      const user = users.find(u => u.email.toLowerCase() === form.email.toLowerCase() && u.password === form.password);
      if (!user) {
        setErrors({ password: 'Incorrect email or password' });
        triggerShake();
        setLoading(false);
        return;
      }
      saveSession(user);
      setLoading(false);
      onLogin(user, { reconcileBalance: parseBankBalanceField().value });
    }, 700);
  }

  function handleSignup(e) {
    e.preventDefault();
    const errs = validateSignup();
    if (Object.keys(errs).length) {
      setErrors(errs);
      triggerShake();
      return;
    }
    setLoading(true);
    setTimeout(() => {
      const users = getUsers();
      if (users.find(u => u.email.toLowerCase() === form.email.toLowerCase())) {
        setErrors({ email: 'An account with this email already exists' });
        triggerShake();
        setLoading(false);
        return;
      }
      const user = {
        id: Date.now(),
        email: form.email.trim(),
        password: form.password,
        name: form.name.trim(),
        age: Number(form.age),
        business: form.business.trim(),
        createdAt: new Date().toISOString()
      };
      saveUsers([...users, user]);
      const opening = parseBankBalanceField().value;
      saveUserData(user, {
        apiKey: '',
        startingBankBalance: opening,
        obligations: SAMPLE_OBLIGATIONS,
        receivables: SAMPLE_RECEIVABLES,
        transactions: [],
        actions: []
      });
      saveSession(user);
      setLoading(false);
      onLogin(user);
    }, 700);
  }

  function handleGoogleAuth() {
    setGoogleLoading(true);
    setTimeout(() => {
      const users = getUsers();
      let user = users.find(u => u.email === 'demo@gmail.com');
      if (!user) {
        user = {
          id: Date.now(),
          email: 'demo@gmail.com',
          name: 'Demo User',
          business: 'Demo Business',
          age: 25,
          password: '',
          provider: 'google',
          createdAt: new Date().toISOString()
        };
        saveUsers([...users, user]);
      }
      saveSession(user);
      setGoogleLoading(false);
      const bal = parseBankBalanceField();
      onLogin(user, bal.ok ? { reconcileBalance: bal.value } : {});
    }, 900);
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    setForm({ email: '', password: '', name: '', age: '', business: '', bankBalance: '' });
    setErrors({});
  }

  const inp = (key, type, placeholder, label, icon) =>
    React.createElement('div', { className: 'auth-field', key },
      React.createElement('label', { className: 'auth-label' }, icon + ' ' + label),
      React.createElement('div', { className: 'auth-input-wrap' },
        React.createElement('input', {
          className: `auth-input${errors[key] ? ' auth-input-err' : ''}`,
          type: key === 'password' ? (showPass ? 'text' : 'password') : type,
          placeholder,
          value: form[key],
          onChange: ev => setField(key, ev.target.value),
          autoComplete: key === 'password' ? 'current-password' : key === 'email' ? 'email' : 'off'
        }),
        key === 'password' && React.createElement('button', {
          type: 'button',
          className: 'pass-toggle',
          onClick: () => setShowPass(v => !v)
        }, showPass ? '🙈' : '👁')
      ),
      errors[key] && React.createElement('div', { className: 'auth-err' }, '⚠ ' + errors[key])
    );

  return React.createElement('div', { className: 'auth-root' },
    React.createElement('div', { className: 'auth-bg' },
      React.createElement('div', { className: 'auth-bg-grid' }),
      React.createElement('div', { className: 'auth-orb auth-orb-1' }),
      React.createElement('div', { className: 'auth-orb auth-orb-2' }),
      React.createElement('div', { className: 'auth-orb auth-orb-3' })
    ),
    React.createElement('div', { className: 'auth-left' },
      React.createElement('div', { className: 'auth-brand' },
        React.createElement('div', { className: 'auth-logo' },
          React.createElement('span', { className: 'auth-logo-icon' }, '◈'),
          React.createElement('span', null, 'Pocket', React.createElement('span', { style: { color: 'var(--accent)' } }, 'CFO'))
        ),
        React.createElement('div', { className: 'auth-tagline' }, 'Smart Cash Flow Intelligence')
      ),
      React.createElement('div', { className: 'auth-features' },
        React.createElement('div', { className: 'auth-feature-title' }, 'Your financial co-pilot'),
        [
          { icon: '⚡', title: 'Real-time runway detection', desc: 'Know exactly how many days until cash runs out' },
          { icon: '🧠', title: 'AI-powered decisions', desc: 'Deterministic engine prioritizes every obligation' },
          { icon: '📧', title: 'Auto-drafted negotiations', desc: 'Context-aware emails written for you instantly' },
          { icon: '📊', title: 'Multi-source ingestion', desc: 'Bank statements, invoices, receipts — all unified' }
        ].map((f, i) => React.createElement('div', { key: i, className: 'auth-feature-item', style: { animationDelay: `${i * 0.1 + 0.3}s` } },
          React.createElement('div', { className: 'auth-feature-icon' }, f.icon),
          React.createElement('div', null,
            React.createElement('div', { className: 'auth-feature-name' }, f.title),
            React.createElement('div', { className: 'auth-feature-desc' }, f.desc)
          )
        ))
      ),
      React.createElement('div', { className: 'auth-left-footer' },
        React.createElement('div', { className: 'auth-stat-row' },
          React.createElement('div', { className: 'auth-stat' },
            React.createElement('div', { className: 'auth-stat-num' }, '62K+'),
            React.createElement('div', { className: 'auth-stat-lbl' }, 'Transactions Analyzed')
          ),
          React.createElement('div', { className: 'auth-stat' },
            React.createElement('div', { className: 'auth-stat-num' }, '98%'),
            React.createElement('div', { className: 'auth-stat-lbl' }, 'Decision Accuracy')
          ),
          React.createElement('div', { className: 'auth-stat' },
            React.createElement('div', { className: 'auth-stat-num' }, '3x'),
            React.createElement('div', { className: 'auth-stat-lbl' }, 'Faster Decisions')
          )
        )
      )
    ),
    React.createElement('div', { className: 'auth-right' },
      React.createElement('div', { className: `auth-card${shake ? ' auth-shake' : ''}` },
        React.createElement('div', { className: 'auth-theme-row' },
          React.createElement('button', {
            type: 'button',
            className: 'auth-theme-chip',
            onClick: toggleTheme,
            'aria-label': theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
          }, theme === 'dark' ? '☼ Light mode' : '🌙 Dark mode')
        ),
        React.createElement('div', { className: 'auth-tabs' },
          React.createElement('button', { className: `auth-tab${mode === 'login' ? ' active' : ''}`, onClick: () => switchMode('login') }, 'Sign In'),
          React.createElement('button', { className: `auth-tab${mode === 'signup' ? ' active' : ''}`, onClick: () => switchMode('signup') }, 'Create Account')
        ),
        React.createElement('div', { className: 'auth-heading' },
          mode === 'login'
            ? React.createElement('div', null,
                React.createElement('h1', { className: 'auth-h1' }, 'Welcome back'),
                React.createElement('p', { className: 'auth-h2' }, 'Sign in to your PocketCFO dashboard')
              )
            : React.createElement('div', null,
                React.createElement('h1', { className: 'auth-h1' }, 'Get started'),
                React.createElement('p', { className: 'auth-h2' }, 'Create your account — it takes 30 seconds')
              )
        ),
        React.createElement('button', { className: 'auth-google-btn', onClick: handleGoogleAuth, disabled: googleLoading || loading },
          googleLoading
            ? React.createElement('span', { className: 'loader' })
            : React.createElement('svg', { width: 18, height: 18, viewBox: '0 0 48 48' },
                React.createElement('path', { fill: '#EA4335', d: 'M24 9.5c3.5 0 6.6 1.2 9.1 3.2l6.8-6.8C35.8 2.2 30.2 0 24 0 14.7 0 6.7 5.4 2.8 13.3l7.9 6.1C12.5 13.4 17.8 9.5 24 9.5z' }),
                React.createElement('path', { fill: '#4285F4', d: 'M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.9 7.2l7.7 6c4.5-4.1 7-10.2 7-17.2z' }),
                React.createElement('path', { fill: '#FBBC05', d: 'M10.7 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.5l-7.9-6.1A23.9 23.9 0 0 0 0 24c0 3.8.9 7.4 2.5 10.7l8.2-6.1z' }),
                React.createElement('path', { fill: '#34A853', d: 'M24 48c6.2 0 11.4-2 15.2-5.5l-7.7-6c-2 1.4-4.6 2.2-7.5 2.2-6.2 0-11.5-4-13.3-9.5l-8.2 6.1C6.6 42.5 14.7 48 24 48z' })
              ),
          React.createElement('span', null, googleLoading ? 'Connecting…' : 'Continue with Google')
        ),
        React.createElement('div', { className: 'auth-divider' },
          React.createElement('span', null, 'or continue with email')
        ),
        React.createElement('form', { onSubmit: mode === 'login' ? handleLogin : handleSignup, noValidate: true },
          mode === 'signup' && inp('name', 'text', 'Rahul Sharma', 'Full Name', '👤'),
          inp('email', 'email', 'you@example.com', 'Email Address', '✉'),
          inp('password', 'password', mode === 'login' ? '••••••••' : 'Min. 6 characters', 'Password', '🔒'),
          inp('bankBalance', 'text', 'e.g. 125000', 'Current bank balance (₹)', '💰'),
          mode === 'signup' && inp('age', 'number', '28', 'Your Age', '🎂'),
          mode === 'signup' && inp('business', 'text', 'Acme Trading Co.', 'Business Name', '🏢'),
          React.createElement('button', {
            type: 'submit',
            className: 'auth-submit',
            disabled: loading || googleLoading
          },
            loading
              ? React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' } },
                  React.createElement('span', { className: 'loader' }),
                  mode === 'login' ? 'Signing in…' : 'Creating account…'
                )
              : (mode === 'login' ? '→  Sign In to Dashboard' : '→  Create My Account')
          )
        ),
        mode === 'login' && React.createElement('div', { className: 'auth-switch-text' },
          "Don't have an account? ",
          React.createElement('button', { type: 'button', className: 'auth-link', onClick: () => switchMode('signup') }, 'Sign up free')
        ),
        mode === 'signup' && React.createElement('div', { className: 'auth-switch-text' },
          'Already have an account? ',
          React.createElement('button', { type: 'button', className: 'auth-link', onClick: () => switchMode('login') }, 'Sign in')
        ),
        React.createElement('div', { className: 'auth-terms' }, 'By continuing, you agree to our Terms of Service and Privacy Policy')
      )
    )
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
function App() {
  const [currentUser, setCurrentUser] = useState(() => getSession());
  const [page, setPage] = useState('dashboard');
  const [apiKey, setApiKey] = useState('');
  const [startingBankBalance, setStartingBankBalance] = useState(0);
  const [obligations, setObligations] = useState(SAMPLE_OBLIGATIONS);
  const [receivables, setReceivables] = useState(SAMPLE_RECEIVABLES);
  const [transactions, setTransactions] = useState([]);
  const [actions, setActions] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('pocketcfo-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('pocketcfo-theme', theme);
    } catch (_) {}
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const addToast = useCallback((msg, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  const balance = useMemo(
    () => startingBankBalance + netFromTransactions(transactions),
    [startingBankBalance, transactions]
  );

  useEffect(() => {
    if (!currentUser) return;
    const saved = loadUserData(currentUser);
    if (saved) {
      setApiKey(saved.apiKey || '');
      const txs = Array.isArray(saved.transactions) ? saved.transactions : [];
      const net = netFromTransactions(txs);
      if (typeof saved.startingBankBalance === 'number' && !Number.isNaN(saved.startingBankBalance)) {
        setStartingBankBalance(saved.startingBankBalance);
      } else {
        setStartingBankBalance((Number(saved.balance) || 0) - net);
      }
      setObligations(Array.isArray(saved.obligations) ? saved.obligations : []);
      setReceivables(Array.isArray(saved.receivables) ? saved.receivables : []);
      setTransactions(txs);
      setActions(Array.isArray(saved.actions) ? saved.actions : []);
    } else {
      setApiKey('');
      setStartingBankBalance(0);
      setObligations(Array.isArray(SAMPLE_OBLIGATIONS) ? SAMPLE_OBLIGATIONS : []);
      setReceivables(Array.isArray(SAMPLE_RECEIVABLES) ? SAMPLE_RECEIVABLES : []);
      setTransactions([]);
      setActions([]);
    }
    setPage('dashboard');
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    saveUserData(currentUser, {
      apiKey,
      startingBankBalance,
      obligations,
      receivables,
      transactions,
      actions
    });
  }, [currentUser, apiKey, startingBankBalance, obligations, receivables, transactions, actions]);

  function handleLogin(user, opts = {}) {
    if (opts.reconcileBalance != null && Number.isFinite(opts.reconcileBalance)) {
      const saved = loadUserData(user);
      const txs = (saved && Array.isArray(saved.transactions)) ? saved.transactions : [];
      const net = netFromTransactions(txs);
      const start = opts.reconcileBalance - net;
      saveUserData(user, {
        ...(saved || {}),
        apiKey: (saved && saved.apiKey) || '',
        startingBankBalance: start,
        obligations: Array.isArray(saved && saved.obligations) ? saved.obligations : SAMPLE_OBLIGATIONS,
        receivables: Array.isArray(saved && saved.receivables) ? saved.receivables : SAMPLE_RECEIVABLES,
        transactions: txs,
        actions: Array.isArray(saved && saved.actions) ? saved.actions : []
      });
    } else if (!loadUserData(user)) {
      saveUserData(user, {
        apiKey: '',
        startingBankBalance: 0,
        obligations: SAMPLE_OBLIGATIONS,
        receivables: SAMPLE_RECEIVABLES,
        transactions: [],
        actions: []
      });
    }
    setCurrentUser(user);
    addToast(`Welcome back, ${user.name || user.email}! 👋`, 'success');
  }

  function handleLogout() {
    clearSession();
    setCurrentUser(null);
    setPage('dashboard');
  }

  if (!currentUser) {
    return React.createElement(AuthPage, { onLogin: handleLogin, theme, toggleTheme });
  }

  const pages = {
    dashboard: React.createElement(Dashboard, { balance, obligations, receivables }),
    reality: React.createElement(RealityPage, { obligations, receivables }),
    obligations: React.createElement(Obligations, { obligations, setObligations, addToast }),
    receivables: React.createElement(Receivables, { receivables, setReceivables, addToast }),
    transactions: React.createElement(TransactionHistory, { balance, setStartingBankBalance, transactions, setTransactions, setObligations, setReceivables, addToast }),
    future: React.createElement(FuturePage, { balance, obligations, receivables }),
    actions: React.createElement(Actions, { apiKey, actions, setActions, addToast, balance, obligations, receivables })
  };

  return React.createElement(React.Fragment, null,
    React.createElement('div', { className: 'app' },
      React.createElement(Sidebar, { page, setPage, apiKey, setApiKey, theme, toggleTheme }),
      React.createElement('div', { className: 'main' },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            React.createElement('div', {
              style: {
                width: 30,
                height: 30,
                borderRadius: '50%',
                background: 'linear-gradient(135deg,var(--accent),var(--accent2))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 700,
                color: '#000'
              }
            }, (currentUser.name || currentUser.email).charAt(0).toUpperCase()),
            React.createElement('div', null,
              React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--text)' } }, currentUser.name || currentUser.email),
              currentUser.business && React.createElement('div', { style: { fontSize: 10, color: 'var(--text3)', fontFamily: 'DM Mono' } }, currentUser.business)
            )
          ),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' } }, 'CASH BALANCE ₹'),
            React.createElement('span', {
              className: 'input',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                minWidth: 130,
                padding: '6px 10px',
                fontSize: 13,
                fontFamily: 'DM Mono',
                color: 'var(--text)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8
              },
              title: 'Opening balance at last sign-in ± credits and debits in history'
            }, (Number.isFinite(balance) ? balance : 0).toLocaleString()),
            React.createElement('button', {
              type: 'button',
              className: 'theme-toggle theme-toggle--main',
              onClick: toggleTheme,
              'aria-label': theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
            }, theme === 'dark' ? '☼ Light' : '🌙 Dark'),
            React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: handleLogout }, '⎋ Sign Out')
          )
        ),
        (pages[page] || pages.dashboard)
      )
    ),
    React.createElement(ToastContainer, { toasts })
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
