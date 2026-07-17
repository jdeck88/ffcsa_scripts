const fs = require('fs');
const path = require('path');
const axios = require('axios');
const fastcsv = require('fast-csv');
const XLSX = require('xlsx');
const crypto = require('crypto');
const { isBecomeAMemberSubscription } = require('./subscription_price_lists');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const SHEET_ID =
  process.env.GOOGLE_SHEETS_ID ||
  process.env.DASHBOARD_SHEET_ID ||
  '1plDSzQo8PZqQbCAt9Xb1BRd-cdJmkpoGwSmCFQvolUc';
const SOURCE_GID = process.env.DASHBOARD_SOURCE_GID || '707104494';
const TARGET_SHEET_TITLE =
  process.env.GOOGLE_SHEETS_TAB ||
  process.env.DASHBOARD_TARGET_TITLE ||
  'Dashboard-auto-26';
const DATA_DIR = path.join(__dirname, 'data');
const WEEKLY_KPI_PATH = path.join(__dirname, 'data', 'weekly_kpi.json');
const TIMESHEETS_SERVICE_PATH = path.resolve(__dirname, '../../timesheets/server/services/userService.js');
const TIMESHEETS_DB_PATH = path.resolve(__dirname, '../../timesheets/server/models/db.js');
const TIMESHEET_APPROVED_STATUSES =
  process.env.TIMESHEET_APPROVED_STATUSES || '1,0,2,3';

const DRY_RUN = process.argv.includes('--dry-run');

function toYMDFromSheetWeekLabel(value) {
  const m = String(value || '')
    .trim()
    .match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/);
  if (!m) return null;
  const mm = String(Number(m[1])).padStart(2, '0');
  const dd = String(Number(m[2])).padStart(2, '0');
  const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysYMD(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function loadWeeklyKpiMap() {
  if (!fs.existsSync(WEEKLY_KPI_PATH)) return {};
  const raw = fs.readFileSync(WEEKLY_KPI_PATH, 'utf8');
  const json = JSON.parse(raw);
  const map = {};
  for (const week of json.weeks || []) {
    if (!week.dateRange || !week.data) continue;
    const start = String(week.dateRange).split(' to ')[0];
    map[start] = week.data;
  }
  return map;
}

function parseVendorWeeklySummary(filePath) {
  const wb = XLSX.readFile(filePath, { raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  if (rows.length < 2) return { purchaseCost: 0, retailSales: 0 };
  const header = rows[0];
  const purchaseIdx = header.indexOf('PurchaseCost');
  const retailIdx = header.indexOf('RetailSales');
  let purchaseCost = 0;
  let retailSales = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const p = Number(row[purchaseIdx] || 0);
    const r = Number(row[retailIdx] || 0);
    if (Number.isFinite(p)) purchaseCost += p;
    if (Number.isFinite(r)) retailSales += r;
  }
  return { purchaseCost, retailSales };
}

function buildVendorWeeklyMap() {
  const map = {};
  if (!fs.existsSync(DATA_DIR)) return map;
  const files = fs.readdirSync(DATA_DIR);
  for (const file of files) {
    const m = file.match(/^vendor_weekly_summary_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})\.csv$/);
    if (!m) continue;
    map[m[1]] = parseVendorWeeklySummary(path.join(DATA_DIR, file));
  }
  return map;
}

function isPastCompleteWeek(week) {
  return week.end < getTodayYmd();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimesheetsBackend() {
  if (!process.env.TIMESHEET_DATABASE_URL) {
    return { backend: null, status: 'TIMESHEET_DATABASE_URL not set' };
  }
  if (!fs.existsSync(TIMESHEETS_SERVICE_PATH) || !fs.existsSync(TIMESHEETS_DB_PATH)) {
    return { backend: null, status: 'timesheets backend not found at ../../timesheets' };
  }

  process.env.DATABASE_URL = process.env.TIMESHEET_DATABASE_URL;

  const { getTimesheetsByWeek } = require(TIMESHEETS_SERVICE_PATH);
  const { pool } = require(TIMESHEETS_DB_PATH);
  return { backend: { getTimesheetsByWeek, pool }, status: 'enabled' };
}

async function buildTimesheetWeeklyMap(weeks) {
  const { backend, status } = getTimesheetsBackend();
  if (!backend) return { map: {}, status };

  const map = {};
  try {
    for (const week of weeks) {
      const result = await backend.getTimesheetsByWeek(
        {},
        week.start,
        week.end,
        'FFCSA',
        TIMESHEET_APPROVED_STATUSES
      );
      map[week.start] = {
        wages: Number(result?.summary?.wages?.total_wages || 0),
      };
    }
    return { map, status: `connected (${Object.keys(map).length}/${weeks.length} weeks)` };
  } catch (err) {
    return { map: {}, status: `connection error: ${err.message || err}` };
  } finally {
    try {
      await backend.pool.end();
    } catch (_err) {
      // no-op
    }
  }
}

async function fetchSourceSheetRows() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SOURCE_GID}`;
  const res = await axios.get(url, { responseType: 'text' });
  const wb = XLSX.read(res.data, { type: 'string' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
}

function extractWeeksFromSource(rows) {
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < header.length; i++) {
    const label = String(header[i] || '').trim();
    if (!label) continue;
    const start = toYMDFromSheetWeekLabel(label);
    if (!start) continue;
    out.push({
      label,
      start,
      end: addDaysYMD(start, 6),
    });
  }
  return out;
}

function mapRowsByLabel(rows) {
  const map = {};
  for (const row of rows) {
    const label = String(row[0] || '').trim();
    if (!label) continue;
    map[label] = row;
  }
  return map;
}

function getManualSourceValue(rowMap, rowLabel, weekColIdx) {
  const row = rowMap[rowLabel] || [];
  return row[weekColIdx] || '';
}

function normalizeAutoValue(valueType, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  if (valueType === 'int') return Math.round(Number(value));
  if (valueType === 'currency') return Number(value);
  if (valueType === 'percent') return Number(value) / 100; // Sheets percent format expects fraction
  return value;
}

function buildSubscriberSnapshotPath(weekEnd) {
  return path.join(__dirname, 'data', `subscribers_${weekEnd}.csv`);
}

function buildSubscriberSnapshotKey(row) {
  const planNumber = String(row['Plan #'] || '').trim();
  if (planNumber) {
    return `plan:${planNumber}`;
  }

  const email = String(row.Email || '').trim().toLowerCase();
  const customer = String(row.Customer || '').trim().toLowerCase();
  const created = String(row.Created || '').trim();
  return `fallback:${email}|${customer}|${created}`;
}

function loadSubscriberSnapshot(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const wb = XLSX.read(raw, { type: 'string' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' });
  const activeKeys = new Set();

  for (const row of rows) {
    if (!isBecomeAMemberSubscription(row)) {
      continue;
    }
    if (String(row.Status || '').trim().toLowerCase() !== 'active') {
      continue;
    }
    activeKeys.add(buildSubscriberSnapshotKey(row));
  }

  return {
    activeKeys,
    totalSubscribers: activeKeys.size,
  };
}

function countSetDifference(left, right) {
  let count = 0;
  for (const value of left) {
    if (!right.has(value)) {
      count += 1;
    }
  }
  return count;
}

function getTodayYmd() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function getLocallineAccessToken() {
  if (!process.env.USERNAME || !process.env.PASSWORD) {
    throw new Error('USERNAME/PASSWORD missing in localline/.env for Local Line API access.');
  }
  const res = await axios.post(
    'https://localline.ca/api/backoffice/v2/token',
    {
      username: process.env.USERNAME,
      password: process.env.PASSWORD,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (!res.data?.access) {
    throw new Error('Failed to obtain Local Line access token.');
  }
  return res.data.access;
}

async function requestLocallineOrdersExportId(accessToken, weekStart, weekEnd) {
  const params = new URLSearchParams({
    file_type: 'orders_list_view',
    send_to_email: 'false',
    destination_email: 'fullfarmcsa@deckfamilyfarm.com',
    direct: 'true',
    fulfillment_date_start: weekStart,
    fulfillment_date_end: weekEnd,
    status: 'OPEN',
  });
  const url = `https://localline.ca/api/backoffice/v2/orders/export/?${params.toString()}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.data?.id) {
    throw new Error(`Orders export request did not return id for ${weekStart}..${weekEnd}.`);
  }
  return res.data.id;
}

async function pollLocallineExportFilePath(accessToken, exportId) {
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await axios.get(
      `https://localline.ca/api/backoffice/v2/export/${exportId}/`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const status = res.data?.status;
    if (status === 'COMPLETE' && res.data?.file_path) {
      return res.data.file_path;
    }
    if (status === 'FAILED') {
      throw new Error(`Local Line export ${exportId} failed.`);
    }
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for Local Line export ${exportId}.`);
}

async function downloadUrlToFile(url, outPath, headers = {}) {
  const res = await axios.get(url, { responseType: 'arraybuffer', headers });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, res.data);
  return outPath;
}

async function ensureWeeklyOrdersCsv(accessToken, weekStart, weekEnd) {
  const fileName = `orders_list_${weekStart}_to_${weekEnd}.csv`;
  const outPath = path.join(DATA_DIR, fileName);
  if (fs.existsSync(outPath)) {
    return outPath;
  }
  const exportId = await requestLocallineOrdersExportId(accessToken, weekStart, weekEnd);
  const filePath = await pollLocallineExportFilePath(accessToken, exportId);
  await downloadUrlToFile(filePath, outPath);
  return outPath;
}

async function ensureProductsWorkbook(accessToken, weekEnd) {
  const outPath = path.join(DATA_DIR, `products_${weekEnd}.xlsx`);
  if (fs.existsSync(outPath)) {
    return outPath;
  }
  await downloadUrlToFile(
    'https://localline.ca/api/backoffice/v2/products/export/?direct=true',
    outPath,
    { Authorization: `Bearer ${accessToken}` }
  );
  return outPath;
}

function normalizePackageId(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isNaN(num)) {
    return String(Math.trunc(num));
  }
  const trimmed = String(value).trim();
  return trimmed || null;
}

function computeEffectiveQuantity(row) {
  let quantity = Number(row['Quantity']);
  if (Number.isNaN(quantity)) quantity = 0;
  quantity = Math.round(quantity);

  let numItems = Number(row['# of Items']);
  if (Number.isNaN(numItems)) numItems = 0;
  numItems = Math.round(numItems);

  if (numItems > 1 && quantity === 1) {
    quantity = numItems;
  }
  return quantity;
}

function buildPackagePriceMap(productsPath) {
  const wb = XLSX.readFile(productsPath, { raw: true });
  const ws =
    wb.Sheets['Packages and pricing'] ||
    wb.Sheets[wb.SheetNames[1]] ||
    wb.Sheets[wb.SheetNames[0]];
  if (!ws) {
    throw new Error(`No worksheets found in ${productsPath}`);
  }

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  if (!rows.length) {
    return {};
  }

  const header = rows[0].map((h) => String(h || '').toLowerCase().replace(/\s+/g, ''));
  const idIdx = header.indexOf('packageid');
  const priceIdx = header.indexOf('packageprice');
  if (idIdx === -1 || priceIdx === -1) {
    throw new Error(`Package ID / Package Price columns not found in ${productsPath}`);
  }

  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const key = normalizePackageId(row[idIdx]);
    if (!key) continue;
    const price = Number(row[priceIdx]);
    if (Number.isNaN(price)) continue;
    map[key] = price;
  }
  return map;
}

async function aggregateVendorSummaryFromOrders(ordersCsvPath, packagePriceMap) {
  return new Promise((resolve, reject) => {
    const summaryByVendor = {};
    fs.createReadStream(ordersCsvPath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => {
        try {
          const vendor = row['Vendor'];
          if (!vendor) return;
          if (row['Category'] === 'Membership') return;

          if (!summaryByVendor[vendor]) {
            summaryByVendor[vendor] = {
              vendor,
              retailSales: 0,
              purchaseCost: 0,
            };
          }

          const quantity = computeEffectiveQuantity(row);
          if (!quantity || quantity <= 0) return;

          const retailTotal = Number(row['Product Subtotal'] || 0) || 0;
          const packageId = normalizePackageId(row['Package ID']);
          const purchaseUnitPrice = packageId ? packagePriceMap[packageId] || 0 : 0;
          const purchaseTotal = purchaseUnitPrice * quantity;

          summaryByVendor[vendor].retailSales += retailTotal;
          summaryByVendor[vendor].purchaseCost += purchaseTotal;
        } catch (_err) {
          // continue on malformed rows
        }
      })
      .on('end', () => {
        const summary = Object.values(summaryByVendor).map((v) => {
          const markupAmount = v.retailSales - v.purchaseCost;
          const markupPercent = v.purchaseCost > 0 ? (markupAmount / v.purchaseCost) * 100 : 0;
          return {
            vendor: v.vendor,
            retailSales: v.retailSales,
            purchaseCost: v.purchaseCost,
            markupAmount,
            markupPercent,
          };
        });
        summary.sort((a, b) => b.retailSales - a.retailSales || a.vendor.localeCompare(b.vendor));
        resolve(summary);
      })
      .on('error', reject);
  });
}

async function writeVendorSummaryCsv(summary, outPath) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    const csvStream = fastcsv.format({ headers: true });
    csvStream.pipe(ws).on('finish', resolve).on('error', reject);
    for (const row of summary) {
      csvStream.write({
        Vendor: row.vendor,
        RetailSales: row.retailSales.toFixed(2),
        PurchaseCost: row.purchaseCost.toFixed(2),
        MarkupAmount: row.markupAmount.toFixed(2),
        MarkupPercent: row.markupPercent.toFixed(2),
      });
    }
    csvStream.end();
  });
}

async function backfillMissingVendorWeeklySummaries(weeks, currentMap = {}) {
  const missingPastWeeks = weeks.filter((w) => isPastCompleteWeek(w) && !currentMap[w.start]);
  if (!missingPastWeeks.length) {
    return { created: 0, checked: weeks.length, message: 'no missing past weeks' };
  }

  const accessToken = await getLocallineAccessToken();
  const packageMapCache = new Map();
  let created = 0;

  for (const week of missingPastWeeks) {
    console.log(`Backfilling vendor summary: ${week.start}..${week.end}`);
    const ordersCsvPath = await ensureWeeklyOrdersCsv(accessToken, week.start, week.end);
    const productsPath = await ensureProductsWorkbook(accessToken, week.end);

    let packagePriceMap = packageMapCache.get(productsPath);
    if (!packagePriceMap) {
      packagePriceMap = buildPackagePriceMap(productsPath);
      packageMapCache.set(productsPath, packagePriceMap);
    }

    const summary = await aggregateVendorSummaryFromOrders(ordersCsvPath, packagePriceMap);
    const outCsv = path.join(
      DATA_DIR,
      `vendor_weekly_summary_${week.start}_to_${week.end}.csv`
    );
    await writeVendorSummaryCsv(summary, outCsv);
    created += 1;
  }

  return {
    created,
    checked: weeks.length,
    message: `created ${created} weekly vendor summaries`,
  };
}

async function downloadSubscriberSnapshot(filePath, accessToken) {
  const res = await axios.get(
    'https://localline.ca/api/backoffice/v2/order-subscriptions/export/',
    {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, res.data);
  return filePath;
}

async function ensureSubscriberSnapshot(weekEnd, accessTokenCache) {
  const filePath = buildSubscriberSnapshotPath(weekEnd);
  if (fs.existsSync(filePath)) {
    return filePath;
  }

  if (weekEnd < getTodayYmd()) {
    console.warn(`⚠️ Historical subscriber snapshot missing; cannot backfill accurately: ${filePath}`);
    return null;
  }

  if (!accessTokenCache.token) {
    accessTokenCache.token = await getLocallineAccessToken();
  }
  console.log(`⬇️ Fetching live subscriber snapshot: ${filePath}`);
  return downloadSubscriberSnapshot(filePath, accessTokenCache.token);
}

async function buildSubscriberWeeklyMap(weeks) {
  const snapshotCache = new Map();
  const accessTokenCache = { token: null };
  const getSnapshot = async (weekEnd) => {
    if (!snapshotCache.has(weekEnd)) {
      const filePath = await ensureSubscriberSnapshot(weekEnd, accessTokenCache);
      snapshotCache.set(weekEnd, filePath ? loadSubscriberSnapshot(filePath) : null);
    }
    return snapshotCache.get(weekEnd);
  };

  const map = {};
  for (const week of weeks) {
    const currentSnapshot = await getSnapshot(week.end);
    if (!currentSnapshot) {
      continue;
    }

    const previousSnapshot = await getSnapshot(addDaysYMD(week.end, -7));
    map[week.start] = {
      newSubscribers: previousSnapshot
        ? countSetDifference(currentSnapshot.activeKeys, previousSnapshot.activeKeys)
        : null,
      exitingSubscribers: previousSnapshot
        ? countSetDifference(previousSnapshot.activeKeys, currentSnapshot.activeKeys)
        : null,
      totalSubscribers: currentSnapshot.totalSubscribers,
    };
  }

  return map;
}

function buildDashboardRows(
  weeks,
  rowMap,
  weeklyKpiMap,
  vendorWeeklyMap,
  timesheetWeeklyMap,
  subscriberWeeklyMap
) {
  const layout = [
    {
      section: 'GIVENS',
      rows: [
        { label: 'Errors/week', entry: 'MANUAL', source: 'Manual QA', rowLabel: 'Errors/week' },
        { label: 'Positive responses/week', entry: 'MANUAL', source: 'Manual QA', rowLabel: 'Positive responses/week' },
        { label: 'Num Orders', entry: 'AUTO', source: 'weekly_kpi.json', valueType: 'int', auto: (w) => Number(weeklyKpiMap[w.start]?.numOrders) },
        { label: 'Orders Comapred to Yearly Average', entry: 'MANUAL', source: 'Manual / Formula', rowLabel: 'Orders Comapred to Yearly Average' },
        { label: 'Num Subscriber Orders', entry: 'AUTO', source: 'weekly_kpi.json', valueType: 'int', auto: (w) => Number(weeklyKpiMap[w.start]?.numSubscriberOrders) },
        { label: 'Num Guest Orders', entry: 'AUTO', source: 'weekly_kpi.json', valueType: 'int', auto: (w) => Number(weeklyKpiMap[w.start]?.numGuestOrders) },
      ],
    },
    {
      section: 'REVENUE',
      rows: [
        {
          label: 'New Subscribers',
          entry: 'AUTO',
          source: 'subscribers_YYYY-MM-DD.csv snapshots',
          valueType: 'int',
          auto: (w) => {
            const value = subscriberWeeklyMap[w.start]?.newSubscribers;
            return value === null || value === undefined ? null : Number(value);
          },
        },
        {
          label: 'Exiting Subscribers',
          entry: 'AUTO',
          source: 'subscribers_YYYY-MM-DD.csv snapshots',
          valueType: 'int',
          auto: (w) => {
            const value = subscriberWeeklyMap[w.start]?.exitingSubscribers;
            return value === null || value === undefined ? null : Number(value);
          },
        },
        {
          label: 'Total Subscribers',
          entry: 'AUTO',
          source: 'subscribers_YYYY-MM-DD.csv snapshots',
          valueType: 'int',
          auto: (w) => Number(subscriberWeeklyMap[w.start]?.totalSubscribers),
        },
        {
          label: 'Average items Per order',
          entry: 'AUTO',
          source: 'weekly_kpi.json',
          valueType: 'int',
          auto: (w) => Number(weeklyKpiMap[w.start]?.averageItemsPerOrder),
        },
        {
          label: 'Average Order Amount',
          entry: 'AUTO',
          source: 'weekly_kpi.json',
          valueType: 'currency',
          auto: (w) => Number(weeklyKpiMap[w.start]?.averageOrderAmount),
        },
        {
          label: 'Sales compared to yearly average',
          entry: 'MANUAL',
          source: 'Manual / Formula',
          rowLabel: 'Sales compared to yearly average',
        },
        {
          label: 'Retail Sales',
          entry: 'AUTO',
          source: 'weekly_kpi.json',
          valueType: 'currency',
          auto: (w) => Number(weeklyKpiMap[w.start]?.totalSales),
        },
      ],
    },
    {
      section: 'COGS',
      rows: [
        {
          label: 'PURCHASE COST',
          entry: 'AUTO',
          source: 'vendor_weekly_summary_*.csv',
          valueType: 'currency',
          auto: (w) => Number(vendorWeeklyMap[w.start]?.purchaseCost),
        },
        {
          label: '$ Product Credits Given',
          entry: 'MANUAL',
          source: 'Manual / TODO automation',
          rowLabel: '$ Product Credits Given',
        },
        {
          label: 'Wages',
          entry: 'AUTO',
          source: 'timesheets DB (FFCSA)',
          valueType: 'currency',
          auto: (w) => Number(timesheetWeeklyMap[w.start]?.wages),
        },
        {
          label: 'Other FFCSA operating costs Ops',
          entry: 'MANUAL',
          source: 'Manual',
          rowLabel: 'Other FFCSA operating costs Ops',
        },
        {
          label: '%  product markup',
          entry: 'AUTO',
          source: 'vendor_weekly_summary_*.csv',
          valueType: 'percent',
          auto: (w) => {
            const purchase = Number(vendorWeeklyMap[w.start]?.purchaseCost || 0);
            const retail = Number(vendorWeeklyMap[w.start]?.retailSales || 0);
            if (!purchase) return null;
            return ((retail - purchase) / purchase) * 100;
          },
        },
      ],
    },
  ];

  const values = [];
  const metricRows = [];
  const sectionRows = [];

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  values.push([`FFCSA Dashboard Auto 2026`, `Updated ${now}`, '', '', ...weeks.map((w) => w.label)]);
  values.push(['Section', 'Metric', 'Entry Type', 'Source', ...weeks.map((w) => w.label)]);

  for (const group of layout) {
    sectionRows.push(values.length);
    values.push([group.section, '', '', '', ...weeks.map(() => '')]);
    for (const row of group.rows) {
      const rowValues = ['', row.label, row.entry, row.source];
      for (let i = 0; i < weeks.length; i++) {
        const week = weeks[i];
        const weekColIdxInSource = i + 1;
        if (row.entry === 'AUTO') {
          const raw = row.auto ? row.auto(week) : null;
          rowValues.push(normalizeAutoValue(row.valueType, raw));
        } else {
          rowValues.push(getManualSourceValue(rowMap, row.rowLabel || row.label, weekColIdxInSource));
        }
      }
      metricRows.push({
        rowIndex: values.length,
        valueType: row.valueType || null,
        entry: row.entry,
      });
      values.push(rowValues);
    }
  }

  return { values, metricRows, sectionRows };
}

async function getSheetsAccessToken() {
  // Prefer explicit service-account auth from localline/.env so env vars
  // loaded by dependent modules do not accidentally override Sheets writes.
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    const saPath = raw.startsWith('{')
      ? null
      : path.isAbsolute(raw)
      ? raw
      : path.resolve(__dirname, raw);

    const serviceAccount = raw.startsWith('{')
      ? JSON.parse(raw)
      : JSON.parse(fs.readFileSync(saPath, 'utf8'));

    const clientEmail = serviceAccount.client_email;
    const privateKey = serviceAccount.private_key;
    if (!clientEmail || !privateKey) {
      throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON: missing client_email/private_key.');
    }

    const now = Math.floor(Date.now() / 1000);
    const jwtHeader = { alg: 'RS256', typ: 'JWT' };
    const jwtClaim = {
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const b64url = (obj) =>
      Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

    const encodedHeader = b64url(jwtHeader);
    const encodedClaim = b64url(jwtClaim);
    const unsigned = `${encodedHeader}.${encodedClaim}`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(unsigned)
      .sign(privateKey, 'base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const assertion = `${unsigned}.${signature}`;

    const payload = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const res = await axios.post(
      'https://oauth2.googleapis.com/token',
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (!res.data?.access_token) {
      throw new Error('Failed to obtain Google access token from service account assertion.');
    }
    return res.data.access_token;
  }

  if (process.env.GOOGLE_SHEETS_ACCESS_TOKEN) {
    return process.env.GOOGLE_SHEETS_ACCESS_TOKEN;
  }

  if (
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  ) {
    const payload = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });
    const res = await axios.post('https://oauth2.googleapis.com/token', payload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.data?.access_token) {
      throw new Error('Failed to obtain Google access token from refresh token.');
    }
    return res.data.access_token;
  }

  throw new Error(
    'Google Sheets auth missing. Set GOOGLE_SHEETS_ACCESS_TOKEN OR GOOGLE_SERVICE_ACCOUNT_JSON OR GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN. ' +
      'MAIL_USER/MAIL_ACCESS are SMTP credentials and cannot authorize Sheets API writes.'
  );
}

function hexColor(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return { red: r, green: g, blue: b };
}

async function sheetsRequest(accessToken, method, url, data) {
  return axios({
    method,
    url,
    data,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
}

async function getOrCreateSheet(accessToken, spreadsheetId, title) {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`;
  const meta = await sheetsRequest(accessToken, 'get', metaUrl);
  const sheet = (meta.data?.sheets || []).find((s) => s.properties?.title === title);
  if (sheet) return sheet.properties.sheetId;

  const addReq = {
    requests: [{ addSheet: { properties: { title } } }],
  };
  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
  const addResp = await sheetsRequest(accessToken, 'post', batchUrl, addReq);
  return addResp.data?.replies?.[0]?.addSheet?.properties?.sheetId;
}

async function writeDashboardToSheet(accessToken, values, metricRows, sectionRows) {
  const sheetId = await getOrCreateSheet(accessToken, SHEET_ID, TARGET_SHEET_TITLE);
  const maxCols = values[0].length;
  const maxRows = values.length;
  const titleMergeEndCol = Math.min(4, maxCols);

  await sheetsRequest(
    accessToken,
    'post',
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${TARGET_SHEET_TITLE}!A:ZZ`)}:clear`,
    {}
  );

  await sheetsRequest(
    accessToken,
    'put',
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${TARGET_SHEET_TITLE}!A1`)}?valueInputOption=USER_ENTERED`,
    { range: `${TARGET_SHEET_TITLE}!A1`, majorDimension: 'ROWS', values }
  );

  const requests = [];

  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: { frozenRowCount: 2, frozenColumnCount: 4 },
      },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  });

  if (titleMergeEndCol > 1) {
    requests.push({
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: titleMergeEndCol,
        },
        mergeType: 'MERGE_ALL',
      },
    });
  }

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: maxCols },
      cell: {
        userEnteredFormat: {
          backgroundColor: hexColor('#1F4E78'),
          textFormat: { foregroundColor: hexColor('#FFFFFF'), bold: true, fontSize: 12 },
          horizontalAlignment: 'LEFT',
          verticalAlignment: 'MIDDLE',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
    },
  });

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: maxCols },
      cell: {
        userEnteredFormat: {
          backgroundColor: hexColor('#2F75B5'),
          textFormat: { foregroundColor: hexColor('#FFFFFF'), bold: true },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  });

  for (const r of sectionRows) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: maxCols },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexColor('#D9E1F2'),
            textFormat: { bold: true },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    });
  }

  for (const m of metricRows) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: m.rowIndex, endRowIndex: m.rowIndex + 1, startColumnIndex: 2, endColumnIndex: 3 },
        cell: {
          userEnteredFormat: {
            backgroundColor: m.entry === 'AUTO' ? hexColor('#D9EAD3') : hexColor('#FFF2CC'),
            textFormat: { bold: true },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    });

    if (!m.valueType) continue;
    let pattern = null;
    if (m.valueType === 'currency') pattern = '$#,##0.00';
    if (m.valueType === 'int') pattern = '0';
    if (m.valueType === 'percent') pattern = '0.00%';
    if (!pattern) continue;

    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: m.rowIndex,
          endRowIndex: m.rowIndex + 1,
          startColumnIndex: 4,
          endColumnIndex: maxCols,
        },
        cell: {
          userEnteredFormat: {
            numberFormat: {
              type:
                m.valueType === 'currency'
                  ? 'CURRENCY'
                  : m.valueType === 'percent'
                  ? 'PERCENT'
                  : 'NUMBER',
              pattern,
            },
            horizontalAlignment: 'RIGHT',
          },
        },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });
  }

  requests.push({
    updateBorders: {
      range: { sheetId, startRowIndex: 1, endRowIndex: maxRows, startColumnIndex: 0, endColumnIndex: maxCols },
      top: { style: 'SOLID', width: 1, color: hexColor('#B7B7B7') },
      bottom: { style: 'SOLID', width: 1, color: hexColor('#B7B7B7') },
      left: { style: 'SOLID', width: 1, color: hexColor('#B7B7B7') },
      right: { style: 'SOLID', width: 1, color: hexColor('#B7B7B7') },
      innerHorizontal: { style: 'SOLID', width: 1, color: hexColor('#E0E0E0') },
      innerVertical: { style: 'SOLID', width: 1, color: hexColor('#E0E0E0') },
    },
  });

  const widths = [120, 320, 110, 250];
  for (let i = 0; i < widths.length; i++) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: widths[i] },
        fields: 'pixelSize',
      },
    });
  }
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: maxCols },
      properties: { pixelSize: 95 },
      fields: 'pixelSize',
    },
  });

  await sheetsRequest(
    accessToken,
    'post',
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    { requests }
  );
}

function writePreviewCsv(values) {
  const csv = values
    .map((row) =>
      row
        .map((v) => {
          const s = String(v ?? '');
          if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        })
        .join(',')
    )
    .join('\n');
  const out = path.join(
    __dirname,
    'data',
    `dashboard_auto26_preview_${new Date().toISOString().slice(0, 10)}.csv`
  );
  fs.writeFileSync(out, csv, 'utf8');
  return out;
}

async function main() {
  const sourceRows = await fetchSourceSheetRows();
  const sourceMap = mapRowsByLabel(sourceRows);
  const weeks = extractWeeksFromSource(sourceRows);
  if (!weeks.length) {
    throw new Error('No week columns found in source sheet.');
  }

  const weeklyKpiMap = loadWeeklyKpiMap();
  const vendorWeeklyMap = buildVendorWeeklyMap();
  const { map: timesheetWeeklyMap, status: timesheetStatus } =
    await buildTimesheetWeeklyMap(weeks);
  const subscriberWeeklyMap = await buildSubscriberWeeklyMap(weeks);

  const { values, metricRows, sectionRows } = buildDashboardRows(
    weeks,
    sourceMap,
    weeklyKpiMap,
    vendorWeeklyMap,
    timesheetWeeklyMap,
    subscriberWeeklyMap
  );

  console.log(`ℹ️ Timesheets status: ${timesheetStatus}`);
  console.log(`ℹ️ Target sheet: ${TARGET_SHEET_TITLE}`);
  console.log(`ℹ️ Weeks: ${weeks[0].label} ... ${weeks[weeks.length - 1].label}`);

  if (DRY_RUN) {
    const preview = writePreviewCsv(values);
    console.log(`✅ Dry run complete. Preview CSV: ${preview}`);
    return;
  }

  const accessToken = await getSheetsAccessToken();
  await writeDashboardToSheet(accessToken, values, metricRows, sectionRows);
  console.log(`✅ Wrote dashboard to Google Sheet tab "${TARGET_SHEET_TITLE}"`);
}

main().catch((err) => {
  console.error('❌ Failed to publish Dashboard-auto-26:', err.message || err);
  if (err.response?.status) {
    console.error(`❌ HTTP ${err.response.status}:`, JSON.stringify(err.response.data));
  }
  process.exit(1);
});
