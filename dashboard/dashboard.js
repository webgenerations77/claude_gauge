/* global firebase, firebaseConfig, Chart */

// ── Init Firebase ──
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// ── State ──
let usageData = [];
let openaiUsageData = [];
let scrapeLogData = [];
let quotaData = null;
let claudeUsageData = null;
let selectedRange = 14;
let sortColumn = 'cost';
let sortAsc = false;
let tokensChart = null;
let modelChart = null;
let costChart = null;

// ── Pricing (per million tokens) ──
const PRICING = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4-5-20251101': { input: 15, output: 75 },
  'claude-opus-4-1-20250805': { input: 15, output: 75 },
  'claude-fable-5': { input: 3, output: 15 },
};
const OPENAI_PRICING = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'o1': { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
  'o1-pro': { input: 150, output: 600 },
  'o3': { input: 10, output: 40 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
};
const DEFAULT_PRICING = { input: 3, output: 15 };

// ── Model colors ──
const MODEL_COLORS = {
  'claude-sonnet-4-6': '#00D2BE',
  'claude-sonnet-4-5-20250929': '#0EA5E9',
  'claude-haiku-4-5-20251001': '#8B5CF6',
  'claude-opus-4-8': '#F59E0B',
  'claude-opus-4-7': '#F97316',
  'claude-opus-4-6': '#EF4444',
  'claude-opus-4-5-20251101': '#EC4899',
  'claude-opus-4-1-20250805': '#D946EF',
  'claude-fable-5': '#10B981',
};
const OPENAI_MODEL_COLORS = {
  'gpt-4o': '#74AA9C',
  'gpt-4o-mini': '#2ECC71',
  'gpt-4-turbo': '#1ABC9C',
  'gpt-4': '#27AE60',
  'gpt-3.5-turbo': '#58D68D',
  'o1': '#3498DB',
  'o1-mini': '#5DADE2',
  'o1-pro': '#2980B9',
  'o3': '#9B59B6',
  'o3-mini': '#BB8FCE',
  'o4-mini': '#AF7AC5',
  'gpt-4.1': '#45B7D1',
  'gpt-4.1-mini': '#48C9B0',
  'gpt-4.1-nano': '#82E0AA',
};
const FALLBACK_COLORS = ['#6366F1', '#14B8A6', '#A855F7', '#F43F5E'];
let colorIdx = 0;

function getModelColor(model) {
  if (MODEL_COLORS[model]) return MODEL_COLORS[model];
  if (OPENAI_MODEL_COLORS[model]) return OPENAI_MODEL_COLORS[model];
  MODEL_COLORS[model] = FALLBACK_COLORS[colorIdx % FALLBACK_COLORS.length];
  colorIdx++;
  return MODEL_COLORS[model];
}

// ── Helpers ──
function estimateCost(row) {
  if (row.costUsd && row.costUsd > 0) return row.costUsd;
  const rates = PRICING[row.model] || OPENAI_PRICING[row.model] || DEFAULT_PRICING;
  return (
    ((row.inputTokens || 0) / 1e6) * rates.input +
    ((row.outputTokens || 0) / 1e6) * rates.output
  );
}

function formatTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatCost(n) {
  return '$' + n.toFixed(2);
}

function dateStr(d) {
  return d.toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateStr(d);
}

function startOfWeek() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return dateStr(d);
}

function startOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function filterByDateRange(data, days) {
  const cutoff = daysAgo(days);
  return data.filter((r) => r.date >= cutoff);
}

// ── Data Fetching ──
async function fetchUsageData() {
  try {
    const snapshot = await db.collection('usage').orderBy('date', 'desc').get();
    usageData = snapshot.docs.map((doc) => doc.data());
    setStatus(true);
  } catch (err) {
    console.error('Firestore usage fetch error:', err);
    setStatus(false);
  }
}

async function fetchScrapeLog() {
  try {
    const snapshot = await db
      .collection('scrape_log')
      .orderBy('scrapedAt', 'desc')
      .limit(10)
      .get();
    scrapeLogData = snapshot.docs.map((doc) => doc.data());
  } catch (err) {
    console.error('Firestore scrape_log fetch error:', err);
  }
}

async function fetchQuota() {
  try {
    const doc = await db.collection('quota').doc('latest').get();
    quotaData = doc.exists ? doc.data() : null;
  } catch (err) {
    console.error('Firestore quota fetch error:', err);
  }
}

async function fetchClaudeUsage() {
  try {
    const doc = await db.collection('claude_usage').doc('latest').get();
    claudeUsageData = doc.exists ? doc.data() : null;
  } catch (err) {
    console.error('Firestore claude_usage fetch error:', err);
  }
}

async function fetchOpenAIUsageData() {
  try {
    const snapshot = await db.collection('openai_usage').orderBy('date', 'desc').get();
    openaiUsageData = snapshot.docs.map((doc) => doc.data());
  } catch (err) {
    console.error('Firestore openai_usage fetch error:', err);
  }
}

// ── Status ──
function setStatus(connected) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  text.textContent = connected ? 'Connected' : 'Error';
}

// ── Gauge Drawing ──
function drawGauge(canvasId, pct) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h - 10;
  const radius = Math.min(cx, cy) - 10;

  ctx.clearRect(0, 0, w, h);

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, radius, Math.PI, 2 * Math.PI, false);
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#1e1e1e';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Value arc
  if (pct > 0) {
    const angle = Math.PI + (pct / 100) * Math.PI;
    let color = '#00D2BE';
    if (pct >= 90) color = '#EF4444';
    else if (pct >= 70) color = '#F59E0B';

    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI, angle, false);
    ctx.lineWidth = 14;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

// ── Claude.ai Usage ──
function renderClaudeUsage() {
  if (!claudeUsageData) return;

  const sessionPct = claudeUsageData.sessionPct || 0;
  const weeklyPct = claudeUsageData.weeklyPct || 0;

  drawGauge('session-gauge', sessionPct);
  document.getElementById('session-label').textContent = sessionPct + '%';
  document.getElementById('session-resets').textContent =
    claudeUsageData.sessionResets ? `Resets in ${claudeUsageData.sessionResets}` : 'Resets: --';

  drawGauge('weekly-gauge', weeklyPct);
  document.getElementById('weekly-label').textContent = weeklyPct + '%';
  document.getElementById('weekly-resets').textContent =
    claudeUsageData.weeklyResets ? `Resets ${claudeUsageData.weeklyResets}` : 'Resets: --';

  const spent = claudeUsageData.creditsSpent;
  document.getElementById('credits-spent').textContent =
    spent !== null && spent !== undefined ? formatCost(spent) : '--';
  document.getElementById('credits-resets').textContent =
    claudeUsageData.creditsResets ? `Resets ${claudeUsageData.creditsResets}` : '';

  document.getElementById('claude-plan').textContent = claudeUsageData.plan || '--';
  const bal = claudeUsageData.currentBalance;
  document.getElementById('claude-balance').textContent =
    bal !== null && bal !== undefined ? `Balance: ${formatCost(bal)}` : 'Balance: --';
}

// ── OpenAI Summary ──
function renderOpenAISummary() {
  const today = dateStr(new Date());
  const weekStart = startOfWeek();
  const monthStart = startOfMonth();

  const periods = [
    { id: 'oai-today', filter: (r) => r.date === today },
    { id: 'oai-week', filter: (r) => r.date >= weekStart },
    { id: 'oai-month', filter: (r) => r.date >= monthStart },
    { id: 'oai-all', filter: () => true },
  ];

  for (const p of periods) {
    const rows = openaiUsageData.filter(p.filter);
    const inTok = rows.reduce((s, r) => s + (r.inputTokens || 0), 0);
    const outTok = rows.reduce((s, r) => s + (r.outputTokens || 0), 0);
    const cost = rows.reduce((s, r) => s + estimateCost(r), 0);

    document.getElementById(`${p.id}-cost`).textContent = formatCost(cost);
    document.getElementById(`${p.id}-tokens`).textContent =
      `${formatTokens(inTok)} in / ${formatTokens(outTok)} out`;
  }
}

// ── Combined data for charts ──
function getAllUsageData() {
  return [...usageData, ...openaiUsageData];
}

// ── Exact Token Breakdown ──
function renderTokenDetails() {
  const container = document.getElementById('token-details');
  const monthStart = startOfMonth();

  const combined = getAllUsageData();
  const monthRows = combined.filter((r) => r.date >= monthStart);
  const allRows = combined;

  function sum(rows, field) {
    return rows.reduce((s, r) => s + (r[field] || 0), 0);
  }

  function exact(n) {
    return n.toLocaleString();
  }

  const categories = [
    { label: 'Input Tokens', field: 'inputTokens' },
    { label: 'Output Tokens', field: 'outputTokens' },
    { label: 'Cache Creation', field: 'cacheCreationTokens' },
    { label: 'Cache Read', field: 'cacheReadTokens' },
  ];

  const monthTotal = sum(monthRows, 'inputTokens') + sum(monthRows, 'outputTokens');
  const allTotal = sum(allRows, 'inputTokens') + sum(allRows, 'outputTokens');

  container.innerHTML =
    `<div class="token-detail-row header">
      <span>Category</span>
      <span>This Month</span>
      <span>All Time</span>
    </div>` +
    categories
      .map(
        (c) => `<div class="token-detail-row">
        <span>${c.label}</span>
        <span>${exact(sum(monthRows, c.field))}</span>
        <span>${exact(sum(allRows, c.field))}</span>
      </div>`
      )
      .join('') +
    `<div class="token-detail-row total">
      <span>Total (In + Out)</span>
      <span>${exact(monthTotal)}</span>
      <span>${exact(allTotal)}</span>
    </div>`;
}

// ── Quota Bar ──
function renderQuota() {
  const creditsEl = document.getElementById('quota-credits');
  const unpaidEl = document.getElementById('quota-unpaid');
  const updatedEl = document.getElementById('quota-updated');

  if (!quotaData) {
    creditsEl.textContent = 'N/A';
    unpaidEl.textContent = 'N/A';
    updatedEl.textContent = 'Never';
    return;
  }

  if (quotaData.creditsUsd !== null && quotaData.creditsUsd !== undefined) {
    const credits = quotaData.creditsUsd;
    creditsEl.textContent = formatCost(Math.abs(credits));
    if (credits < 0) {
      creditsEl.textContent = '-' + creditsEl.textContent;
      creditsEl.className = 'quota-value negative';
    } else {
      creditsEl.className = 'quota-value positive';
    }
  } else {
    creditsEl.textContent = 'N/A';
  }

  if (quotaData.unpaidBalanceUsd !== null && quotaData.unpaidBalanceUsd !== undefined) {
    unpaidEl.textContent = formatCost(quotaData.unpaidBalanceUsd);
    unpaidEl.className = quotaData.unpaidBalanceUsd > 0
      ? 'quota-value negative'
      : 'quota-value positive';
  } else {
    unpaidEl.textContent = '$0.00';
    unpaidEl.className = 'quota-value positive';
  }

  if (quotaData.updatedAt) {
    const t = new Date(quotaData.updatedAt.seconds * 1000);
    updatedEl.textContent = t.toLocaleString();
  }
}

// ── Summary Cards ──
function renderSummary() {
  const today = dateStr(new Date());
  const weekStart = startOfWeek();
  const monthStart = startOfMonth();

  const periods = [
    { id: 'today', filter: (r) => r.date === today },
    { id: 'week', filter: (r) => r.date >= weekStart },
    { id: 'month', filter: (r) => r.date >= monthStart },
    { id: 'all', filter: () => true },
  ];

  for (const p of periods) {
    const rows = usageData.filter(p.filter);
    const inTok = rows.reduce((s, r) => s + (r.inputTokens || 0), 0);
    const outTok = rows.reduce((s, r) => s + (r.outputTokens || 0), 0);
    const cost = rows.reduce((s, r) => s + estimateCost(r), 0);

    document.getElementById(`${p.id}-cost`).textContent = formatCost(cost);
    document.getElementById(`${p.id}-tokens`).textContent =
      `${formatTokens(inTok)} in / ${formatTokens(outTok)} out`;
  }
}

// ── Charts ──
function getChartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#e0e0e0', font: { size: 11 } } },
    },
    scales: {
      x: {
        ticks: { color: '#888', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.04)' },
      },
      y: {
        ticks: { color: '#888', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.06)' },
      },
    },
  };
}

function renderTokensChart() {
  const filtered = filterByDateRange(getAllUsageData(), selectedRange);
  const dailyMap = {};
  for (const r of filtered) {
    dailyMap[r.date] = (dailyMap[r.date] || 0) + (r.inputTokens || 0) + (r.outputTokens || 0);
  }
  const dates = Object.keys(dailyMap).sort();
  const values = dates.map((d) => dailyMap[d]);

  const ctx = document.getElementById('tokens-chart').getContext('2d');
  if (tokensChart) tokensChart.destroy();
  tokensChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        {
          label: 'Total Tokens',
          data: values,
          borderColor: '#00D2BE',
          backgroundColor: 'rgba(0, 210, 190, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: '#00D2BE',
        },
      ],
    },
    options: getChartDefaults(),
  });
}

function renderModelChart() {
  const filtered = filterByDateRange(getAllUsageData(), selectedRange);
  const models = [...new Set(filtered.map((r) => r.model))];
  const dateSet = [...new Set(filtered.map((r) => r.date))].sort();

  const datasets = models.map((model) => {
    const color = getModelColor(model);
    return {
      label: model,
      data: dateSet.map((date) => {
        const row = filtered.find((r) => r.date === date && r.model === model);
        return row ? (row.inputTokens || 0) + (row.outputTokens || 0) : 0;
      }),
      backgroundColor: color + 'CC',
      borderColor: color,
      borderWidth: 1,
    };
  });

  const ctx = document.getElementById('model-chart').getContext('2d');
  if (modelChart) modelChart.destroy();
  modelChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: dateSet, datasets },
    options: {
      ...getChartDefaults(),
      scales: {
        ...getChartDefaults().scales,
        x: { ...getChartDefaults().scales.x, stacked: true },
        y: { ...getChartDefaults().scales.y, stacked: true },
      },
    },
  });
}

function renderCostChart() {
  const filtered = filterByDateRange(getAllUsageData(), selectedRange);
  const dailyMap = {};
  for (const r of filtered) {
    dailyMap[r.date] = (dailyMap[r.date] || 0) + estimateCost(r);
  }
  const dates = Object.keys(dailyMap).sort();
  const values = dates.map((d) => dailyMap[d]);

  const ctx = document.getElementById('cost-chart').getContext('2d');
  if (costChart) costChart.destroy();
  costChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        {
          label: 'Est. Cost (USD)',
          data: values,
          borderColor: '#F59E0B',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: '#F59E0B',
        },
      ],
    },
    options: {
      ...getChartDefaults(),
      scales: {
        ...getChartDefaults().scales,
        y: {
          ...getChartDefaults().scales.y,
          ticks: {
            ...getChartDefaults().scales.y.ticks,
            callback: (v) => '$' + v.toFixed(2),
          },
        },
      },
    },
  });
}

// ── Model Breakdown Table ──
function renderModelTable() {
  const filtered = filterByDateRange(getAllUsageData(), selectedRange);
  const modelMap = {};
  let totalTokens = 0;

  for (const r of filtered) {
    if (!modelMap[r.model]) {
      modelMap[r.model] = { model: r.model, inputTokens: 0, outputTokens: 0, cost: 0 };
    }
    modelMap[r.model].inputTokens += r.inputTokens || 0;
    modelMap[r.model].outputTokens += r.outputTokens || 0;
    modelMap[r.model].cost += estimateCost(r);
    totalTokens += (r.inputTokens || 0) + (r.outputTokens || 0);
  }

  let rows = Object.values(modelMap).map((m) => ({
    ...m,
    pct: totalTokens > 0 ? ((m.inputTokens + m.outputTokens) / totalTokens) * 100 : 0,
  }));

  rows.sort((a, b) => {
    const av = a[sortColumn];
    const bv = b[sortColumn];
    if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortAsc ? av - bv : bv - av;
  });

  const tbody = document.querySelector('#model-table tbody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888">No usage data in selected range</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${r.model}</td>
      <td>${formatTokens(r.inputTokens)}</td>
      <td>${formatTokens(r.outputTokens)}</td>
      <td>${formatCost(r.cost)}</td>
      <td>${r.pct.toFixed(1)}%</td>
    </tr>`
    )
    .join('');

  document.querySelectorAll('#model-table th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === sortColumn);
    const arrow = th.querySelector('.sort-arrow');
    if (th.dataset.sort === sortColumn) {
      arrow.innerHTML = sortAsc ? '&#9650;' : '&#9660;';
    } else {
      arrow.innerHTML = '&#9650;';
    }
  });
}

// ── Scrape Log ──
function renderScrapeLog() {
  const container = document.getElementById('scrape-log');

  if (scrapeLogData.length === 0) {
    container.innerHTML = '<div class="loading">No scrape logs yet.</div>';
    return;
  }

  container.innerHTML = scrapeLogData
    .map((entry) => {
      const time = entry.scrapedAt
        ? new Date(entry.scrapedAt.seconds * 1000).toLocaleString()
        : '--';
      return `
      <div class="log-entry">
        <span class="log-time">${time}</span>
        <span class="log-status ${entry.status}">${entry.status}</span>
        <span class="log-rows">${entry.rowsUpserted || 0} rows</span>
        ${entry.errorMessage ? `<span class="log-error-msg">${entry.errorMessage}</span>` : ''}
      </div>`;
    })
    .join('');
}

// ── Footer ──
function renderFooter() {
  const lastScrape = scrapeLogData[0];
  const lastEl = document.getElementById('footer-last-scrape');
  const nextEl = document.getElementById('footer-next-scrape');

  if (lastScrape && lastScrape.scrapedAt) {
    const lastTime = new Date(lastScrape.scrapedAt.seconds * 1000);
    lastEl.textContent = `Last scraped: ${lastTime.toLocaleString()}`;

    const nextTime = new Date(lastTime.getTime() + 5 * 60 * 1000);
    nextEl.textContent = `Next scrape: ~${nextTime.toLocaleString()}`;
  } else {
    lastEl.textContent = 'Last scraped: --';
    nextEl.textContent = 'Next scrape: --';
  }
}

// ── Render All ──
function renderAll() {
  renderClaudeUsage();
  renderQuota();
  renderSummary();
  renderOpenAISummary();
  renderTokenDetails();
  renderTokensChart();
  renderModelChart();
  renderCostChart();
  renderModelTable();
  renderScrapeLog();
  renderFooter();

  document.getElementById('last-updated').textContent =
    `Updated: ${new Date().toLocaleTimeString()}`;
}

// ── Event Listeners ──
document.querySelectorAll('.range-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedRange = parseInt(btn.dataset.range);
    renderAll();
  });
});

document.querySelectorAll('#model-table th').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortColumn === col) {
      sortAsc = !sortAsc;
    } else {
      sortColumn = col;
      sortAsc = false;
    }
    renderModelTable();
  });
});

// ── Auth ──
auth.onAuthStateChanged((user) => {
  const signInBtn = document.getElementById('sign-in-btn');
  const userMenu = document.getElementById('user-menu');
  const scrapeBtn = document.getElementById('scrape-btn');

  if (user) {
    signInBtn.style.display = 'none';
    userMenu.style.display = 'flex';
    document.getElementById('user-avatar').src = user.photoURL || '';
    document.getElementById('user-email').textContent = user.email;
    scrapeBtn.disabled = false;
  } else {
    signInBtn.style.display = '';
    userMenu.style.display = 'none';
    scrapeBtn.disabled = true;
  }
});

document.getElementById('sign-in-btn').addEventListener('click', () => {
  auth.signInWithPopup(googleProvider);
});

document.getElementById('switch-btn').addEventListener('click', () => {
  auth.signInWithPopup(googleProvider);
});

document.getElementById('sign-out-btn').addEventListener('click', () => {
  auth.signOut();
});

// ── Refresh Button ──
document.getElementById('refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  await Promise.all([fetchUsageData(), fetchOpenAIUsageData(), fetchScrapeLog(), fetchQuota(), fetchClaudeUsage()]);
  renderAll();
  btn.classList.remove('spinning');
  btn.disabled = false;
});

// ── Request Scrape ──
document.getElementById('scrape-btn').addEventListener('click', async () => {
  const user = auth.currentUser;
  if (!user) return;

  const btn = document.getElementById('scrape-btn');
  btn.disabled = true;
  btn.textContent = '▶ Requesting...';

  try {
    await db.collection('scrape_requests').add({
      requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
      requestedBy: user.email,
      status: 'pending',
    });
    btn.textContent = '✓ Requested';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '▶ Scrape';
    }, 3000);
  } catch (err) {
    console.error('Error requesting scrape:', err);
    btn.textContent = '✗ Error';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '▶ Scrape';
    }, 3000);
  }
});

// ── Init ──
async function init() {
  await Promise.all([fetchUsageData(), fetchOpenAIUsageData(), fetchScrapeLog(), fetchQuota(), fetchClaudeUsage()]);
  renderAll();
}

init();

// Auto-refresh every 60 seconds
setInterval(async () => {
  await Promise.all([fetchUsageData(), fetchOpenAIUsageData(), fetchScrapeLog(), fetchQuota(), fetchClaudeUsage()]);
  renderAll();
}, 60000);
