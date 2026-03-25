/* =========================================================
   PocketCFO — app.js
   All React components and app logic.
   Depends on: React 18 (UMD), ReactDOM 18 (UMD)
   External API: Groq (called client-side via user-supplied key)
   ========================================================= */

'use strict';

const { useState, useEffect, useRef, useCallback } = React;

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

// ─── SAMPLE DATA ──────────────────────────────────────────────────────────────
const SAMPLE_OBLIGATIONS = [
  { id: 1, name: 'Staff Payroll', category: 'payroll', amount: 45000, dueDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), vendor: 'Employees', flexible: false, penalty: 'Legal risk' },
  { id: 2, name: 'GST Filing', category: 'tax', amount: 12000, dueDate: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10), vendor: 'GSTN Portal', flexible: false, penalty: 'Interest + penalty' },
  { id: 3, name: 'Office Rent', category: 'rent', amount: 28000, dueDate: new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10), vendor: 'PropCo Realty', flexible: true, penalty: 'Late fee' },
  { id: 4, name: 'Cloud Infra (AWS)', category: 'utility', amount: 8500, dueDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10), vendor: 'Amazon Web Services', flexible: true, penalty: 'Service pause' },
  { id: 5, name: 'Supplier Invoice', category: 'supplier', amount: 31000, dueDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), vendor: 'RawMat Industries', flexible: true, penalty: 'Relationship risk' },
];

const SAMPLE_RECEIVABLES = [
  { id: 1, from: 'Acme Corp', amount: 55000, expectedDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), status: 'confirmed' },
  { id: 2, from: 'NovaTech Ltd', amount: 30000, expectedDate: new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10), status: 'pending' },
];

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
function Sidebar({ page, setPage, apiKey, setApiKey }) {
  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: '◈' },
    { id: 'obligations', label: 'Obligations', icon: '◉' },
    { id: 'receivables', label: 'Receivables', icon: '◎' },
    { id: 'transactions', label: 'Transaction History', icon: '⊕' },
    { id: 'future', label: 'Future', icon: '⊞' },
    { id: 'actions', label: 'Actions', icon: '◧' },
  ];
  return React.createElement('div', { className: 'sidebar' },
    React.createElement('div', { className: 'logo' }, 'Pocket', React.createElement('span', null, 'CFO')),
    React.createElement('nav', { className: 'nav' },
      items.map(i => React.createElement('div', {
        key: i.id, className: `nav-item ${page === i.id ? 'active' : ''}`,
        onClick: () => setPage(i.id)
      },
        React.createElement('span', { className: 'icon' }, i.icon),
        i.label
      ))
    ),
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
  const range = Math.max(1, max - min);
  const x = i => pad + (i / Math.max(1, points.length - 1)) * (width - pad * 2);
  const y = v => (height - pad) - ((v - min) / range) * (height - pad * 2);
  const polyline = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  return React.createElement('svg', { viewBox: `0 0 ${width} ${height}`, className: 'scenario-svg' },
    React.createElement('polyline', {
      points: polyline,
      fill: 'none',
      stroke: 'var(--accent2)',
      strokeWidth: 2.5,
      opacity: 0.95
    }),
    points.map((p, i) => React.createElement('circle', {
      key: p.label + i,
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

  const scenario = React.useMemo(() => {
    const delay = Number(sliders.supplierDelayDays) || 0;
    const marketing = Number(sliders.marketingSpendChange) || 0;
    const inventory = Number(sliders.inventoryTurnoverChange) || 0;
    const sales = Number(sliders.salesGrowthChange) || 0;

    const hasSupplierObligations = obligations.some(o => o.category === 'supplier');
    const turnoverEffect = Math.min(1.25, Math.max(0.75, 1 - (inventory / 100) * 0.4));
    const salesEffect = Math.min(2, Math.max(0.6, 1 + (sales / 100)));
    const receivableDateShift = Math.round((sales / 100) * -6 + (inventory / 100) * -3);

    const adjustedObligations = obligations.map(o => {
      const isSupplier = o.category === 'supplier';
      const applyDelay = hasSupplierObligations ? isSupplier : true;
      const baseAmount = Number(o.amount) || 0;
      const inventoryAdjusted = isSupplier
        ? Math.round(baseAmount * turnoverEffect)
        : baseAmount;
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

    const totalOblBase = obligations.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
    const projectedInflowBase = Math.max(8000, Math.round(totalOblBase * 0.35));
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

    const marketingOutflows = marketing > 0
      ? [{
          id: 'mkt-1',
          name: 'Marketing push',
          category: 'other',
          amount: Math.round(totalOblBase * (marketing / 100) * 0.12),
          dueDate: addDays(new Date(), 15).toISOString().slice(0, 10)
        }, {
          id: 'mkt-2',
          name: 'Marketing push',
          category: 'other',
          amount: Math.round(totalOblBase * (marketing / 100) * 0.12),
          dueDate: addDays(new Date(), 45).toISOString().slice(0, 10)
        }]
      : [];

    const scenarioObligations = [...adjustedObligations, ...marketingOutflows];

    const scenarioTimeline = getProjectedEvents(balance, scenarioObligations, scenarioReceivables);

    const buildDailySeries = (eventTimeline) => {
      const horizonDays = 60;
      const start = new Date();
      const dayKey = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString().slice(0, 10);
      const eventMap = {};
      for (const e of eventTimeline) {
        if (e.type === 'start') continue;
        const k = dayKey(e.date);
        eventMap[k] = (eventMap[k] || 0) + (e.type === 'inflow' ? e.amount : -e.amount);
      }

      const daily = [];
      let running = Number(balance) || 0;
      for (let day = 0; day <= horizonDays; day++) {
        const targetDate = addDays(start, day);
        running += eventMap[dayKey(targetDate)] || 0;
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
  }, [sliders, balance, obligations, receivables]);

  return React.createElement('div', { className: 'card section-gap' },
    React.createElement('div', { className: 'card-title' }, 'Business Survival Simulator'),
    React.createElement('div', { className: 'sim-grid' },
      React.createElement('div', null,
        React.createElement('div', { className: 'sim-control' },
          React.createElement('label', null, `Delay supplier payment: ${sliders.supplierDelayDays} days`),
          React.createElement('input', { type: 'range', min: 0, max: 45, value: sliders.supplierDelayDays, onChange: e => setSliders(s => ({ ...s, supplierDelayDays: Number(e.target.value) })) })
        ),
        React.createElement('div', { className: 'sim-control' },
          React.createElement('label', null, `Increase marketing spend: ${sliders.marketingSpendChange}%`),
          React.createElement('input', { type: 'range', min: -20, max: 60, value: sliders.marketingSpendChange, onChange: e => setSliders(s => ({ ...s, marketingSpendChange: Number(e.target.value) })) })
        ),
        React.createElement('div', { className: 'sim-control' },
          React.createElement('label', null, `Change inventory turnover: ${sliders.inventoryTurnoverChange}%`),
          React.createElement('input', { type: 'range', min: -30, max: 40, value: sliders.inventoryTurnoverChange, onChange: e => setSliders(s => ({ ...s, inventoryTurnoverChange: Number(e.target.value) })) })
        ),
        React.createElement('div', { className: 'sim-control' },
          React.createElement('label', null, `Adjust sales growth: ${sliders.salesGrowthChange}%`),
          React.createElement('input', { type: 'range', min: -20, max: 80, value: sliders.salesGrowthChange, onChange: e => setSliders(s => ({ ...s, salesGrowthChange: Number(e.target.value) })) })
        ),
        React.createElement('div', { className: 'sim-presets' },
          React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: () => applyPreset({ supplierDelayDays: 20, marketingSpendChange: 40, inventoryTurnoverChange: -10, salesGrowthChange: 35 }) }, 'Aggressive growth'),
          React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: () => applyPreset({ supplierDelayDays: 10, marketingSpendChange: -10, inventoryTurnoverChange: 20, salesGrowthChange: 5 }) }, 'Conservative survival'),
          React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: () => applyPreset({ supplierDelayDays: 30, marketingSpendChange: 55, inventoryTurnoverChange: -15, salesGrowthChange: 50 }) }, 'Investor-dependent growth')
        )
      ),
      React.createElement('div', null,
        React.createElement(ScenarioLineChart, { points: scenario.points }),
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
  const timeline = React.useMemo(() => getProjectedEvents(balance, obligations, receivables), [balance, obligations, receivables]);
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

function EarlyWarningSystem({ balance, obligations, receivables }) {
  const warnings = React.useMemo(() => {
    const timeline = getProjectedEvents(balance, obligations, receivables);
    const today = new Date();
    const firstNegative = timeline.find(e => e.runningBalance < 0);

    const receivableSorted = [...receivables].sort((a, b) => new Date(a.expectedDate) - new Date(b.expectedDate));
    const avgGap = receivableSorted.length > 1
      ? receivableSorted.slice(1).reduce((sum, r, i) => {
          const prev = new Date(receivableSorted[i].expectedDate);
          const curr = new Date(r.expectedDate);
          return sum + Math.max(0, Math.floor((curr - prev) / 86400000));
        }, 0) / (receivableSorted.length - 1)
      : 0;

    const weekEnd = addDays(today, 7);
    const weekInflows = receivables
      .filter(r => new Date(r.expectedDate) >= today && new Date(r.expectedDate) <= weekEnd)
      .reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const weekOutflows = obligations
      .filter(o => new Date(o.dueDate) >= today && new Date(o.dueDate) <= weekEnd)
      .reduce((s, o) => s + (Number(o.amount) || 0), 0);

    const data = [];
    if (firstNegative) {
      const days = Math.max(0, Math.floor((firstNegative.date - today) / 86400000));
      data.push({ level: 'critical', text: `Cash crisis predicted in ${days} days` });
    }
    if (avgGap > 10) {
      data.push({ level: 'warn', text: 'Receivable delay increasing trend detected' });
    }
    if (weekOutflows > weekInflows + Math.max(0, balance * 0.25)) {
      data.push({ level: 'warn', text: 'Obligations exceed inflow next week' });
    }
    if (data.length === 0) {
      data.push({ level: 'ok', text: 'No early warning trigger right now' });
    }
    return data;
  }, [balance, obligations, receivables]);

  return React.createElement('div', { className: 'card' },
    React.createElement('div', { className: 'card-title' }, 'Financial Early Warning System'),
    React.createElement('div', { className: 'warning-list' },
      warnings.map((w, i) => React.createElement('div', { key: i, className: `warning-item ${w.level}` }, w.text))
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
    React.createElement(CashFlowTimeline, { balance, obligations, receivables }),
    React.createElement(EarlyWarningSystem, { balance, obligations, receivables }),

    runway.shortfall > 0 && React.createElement('div', {
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
    )
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

// ─── TRANSACTION HISTORY (File + Text + SMS) ──────────────────────────────────
function TransactionHistory({
  apiKey,
  setObligations,
  setReceivables,
  balance,
  setBalance,
  transactions: historyTransactions,
  setTransactions,
  addToast
}) {
  const [tab, setTab] = useState('history');
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [manualText, setManualText] = useState('');
  const [smsText, setSmsText] = useState('');
  const [smsResults, setSmsResults] = useState(null);
  const [smsLoading, setSmsLoading] = useState(false);
  const BACKEND_URL = 'http://localhost:8080';

  // ─── TRANSACTIONS (History + Gmail) ─────────────────────────────────────────
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailEmail, setGmailEmail] = useState('');
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailLastSync, setGmailLastSync] = useState(null);
  const [autoSync, setAutoSync] = useState(false);
  const [gmailTransactions, setGmailTransactions] = useState([]);
  const [lookbackDays, setLookbackDays] = useState(7);

  const fileRef = useRef();

  const SAMPLE_SMS = `HDFC Bank: Rs.45,000.00 credited to your a/c XX1234 on 15-01-24 by ACME CORP. Avail Bal: Rs.62,450.00\nSBI: Rs.12,500 debited from a/c XX5678 on 16-01-24. UPI ref: 234567890. Avail Bal: Rs.49,950\nICICI: Your EMI of Rs.8,200 has been debited on 17-01-24. Loan a/c XX9012. Outstanding: Rs.2,45,600\nPaytm: Rs.3,500 paid to RAWMAT INDUSTRIES on 17-01-24. UPI ID: rawmat@paytm. Ref: 98765432\nAXIS: Salary credit Rs.85,000 on 01-01-24. A/c XX3456. Available balance: Rs.1,02,450`;

  const processWithGroq = async (content, filename) => {
    if (!apiKey) throw new Error('Enter your Groq API key in the sidebar');
    const prompt = `You are a financial document parser. Extract financial data from this document.\nDocument: "${filename}"\nContent: ${content.slice(0, 3000)}\n\nReturn ONLY valid JSON:\n{\n  "type": "bank_statement|invoice|receipt|expense",\n  "balance": number_or_null,\n  "transactions": [{"date":"YYYY-MM-DD","description":"string","amount":number,"type":"credit|debit"}],\n  "obligations": [{"name":"string","amount":number,"dueDate":"YYYY-MM-DD","vendor":"string","category":"payroll|tax|rent|loan|supplier|utility|other","flexible":false,"penalty":"string"}],\n  "receivables": [{"from":"string","amount":number,"expectedDate":"YYYY-MM-DD","status":"pending|confirmed"}],\n  "summary": "1-2 sentence summary"\n}`;
    return await callGroq(apiKey, [{ role: 'user', content: prompt }]);
  };

  const handleFiles = async (fileList) => {
    if (!apiKey) { addToast('Enter Groq API key first', 'error'); return; }
    setLoading(true);
    const newResults = [];
    for (const file of fileList) {
      try {
        let content = file.type === 'application/pdf' || file.type.startsWith('image/')
          ? `[File: ${file.name}, Type: ${file.type}] Requires OCR extraction.`
          : await file.text();
        const raw = await processWithGroq(content, file.name);
        let parsed;
        try { parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim()); }
        catch { parsed = { summary: raw, type: 'unknown' }; }
        newResults.push({ file: file.name, data: parsed, status: 'success' });
        if (parsed.balance) setBalance(parsed.balance);
        if (parsed.obligations?.length) setObligations(prev => [...prev, ...parsed.obligations.map((o, i) => ({ ...o, id: Date.now() + i }))]);
        if (parsed.receivables?.length) setReceivables(prev => [...prev, ...parsed.receivables.map((r, i) => ({ ...r, id: Date.now() + i }))]);
      } catch (e) { newResults.push({ file: file.name, status: 'error', error: e.message }); }
    }
    setResults(prev => [...newResults, ...prev]);
    setLoading(false);
    addToast(`Processed ${fileList.length} file(s)`, 'success');
  };

  const handleManual = async () => {
    if (!manualText.trim() || !apiKey) { addToast('Enter Groq API key and text', 'error'); return; }
    setLoading(true);
    try {
      const raw = await processWithGroq(manualText, 'manual-input.txt');
      let parsed;
      try { parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim()); }
      catch { parsed = { summary: raw }; }
      setResults(prev => [{ file: 'Manual Input', data: parsed, status: 'success' }, ...prev]);
      if (parsed.balance) setBalance(parsed.balance);
      if (parsed.obligations?.length) setObligations(prev => [...prev, ...parsed.obligations.map((o, i) => ({ ...o, id: Date.now() + i }))]);
      if (parsed.receivables?.length) setReceivables(prev => [...prev, ...parsed.receivables.map((r, i) => ({ ...r, id: Date.now() + i }))]);
      addToast('Data extracted and imported', 'success');
      setManualText('');
    } catch (e) { addToast(e.message, 'error'); }
    setLoading(false);
  };

  const extractSMS = async () => {
    if (!smsText.trim()) return;
    setSmsLoading(true);
    try {
      let extracted;
      if (apiKey) {
        const prompt = `Extract financial data from these SMS messages. Return ONLY valid JSON:\n{\n  "latestBalance": number_or_null,\n  "transactions": [{"date":"YYYY-MM-DD","description":"string","amount":number,"type":"credit|debit","bank":"string"}],\n  "detectedObligations": [{"name":"string","amount":number,"dueDate":"YYYY-MM-DD","category":"loan|utility|other","vendor":"string","flexible":true}],\n  "insights": ["string"]\n}\n\nSMS Messages:\n${smsText}`;
        const raw = await callGroq(apiKey, [{ role: 'user', content: prompt }]);
        try { extracted = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim()); }
        catch { extracted = { insights: [raw] }; }
      } else {
        const lines = smsText.split('\n').filter(Boolean);
        const transactions = [];
        let latestBalance = null;
        for (const line of lines) {
          const parsed = parseSMSBalance(line);
          if (parsed.balance) latestBalance = parsed.balance;
          if (parsed.credit) transactions.push({ description: line.slice(0, 50), amount: parsed.credit, type: 'credit' });
          if (parsed.debit) transactions.push({ description: line.slice(0, 50), amount: parsed.debit, type: 'debit' });
        }
        extracted = { latestBalance, transactions, insights: ['Parsed using deterministic rules (no API key)'] };
      }
      setSmsResults(extracted);
      if (extracted.latestBalance) { setBalance(extracted.latestBalance); addToast(`Balance updated: ₹${extracted.latestBalance.toLocaleString()}`, 'success'); }
      if (extracted.detectedObligations?.length) {
        setObligations(prev => [...prev, ...extracted.detectedObligations.map((o, i) => ({ ...o, id: Date.now() + i }))]);
        addToast(`${extracted.detectedObligations.length} obligations detected`, 'success');
      }
    } catch (e) { addToast(e.message, 'error'); }
    setSmsLoading(false);
  };

  const checkGmailStatus = async (silent = false) => {
    setGmailLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/gmail/status`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to fetch Gmail status');
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
    if (!gmailConnected) return [];
    setGmailLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/gmail/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sinceDays: lookbackDays, maxResults: 50 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gmail sync failed');

      const imported = data.transactions || [];
      if (!silent) {
        addToast(imported.length ? `Imported ${imported.length} transaction(s) from Gmail` : 'No new Gmail transactions found', 'success');
      }

      let latestBalance = null;
      imported.forEach(t => {
        if (typeof t.balance === 'number' && Number.isFinite(t.balance)) latestBalance = t.balance;
      });

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

      if (historyEntries.length) {
        setTransactions(prev => [...historyEntries, ...prev]);
      }

      if (latestBalance !== null) {
        setBalance(latestBalance);
        if (!silent) addToast(`Balance updated: ₹${latestBalance.toLocaleString()}`, 'success');
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
      const res = await fetch(`${BACKEND_URL}/api/gmail/reset`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Reset failed');
      addToast('Gmail import memory cleared. You can sync again.', 'success');
    } catch (e) {
      addToast(e.message, 'error');
    } finally {
      setGmailLoading(false);
    }
  };

  const disconnectGmail = async () => {
    setGmailLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/gmail/disconnect`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Disconnect failed');
      setGmailConnected(false);
      setGmailEmail('');
      setAutoSync(false);
      setGmailTransactions([]);
      setGmailLastSync(null);
      addToast('Gmail disconnected. Click "Connect Gmail" to re-link.', 'success');
    } catch (e) {
      addToast(e.message, 'error');
    } finally {
      setGmailLoading(false);
    }
  };

  useEffect(() => {
    checkGmailStatus(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoSync || !gmailConnected) return;
    const timer = setInterval(() => { syncGmail(true).catch(() => null); }, 60000);
    return () => clearInterval(timer);
  }, [autoSync, gmailConnected]);

  return React.createElement('div', null,
    React.createElement('div', { className: 'page-header' },
      React.createElement('div', { className: 'page-title' }, 'Transaction History'),
      React.createElement('div', { className: 'page-sub' }, 'Gmail-synced transaction alerts + your full history')
    ),

    React.createElement('div', { className: 'tabs' },
      ['file', 'text', 'sms', 'history', 'gmail'].map(t => React.createElement('div', {
        key: t, className: `tab ${tab === t ? 'active' : ''}`,
        onClick: () => setTab(t)
      }, t === 'file' ? '⊕ File Upload' : t === 'text' ? '✎ Paste Text' : t === 'sms' ? '◫ SMS Extract' : t === 'history' ? '⟲ History' : '✉ Gmail Auto-Import'))
    ),

    tab === 'file' && React.createElement('div', { className: 'section-gap' },
      React.createElement('div', {
        className: `upload-zone ${dragging ? 'drag' : ''}`,
        onClick: () => fileRef.current.click(),
        onDragOver: e => { e.preventDefault(); setDragging(true); },
        onDragLeave: () => setDragging(false),
        onDrop: e => { e.preventDefault(); setDragging(false); handleFiles([...e.dataTransfer.files]); }
      },
        React.createElement('div', { className: 'icon' }, '⊕'),
        React.createElement('div', { className: 'title' }, 'Drop files here or click to browse'),
        React.createElement('div', { className: 'sub' }, 'Bank statements (CSV/TXT), invoices (PDF), receipts (JPG/PNG)'),
        React.createElement('input', { ref: fileRef, type: 'file', multiple: true, accept: '.csv,.txt,.pdf,.jpg,.jpeg,.png,.xlsx', style: { display: 'none' }, onChange: e => handleFiles([...e.target.files]) })
      )
    ),

    tab === 'text' && React.createElement('div', { className: 'section-gap' },
      React.createElement('div', { className: 'form-group' },
        React.createElement('label', { className: 'form-label' }, 'Paste bank statement, invoice, or any financial text'),
        React.createElement('textarea', { className: 'textarea', rows: 8, placeholder: 'Paste CSV data, email content, or any financial text...', value: manualText, onChange: e => setManualText(e.target.value) })
      ),
      React.createElement('button', { className: 'btn btn-primary', onClick: handleManual, disabled: loading || !manualText.trim() },
        loading ? React.createElement('span', { className: 'loader' }) : null, ' Extract & Import')
    ),

    tab === 'sms' && React.createElement('div', { className: 'grid-2' },
      React.createElement('div', null,
        React.createElement('div', { className: 'form-group' },
          React.createElement('label', { className: 'form-label' }, 'Paste SMS messages (one per line)'),
          React.createElement('textarea', { className: 'textarea', rows: 12, value: smsText, onChange: e => setSmsText(e.target.value), placeholder: 'Paste your bank SMS messages here...' })
        ),
        React.createElement('div', { style: { display: 'flex', gap: 10 } },
          React.createElement('button', { className: 'btn btn-primary', onClick: extractSMS, disabled: smsLoading || !smsText.trim() },
            smsLoading ? React.createElement('span', { className: 'loader' }) : '⊞', ' Extract'),
          React.createElement('button', { className: 'btn btn-secondary', onClick: () => setSmsText(SAMPLE_SMS) }, 'Load Sample SMS')
        )
      ),
      React.createElement('div', null,
        smsResults ? React.createElement('div', null,
          smsResults.latestBalance && React.createElement('div', { className: 'stat-card section-gap' },
            React.createElement('div', { className: 'stat-label' }, 'Detected Balance'),
            React.createElement('div', { className: 'stat-value green' }, '₹' + smsResults.latestBalance.toLocaleString())
          ),
          smsResults.transactions?.length > 0 && React.createElement('div', { className: 'card section-gap' },
            React.createElement('div', { className: 'card-title' }, `Transactions (${smsResults.transactions.length})`),
            React.createElement('div', { className: 'timeline' },
              smsResults.transactions.slice(0, 8).map((t, i) =>
                React.createElement('div', { key: i, className: 'timeline-item' },
                  React.createElement('div', { className: 'timeline-dot', style: { background: t.type === 'credit' ? 'var(--accent)' : 'var(--danger)' } }),
                  React.createElement('div', { className: 'timeline-content' },
                    React.createElement('span', { className: 'timeline-amount', style: { color: t.type === 'credit' ? 'var(--accent)' : 'var(--danger)' } }, (t.type === 'credit' ? '+' : '-') + '₹' + t.amount?.toLocaleString()),
                    React.createElement('span', { style: { color: 'var(--text3)', fontSize: 12, marginLeft: 8 } }, t.description?.slice(0, 40))
                  )
                )
              )
            )
          ),
          smsResults.insights?.length > 0 && React.createElement('div', { className: 'reasoning-box' },
            React.createElement('span', { className: 'cot-label' }, '◈ AI Insights'),
            smsResults.insights.join('\n')
          )
        ) : React.createElement('div', { className: 'empty' },
          React.createElement('div', { className: 'icon' }, '◫'),
          React.createElement('div', { className: 'title' }, 'Paste SMS messages to extract data'),
          React.createElement('div', { className: 'sub' }, 'Works with HDFC, SBI, ICICI, Axis, Paytm and more')
        )
      )
    ),

    tab === 'history' && React.createElement('div', { className: 'section-gap' },
      React.createElement('div', { className: 'grid-2 section-gap' },
        React.createElement('div', { className: 'stat-card' },
          React.createElement('div', { className: 'stat-label' }, 'Cash Balance'),
          React.createElement('div', { className: 'stat-value green' }, '₹' + (balance || 0).toLocaleString()),
          React.createElement('div', { className: 'stat-sub' }, 'Updated from Gmail when available')
        ),
        React.createElement('div', { className: 'stat-card' },
          React.createElement('div', { className: 'stat-label' }, 'Transactions'),
          React.createElement('div', { className: 'stat-value', style: { color: '#0091ff' } }, (historyTransactions || []).length.toLocaleString()),
          React.createElement('div', { className: 'stat-sub' }, 'Full history list')
        )
      ),
      React.createElement('div', { className: 'card' },
        React.createElement('div', { className: 'card-title' }, 'History'),
        (historyTransactions || []).length === 0
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
                (historyTransactions || []).slice(0, 50).map(t =>
                  React.createElement('tr', { key: t.id },
                    React.createElement('td', null, React.createElement('span', { style: { fontFamily: 'DM Mono', fontSize: 12 } }, t.date || '—')),
                    React.createElement('td', null, React.createElement('span', { style: { color: 'var(--text)', fontWeight: 500 } }, (t.description || '').slice(0, 60))),
                    React.createElement('td', null, React.createElement('span', { className: `badge ${t.type === 'credit' ? 'badge-green' : 'badge-red'}` }, t.type || '—')),
                    React.createElement('td', null,
                      React.createElement('span', {
                        style: { fontFamily: 'DM Mono', fontSize: 12, color: t.type === 'credit' ? 'var(--accent)' : 'var(--danger)' }
                      },
                        (t.type === 'credit' ? '+' : '-') + '₹' + (t.amount || 0).toLocaleString()
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

    tab === 'gmail' && React.createElement('div', { className: 'grid-2' },
      React.createElement('div', null,
        React.createElement('div', { className: 'form-group' },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 } },
            React.createElement('div', null,
              React.createElement('div', { className: 'form-label' }, 'Gmail Connection'),
              React.createElement('div', { style: { marginTop: 6, fontSize: 13, color: 'var(--text2)' } },
                gmailConnected
                  ? `Connected: ${gmailEmail || 'email'}`
                  : 'Not connected'
              )
            ),
            React.createElement('div', null,
              React.createElement('span', { className: `badge ${gmailConnected ? 'badge-green' : 'badge-red'}` }, gmailConnected ? 'CONNECTED' : 'OFF')
            )
          )
        ),
        React.createElement('div', { className: 'form-group' },
          React.createElement('label', { className: 'form-label' }, 'LOOKBACK (DAYS)'),
          React.createElement('input', {
            className: 'input',
            type: 'number',
            value: lookbackDays,
            min: 1,
            onChange: e => setLookbackDays(Math.min(30, Math.max(1, Number(e.target.value) || 7)))
          })
        ),
        React.createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          !gmailConnected
            ? React.createElement('button', {
                className: 'btn btn-primary',
                onClick: () => {
                  window.open(`${BACKEND_URL}/auth/google/start`, '_blank', 'noopener,noreferrer');
                  addToast('Connect Gmail in the opened tab, then click "Check status".', 'success');
                },
                disabled: gmailLoading
              },
              gmailLoading ? React.createElement('span', { className: 'loader' }) : 'Connect Gmail'
            )
            : React.createElement('button', { className: 'btn btn-primary', onClick: () => syncGmail(false), disabled: gmailLoading },
              gmailLoading ? React.createElement('span', { className: 'loader' }) : '⊞ Sync now'
            ),
          React.createElement('button', { className: 'btn btn-secondary', onClick: () => checkGmailStatus(false), disabled: gmailLoading }, 'Check status'),
          gmailConnected ? React.createElement('button', { className: 'btn btn-secondary', onClick: resetGmailImport, disabled: gmailLoading }, 'Reset import memory') : null,
          gmailConnected ? React.createElement('button', { className: 'btn btn-danger', onClick: disconnectGmail, disabled: gmailLoading }, 'Disconnect Gmail') : null
        ),
        gmailConnected && React.createElement('label', {
          style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: 'var(--text2)', fontSize: 13, marginTop: 10 }
        },
          React.createElement('input', { type: 'checkbox', checked: autoSync, onChange: e => setAutoSync(e.target.checked) }),
          'Auto-sync every 60s'
        ),
        React.createElement('div', { style: { marginTop: 10, fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono', lineHeight: 1.5 } },
          gmailLastSync ? `Last sync: ${new Date(gmailLastSync).toLocaleString()}` : 'No sync yet'
        )
      ),
      React.createElement('div', null,
        gmailTransactions.length > 0
          ? React.createElement('div', null,
              React.createElement('div', { className: 'card section-gap' },
                React.createElement('div', { className: 'card-title' }, `Imported from Gmail (${gmailTransactions.length})`),
                React.createElement('div', { className: 'timeline' },
                  gmailTransactions.slice(0, 12).map((t, i) =>
                    React.createElement('div', { key: t?.id || i, className: 'timeline-item' },
                      React.createElement('div', {
                        className: 'timeline-dot',
                        style: { background: t?.type === 'credit' ? 'var(--accent)' : 'var(--danger)' }
                      }),
                      React.createElement('div', { className: 'timeline-content' },
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 10 } },
                          React.createElement('span', null, t?.description || t?.counterparty || 'Transaction'),
                          t?.amount
                            ? React.createElement('span', { className: 'timeline-amount', style: { color: t.type === 'credit' ? 'var(--accent)' : 'var(--danger)' } },
                                (t.type === 'credit' ? '+' : '-') + '₹' + Number(t.amount).toLocaleString()
                              )
                            : null
                        ),
                        React.createElement('div', { className: 'timeline-date', style: { marginTop: 3 } }, t?.date || '')
                      )
                    )
                  )
                )
              )
            )
          : React.createElement('div', { className: 'empty' },
              React.createElement('div', { className: 'icon' }, '✉'),
              React.createElement('div', { className: 'title' }, 'Nothing imported yet'),
              React.createElement('div', { className: 'sub' }, 'Click "Sync now" to import new Gmail transaction alerts')
            )
      )
    ),

    (tab === 'file' || tab === 'text') && loading && React.createElement('div', { style: { textAlign: 'center', padding: '20px', color: 'var(--text2)', fontSize: 13 } },
      React.createElement('span', { className: 'loader' }),
      React.createElement('span', { style: { marginLeft: 8 } }, ' Analyzing with Groq AI...')
    ),

    (tab === 'file' || tab === 'text') && results.length > 0 && React.createElement('div', { className: 'card', style: { marginTop: 20 } },
      React.createElement('div', { className: 'card-title' }, 'Extraction Results'),
      results.map((r, i) => React.createElement('div', { key: i, style: { padding: '12px 0', borderBottom: '1px solid var(--border)' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 6 } },
          React.createElement('span', { style: { fontWeight: 600, color: 'var(--text)', fontSize: 13 } }, r.file),
          React.createElement('span', { className: `badge ${r.status === 'success' ? 'badge-green' : 'badge-red'}` }, r.status)
        ),
        r.status === 'success' && r.data?.summary && React.createElement('div', { style: { fontSize: 12, color: 'var(--text2)', marginBottom: 6 } }, r.data.summary),
        r.status === 'error' && React.createElement('div', { style: { fontSize: 12, color: 'var(--danger)' } }, r.error)
      ))
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
function AuthPage({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', age: '', business: '' });
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

  function validateLogin() {
    const e = {};
    if (!form.email) e.email = 'Email is required';
    else if (!validateEmail(form.email)) e.email = 'Enter a valid email address';
    if (!form.password) e.password = 'Password is required';
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
      onLogin(user);
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
      onLogin(user);
    }, 900);
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    setForm({ email: '', password: '', name: '', age: '', business: '' });
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
  const [balance, setBalance] = useState(0);
  const [obligations, setObligations] = useState(SAMPLE_OBLIGATIONS);
  const [receivables, setReceivables] = useState(SAMPLE_RECEIVABLES);
  const [actions, setActions] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((msg, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    const saved = loadUserData(currentUser);
    if (saved) {
      setApiKey(saved.apiKey || '');
      setBalance(Number(saved.balance) || 0);
      setObligations(Array.isArray(saved.obligations) ? saved.obligations : []);
      setReceivables(Array.isArray(saved.receivables) ? saved.receivables : []);
      setActions(Array.isArray(saved.actions) ? saved.actions : []);
      setTransactions(Array.isArray(saved.transactions) ? saved.transactions : []);
    } else {
      setApiKey('');
      setBalance(0);
      setObligations(Array.isArray(SAMPLE_OBLIGATIONS) ? SAMPLE_OBLIGATIONS : []);
      setReceivables(Array.isArray(SAMPLE_RECEIVABLES) ? SAMPLE_RECEIVABLES : []);
      setActions([]);
      setTransactions([]);
    }
    setPage('dashboard');
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    saveUserData(currentUser, { apiKey, balance, obligations, receivables, actions, transactions });
  }, [currentUser, apiKey, balance, obligations, receivables, actions, transactions]);

  function handleLogin(user) {
    setCurrentUser(user);
    addToast(`Welcome back, ${user.name || user.email}! 👋`, 'success');
  }

  function handleLogout() {
    clearSession();
    setCurrentUser(null);
    setPage('dashboard');
  }

  if (!currentUser) {
    return React.createElement(AuthPage, { onLogin: handleLogin });
  }

  const pages = {
    dashboard: React.createElement(Dashboard, { balance, obligations, receivables }),
    obligations: React.createElement(Obligations, { obligations, setObligations, addToast }),
    receivables: React.createElement(Receivables, { receivables, setReceivables, addToast }),
    transactions: React.createElement(TransactionHistory, { apiKey, setObligations, setReceivables, balance, setBalance, transactions, setTransactions, addToast }),
    future: React.createElement(FuturePage, { balance, obligations, receivables }),
    actions: React.createElement(Actions, { apiKey, actions, setActions, addToast, balance, obligations, receivables })
  };

  return React.createElement(React.Fragment, null,
    React.createElement('div', { className: 'app' },
      React.createElement(Sidebar, { page, setPage, apiKey, setApiKey }),
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
            React.createElement('input', {
              className: 'input',
              type: 'number',
              value: balance,
              onChange: e => setBalance(parseFloat(e.target.value) || 0),
              style: { width: 130, padding: '6px 10px', fontSize: 13, fontFamily: 'DM Mono' }
            }),
            React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: handleLogout }, '⎋ Sign Out')
          )
        ),
        pages[page]
      )
    ),
    React.createElement(ToastContainer, { toasts })
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
