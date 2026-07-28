const fs = require('fs');
const path = require('path');
const fastcsv = require('fast-csv');
const PDFDocument = require('pdfkit-table');
const axios = require('axios');
const XLSX = require('xlsx');
const crypto = require('crypto');
const utilities = require('./utilities');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const CLI_ARGS = process.argv.slice(2);
const CLI_FLAGS = new Set(CLI_ARGS.filter((arg) => arg.startsWith('--')));
const CLI_POSITIONAL = CLI_ARGS.filter((arg) => !arg.startsWith('--'));

const SHEET_CSV_PATH = CLI_POSITIONAL[0] || '/tmp/sales_kpi26.csv';
const OUTPUT_PDF_PATH =
  CLI_POSITIONAL[1] ||
  path.join(__dirname, 'data', `weekly_report_${new Date().toISOString().slice(0, 10)}.pdf`);
const WEEKLY_KPI_PATH = path.join(__dirname, 'data', 'weekly_kpi.json');
const DATA_DIR = path.join(__dirname, 'data');

const PUBLISH_DASHBOARD = CLI_FLAGS.has('--publish-dashboard');
const DASHBOARD_DRY_RUN = CLI_FLAGS.has('--dry-run') || CLI_FLAGS.has('--dashboard-dry-run');
const NO_PDF = CLI_FLAGS.has('--no-pdf');
const BACKFILL_VENDOR_WEEKS =
  CLI_FLAGS.has('--backfill-vendor-weeks') || CLI_FLAGS.has('--backfill-vendors');

const SHEET_ID =
  process.env.GOOGLE_SHEETS_ID ||
  process.env.DASHBOARD_SHEET_ID ||
  '1plDSzQo8PZqQbCAt9Xb1BRd-cdJmkpoGwSmCFQvolUc';
const SOURCE_GID = process.env.DASHBOARD_SOURCE_GID || '707104494';
const TARGET_SHEET_TITLE =
  process.env.GOOGLE_SHEETS_TAB ||
  process.env.DASHBOARD_TARGET_TITLE ||
  'Dashboard-auto-26';
const TIMESHEETS_SERVICE_PATH = path.resolve(__dirname, '../../timesheets/server/services/userService.js');
const TIMESHEETS_DB_PATH = path.resolve(__dirname, '../../timesheets/server/models/db.js');
const TIMESHEET_APPROVED_STATUSES =
  process.env.TIMESHEET_APPROVED_STATUSES || '1,0,2,3';

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

function parseNumeric(raw, type) {
  const text = String(raw || '').trim();
  if (!text) return null;

  if (type === 'currency') {
    const n = Number(text.replace(/\$/g, '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'percent') {
    const n = Number(text.replace(/%/g, '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'int') {
    const n = Number(text.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function formatValue(value, type) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  if (type === 'currency') return `$${Number(value).toFixed(2)}`;
  if (type === 'percent') return `${Number(value).toFixed(2)}%`;
  if (type === 'int') return `${Math.round(Number(value))}`;
  return `${Number(value).toFixed(2)}`;
}

function formatDelta(delta, type) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return 'N/A';
  const sign = delta > 0 ? '+' : '';
  if (type === 'currency') return `${sign}$${Number(delta).toFixed(2)}`;
  if (type === 'percent') return `${sign}${Number(delta).toFixed(2)}pp`;
  if (type === 'int') return `${sign}${Math.round(Number(delta))}`;
  return `${sign}${Number(delta).toFixed(2)}`;
}

function readCsvRows(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(fastcsv.parse({ headers: false }))
      .on('error', reject)
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows));
  });
}

function readVendorSummary(filePath) {
  return new Promise((resolve, reject) => {
    let purchaseCost = 0;
    let retailSales = 0;
    fs.createReadStream(filePath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('error', reject)
      .on('data', (row) => {
        const purchase = Number(row.PurchaseCost || 0);
        const retail = Number(row.RetailSales || 0);
        if (Number.isFinite(purchase)) purchaseCost += purchase;
        if (Number.isFinite(retail)) retailSales += retail;
      })
      .on('end', () => resolve({ purchaseCost, retailSales }));
  });
}

async function buildVendorWeeklyMap() {
  const map = {};
  const files = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : [];
  for (const file of files) {
    const m = file.match(/^vendor_weekly_summary_(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})\.csv$/);
    if (!m) continue;
    const start = m[1];
    const info = await readVendorSummary(path.join(DATA_DIR, file));
    map[start] = info;
  }
  return map;
}

function isPastCompleteWeek(week) {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayYmd = `${yyyy}-${mm}-${dd}`;
  return week.weekEnd < todayYmd;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const cachedPath = utilities.getFreshCachedFilePath(outPath, 'weekly orders CSV');
  if (cachedPath) {
    return cachedPath;
  }
  const exportId = await requestLocallineOrdersExportId(accessToken, weekStart, weekEnd);
  const filePath = await pollLocallineExportFilePath(accessToken, exportId);
  await downloadUrlToFile(filePath, outPath);
  return outPath;
}

async function ensureProductsWorkbook(accessToken, weekEnd) {
  const outPath = path.join(DATA_DIR, `products_${weekEnd}.xlsx`);
  const cachedPath = utilities.getFreshCachedFilePath(outPath, 'products workbook');
  if (cachedPath) {
    return cachedPath;
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
  const missingPastWeeks = weeks.filter((w) => isPastCompleteWeek(w) && !currentMap[w.weekStart]);
  if (!missingPastWeeks.length) {
    return { created: 0, checked: weeks.length, message: 'no missing past weeks' };
  }

  const accessToken = await getLocallineAccessToken();
  const packageMapCache = new Map();
  let created = 0;

  for (const week of missingPastWeeks) {
    console.log(`Backfilling vendor summary: ${week.weekStart}..${week.weekEnd}`);
    const ordersCsvPath = await ensureWeeklyOrdersCsv(accessToken, week.weekStart, week.weekEnd);
    const productsPath = await ensureProductsWorkbook(accessToken, week.weekEnd);

    let packagePriceMap = packageMapCache.get(productsPath);
    if (!packagePriceMap) {
      packagePriceMap = buildPackagePriceMap(productsPath);
      packageMapCache.set(productsPath, packagePriceMap);
    }

    const summary = await aggregateVendorSummaryFromOrders(ordersCsvPath, packagePriceMap);
    const outCsv = path.join(
      DATA_DIR,
      `vendor_weekly_summary_${week.weekStart}_to_${week.weekEnd}.csv`
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

function getWeeklyKpiMap() {
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

function getTimesheetsBackend() {
  if (!process.env.TIMESHEET_DATABASE_URL) {
    return { backend: null, status: 'TIMESHEET_DATABASE_URL not set' };
  }
  if (!fs.existsSync(TIMESHEETS_SERVICE_PATH) || !fs.existsSync(TIMESHEETS_DB_PATH)) {
    return { backend: null, status: 'timesheets backend not found at ../../timesheets' };
  }

  // Timesheets backend expects DATABASE_URL.
  process.env.DATABASE_URL = process.env.TIMESHEET_DATABASE_URL;

  const { getTimesheetsByWeek } = require(TIMESHEETS_SERVICE_PATH);
  const { pool } = require(TIMESHEETS_DB_PATH);
  return { backend: { getTimesheetsByWeek, pool }, status: 'enabled' };
}

async function buildTimesheetWeeklyMap(weeks) {
  const { backend, status } = getTimesheetsBackend();
  if (!backend) {
    return { map: {}, status };
  }

  const map = {};
  try {
    for (const week of weeks) {
      try {
        const result = await backend.getTimesheetsByWeek(
          {},
          week.weekStart,
          week.weekEnd,
          'FFCSA',
          TIMESHEET_APPROVED_STATUSES
        );
        map[week.weekStart] = {
          wages: Number(result?.summary?.wages?.total_wages || 0),
          hours: Number(result?.summary?.totals?.week_total || 0),
        };
      } catch (err) {
        console.error(
          `⚠️ Timesheets query failed for ${week.weekStart}..${week.weekEnd}:`,
          err.message || err
        );
      }
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

function extractWeeksFromSourceRows(rows) {
  const header = rows[0] || [];
  const weeks = [];
  for (let col = 1; col < header.length; col++) {
    const label = String(header[col] || '').trim();
    if (!label) continue;
    const weekStart = toYMDFromSheetWeekLabel(label);
    if (!weekStart) continue;
    weeks.push({
      label,
      weekStart,
      weekEnd: addDaysYMD(weekStart, 6),
      col,
    });
  }
  return weeks;
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
  if (valueType === 'percent') return Number(value) / 100;
  return value;
}

function toA1Column(index1Based) {
  let n = index1Based;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function buildSubscriberSnapshotPath(weekEnd) {
  return path.join(DATA_DIR, `subscribers_${weekEnd}.csv`);
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
  await downloadUrlToFile(
    'https://localline.ca/api/backoffice/v2/order-subscriptions/export/',
    filePath,
    { Authorization: `Bearer ${accessTokenCache.token}` }
  );
  return filePath;
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
    const currentSnapshot = await getSnapshot(week.weekEnd);
    if (!currentSnapshot) {
      continue;
    }

    const previousSnapshot = await getSnapshot(addDaysYMD(week.weekEnd, -7));
    map[week.weekStart] = {
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
  const updatedDate = new Date().toISOString().slice(0, 10);
  const scriptSource = `weekly_report.js (${updatedDate})`;
  const formulaSource = `Formula (${updatedDate})`;
  const layout = [
    {
      section: 'GIVENS',
      rows: [
        { label: 'Errors/week', entry: 'MANUAL', source: 'Manual QA', rowLabel: 'Errors/week' },
        {
          label: 'Positive responses/week',
          entry: 'MANUAL',
          source: 'Manual QA',
          rowLabel: 'Positive responses/week',
        },
        {
          label: 'Num Orders',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'int',
          auto: (w) => Number(weeklyKpiMap[w.weekStart]?.numOrders),
        },
        {
          label: 'Orders compared to yearly average',
          entry: 'AUTO',
          source: formulaSource,
          valueType: 'percent',
          formulaOf: 'Num Orders',
        },
        {
          label: 'Num Subscriber Orders',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'int',
          auto: (w) => Number(weeklyKpiMap[w.weekStart]?.numSubscriberOrders),
        },
        {
          label: 'Num Guest Orders',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'int',
          auto: (w) => Number(weeklyKpiMap[w.weekStart]?.numGuestOrders),
        },
        {
          label: 'New Subscribers',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'int',
          auto: (w) => {
            const value = subscriberWeeklyMap[w.weekStart]?.newSubscribers;
            return value === null || value === undefined ? null : Number(value);
          },
        },
        {
          label: 'Exiting Subscribers',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'int',
          auto: (w) => {
            const value = subscriberWeeklyMap[w.weekStart]?.exitingSubscribers;
            return value === null || value === undefined ? null : Number(value);
          },
        },
        {
          label: 'Total Subscribers',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'int',
          auto: (w) => Number(subscriberWeeklyMap[w.weekStart]?.totalSubscribers),
        },
        {
          label: 'Average items Per order',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'int',
          auto: (w) => Number(weeklyKpiMap[w.weekStart]?.averageItemsPerOrder),
        },
        {
          label: 'Average Order Amount',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'currency',
          auto: (w) => Number(weeklyKpiMap[w.weekStart]?.averageOrderAmount),
        },
      ],
    },
    {
      section: 'REVENUE',
      rows: [
        {
          label: 'Sales compared to yearly average',
          entry: 'AUTO',
          source: formulaSource,
          valueType: 'percent',
          formulaOf: 'Retail Sales',
        },
        {
          label: 'Retail Sales',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'currency',
          auto: (w) => Number(weeklyKpiMap[w.weekStart]?.totalSales),
        },
      ],
    },
    {
      section: 'COGS',
      rows: [
        {
          label: 'Purchase Cost',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'currency',
          auto: (w) => Number(vendorWeeklyMap[w.weekStart]?.purchaseCost),
        },
        {
          label: '$ Product Credits Given',
          entry: 'MANUAL',
          source: 'Manual / TODO automation',
          valueType: 'currency',
          rowLabel: '$ Product Credits Given',
        },
        {
          label: 'Other FFCSA operating costs Ops',
          entry: 'MANUAL',
          source: 'Manual',
          valueType: 'currency',
          rowLabel: 'Other FFCSA operating costs Ops',
        },
        {
          label: 'Total COGS',
          entry: 'AUTO',
          source: formulaSource,
          valueType: 'currency',
          formulaSumOf: ['Purchase Cost', '$ Product Credits Given', 'Other FFCSA operating costs Ops'],
        },
        {
          label: '%  product markup',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'percent',
          auto: (w) => {
            const purchase = Number(vendorWeeklyMap[w.weekStart]?.purchaseCost || 0);
            const retail = Number(vendorWeeklyMap[w.weekStart]?.retailSales || 0);
            if (!purchase) return null;
            return ((retail - purchase) / purchase) * 100;
          },
        },
        {
          label: 'Available for Expenses',
          entry: 'AUTO',
          source: formulaSource,
          valueType: 'currency',
          formulaSubtractOf: ['Retail Sales', 'Total COGS'],
          highlight: 'available',
        },
      ],
    },
    {
      section: 'EXPENSES',
      rows: [
        {
          label: 'Wages',
          entry: 'AUTO',
          source: scriptSource,
          valueType: 'currency',
          auto: (w) => Number(timesheetWeeklyMap[w.weekStart]?.wages),
        },
      ],
    },
  ];

  const values = [];
  const metricRows = [];
  const sectionRows = [];
  const metricRowIndexByLabel = new Map();
  const formulaRows = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  values.push([`FFCSA Dashboard Auto 2026`, `Updated ${now}`, '', '', ...weeks.map((w) => w.label)]);
  values.push(['Section', 'Metric', 'Entry Type', 'Source', ...weeks.map((w) => w.label)]);

  for (const group of layout) {
    sectionRows.push(values.length);
    values.push([group.section, '', '', '', ...weeks.map(() => '')]);
    for (const row of group.rows) {
      const rowIndex = values.length;
      const rowValues = ['', row.label, row.entry, row.source];
      for (const week of weeks) {
        if (row.entry === 'AUTO' && (row.formulaOf || row.formulaSubtractOf || row.formulaSumOf)) {
          rowValues.push('');
        } else if (row.entry === 'AUTO') {
          const raw = row.auto ? row.auto(week) : null;
          rowValues.push(normalizeAutoValue(row.valueType, raw));
        } else {
          rowValues.push(getManualSourceValue(rowMap, row.rowLabel || row.label, week.col));
        }
      }
      metricRows.push({
        rowIndex,
        label: row.label,
        valueType: row.valueType || null,
        entry: row.entry,
        highlight: row.highlight || null,
      });
      metricRowIndexByLabel.set(row.label, rowIndex);
      if (row.formulaOf) {
        formulaRows.push({
          rowIndex,
          metricLabel: row.label,
          formulaOf: row.formulaOf,
        });
      } else if (row.formulaSubtractOf) {
        formulaRows.push({
          rowIndex,
          metricLabel: row.label,
          formulaSubtractOf: row.formulaSubtractOf,
        });
      } else if (row.formulaSumOf) {
        formulaRows.push({
          rowIndex,
          metricLabel: row.label,
          formulaSumOf: row.formulaSumOf,
        });
      }
      values.push(rowValues);
    }
  }

  if (weeks.length) {
    const firstWeekCol = toA1Column(5);
    const lastWeekCol = toA1Column(4 + weeks.length);

    for (const formulaRow of formulaRows) {
      if (formulaRow.formulaOf) {
        const baseRowIndex = metricRowIndexByLabel.get(formulaRow.formulaOf);
        if (baseRowIndex === undefined) continue;
        const baseRowNum = baseRowIndex + 1;
        const fullRange = `$${firstWeekCol}${baseRowNum}:$${lastWeekCol}${baseRowNum}`;
        for (let i = 0; i < weeks.length; i++) {
          const col = toA1Column(5 + i);
          const currentCell = `${col}${baseRowNum}`;
          const restAvg = `((SUM(${fullRange})-${currentCell})/(COUNT(${fullRange})-1))`;
          values[formulaRow.rowIndex][4 + i] =
            `=IFERROR((${currentCell}-${restAvg})/${restAvg},"")`;
        }
        continue;
      }

      if (formulaRow.formulaSubtractOf) {
        const [leftLabel, rightLabel] = formulaRow.formulaSubtractOf;
        const leftRowIndex = metricRowIndexByLabel.get(leftLabel);
        const rightRowIndex = metricRowIndexByLabel.get(rightLabel);
        if (leftRowIndex === undefined || rightRowIndex === undefined) continue;
        const leftRowNum = leftRowIndex + 1;
        const rightRowNum = rightRowIndex + 1;
        for (let i = 0; i < weeks.length; i++) {
          const col = toA1Column(5 + i);
          values[formulaRow.rowIndex][4 + i] =
            `=IFERROR(${col}${leftRowNum}-${col}${rightRowNum},"")`;
        }
        continue;
      }

      if (formulaRow.formulaSumOf) {
        const sumRowNums = formulaRow.formulaSumOf
          .map((label) => metricRowIndexByLabel.get(label))
          .filter((idx) => idx !== undefined)
          .map((idx) => idx + 1);
        if (!sumRowNums.length) continue;

        for (let i = 0; i < weeks.length; i++) {
          const col = toA1Column(5 + i);
          const expr = sumRowNums.map((rowNum) => `${col}${rowNum}`).join('+');
          values[formulaRow.rowIndex][4 + i] = `=IFERROR(${expr},"")`;
        }
      }
    }
  }

  return { values, metricRows, sectionRows };
}

async function getSheetsAccessToken() {
  // Prefer explicit service-account auth from localline/.env so env vars loaded
  // by dependent modules do not accidentally override Sheets write auth.
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
    'Google Sheets auth missing. Set GOOGLE_SERVICE_ACCOUNT_JSON OR GOOGLE_SHEETS_ACCESS_TOKEN OR GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN.'
  );
}

function hexColor(hex) {
  const clean = hex.replace('#', '');
  return {
    red: parseInt(clean.slice(0, 2), 16) / 255,
    green: parseInt(clean.slice(2, 4), 16) / 255,
    blue: parseInt(clean.slice(4, 6), 16) / 255,
  };
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
  if (sheet) return sheet.properties;

  const addReq = { requests: [{ addSheet: { properties: { title } } }] };
  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
  const addResp = await sheetsRequest(accessToken, 'post', batchUrl, addReq);
  return addResp.data?.replies?.[0]?.addSheet?.properties;
}

async function writeDashboardToSheet(accessToken, values, metricRows, sectionRows) {
  const sheetProperties = await getOrCreateSheet(accessToken, SHEET_ID, TARGET_SHEET_TITLE);
  const sheetId = sheetProperties.sheetId;
  const maxCols = values[0].length;
  const maxRows = values.length;
  const titleMergeEndCol = Math.min(4, maxCols);
  const gridRowCount = Math.max(sheetProperties.gridProperties?.rowCount || maxRows, maxRows);
  const gridColumnCount = Math.max(sheetProperties.gridProperties?.columnCount || maxCols, maxCols);

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

  const requests = [
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 2, frozenColumnCount: 4 },
        },
        fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
      },
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: maxRows,
          startColumnIndex: 0,
          endColumnIndex: maxCols,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { fontFamily: 'Arial', fontSize: 10 },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(textFormat.fontFamily,textFormat.fontSize,horizontalAlignment,verticalAlignment)',
      },
    },
  ];

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

  requests.push(
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: maxCols,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexColor('#1F4E78'),
            textFormat: { foregroundColor: hexColor('#FFFFFF'), bold: true, fontSize: 10 },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
      },
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: maxCols,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: hexColor('#2F75B5'),
            textFormat: { foregroundColor: hexColor('#FFFFFF'), bold: true },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    }
  );

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
    if (m.highlight === 'available') {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: m.rowIndex,
            endRowIndex: m.rowIndex + 1,
            startColumnIndex: 0,
            endColumnIndex: maxCols,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: hexColor('#FCE5CD'),
              textFormat: { bold: true },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });
    }

    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: m.rowIndex, endRowIndex: m.rowIndex + 1, startColumnIndex: 2, endColumnIndex: 3 },
        cell: {
          userEnteredFormat: {
            backgroundColor:
              m.highlight === 'available'
                ? hexColor('#FCE5CD')
                : m.entry === 'AUTO'
                ? hexColor('#D9EAD3')
                : hexColor('#FFFFFF'),
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
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });
  }

  requests.push(
    {
      updateBorders: {
        range: { sheetId, startRowIndex: 1, endRowIndex: maxRows, startColumnIndex: 0, endColumnIndex: maxCols },
        top: { style: 'SOLID', width: 1, color: hexColor('#B7B7B7') },
        bottom: { style: 'SOLID', width: 1, color: hexColor('#B7B7B7') },
        left: { style: 'SOLID', width: 1, color: hexColor('#B7B7B7') },
        right: { style: 'SOLID', width: 1, color: hexColor('#B7B7B7') },
        innerHorizontal: { style: 'SOLID', width: 1, color: hexColor('#E0E0E0') },
        innerVertical: { style: 'SOLID', width: 1, color: hexColor('#E0E0E0') },
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 120 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
        properties: { pixelSize: 320 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 },
        properties: { pixelSize: 110 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 },
        properties: { pixelSize: 250 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: maxCols },
        properties: { pixelSize: 95 },
        fields: 'pixelSize',
      },
    }
  );

  if (gridRowCount > maxRows) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: maxRows,
          endRowIndex: gridRowCount,
          startColumnIndex: 0,
          endColumnIndex: gridColumnCount,
        },
        cell: { userEnteredFormat: {} },
        fields: 'userEnteredFormat',
      },
    });
    requests.push({
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: maxRows,
          endRowIndex: gridRowCount,
          startColumnIndex: 0,
          endColumnIndex: gridColumnCount,
        },
        top: { style: 'NONE' },
        bottom: { style: 'NONE' },
        left: { style: 'NONE' },
        right: { style: 'NONE' },
        innerHorizontal: { style: 'NONE' },
        innerVertical: { style: 'NONE' },
      },
    });
  }

  if (gridColumnCount > maxCols) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: maxRows,
          startColumnIndex: maxCols,
          endColumnIndex: gridColumnCount,
        },
        cell: { userEnteredFormat: {} },
        fields: 'userEnteredFormat',
      },
    });
    requests.push({
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: maxRows,
          startColumnIndex: maxCols,
          endColumnIndex: gridColumnCount,
        },
        top: { style: 'NONE' },
        bottom: { style: 'NONE' },
        left: { style: 'NONE' },
        right: { style: 'NONE' },
        innerHorizontal: { style: 'NONE' },
        innerVertical: { style: 'NONE' },
      },
    });
  }

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

  const out = path.join(DATA_DIR, `dashboard_auto26_preview_${new Date().toISOString().slice(0, 10)}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, csv, 'utf8');
  return out;
}

async function publishDashboardAuto26() {
  const sourceRows = await fetchSourceSheetRows();
  const sourceRowMap = mapRowsByLabel(sourceRows);
  const weeks = extractWeeksFromSourceRows(sourceRows);

  if (!weeks.length) {
    throw new Error('No week columns found in source sheet.');
  }

  const weeklyKpiMap = getWeeklyKpiMap();
  let vendorWeeklyMap = await buildVendorWeeklyMap();
  if (BACKFILL_VENDOR_WEEKS) {
    const backfill = await backfillMissingVendorWeeklySummaries(weeks, vendorWeeklyMap);
    vendorWeeklyMap = await buildVendorWeeklyMap();
    console.log(
      `Info: vendor backfill ${backfill.message} (created ${backfill.created}, checked ${backfill.checked})`
    );
  }
  const { map: timesheetWeeklyMap, status: timesheetStatus } =
    await buildTimesheetWeeklyMap(weeks);
  const subscriberWeeklyMap = await buildSubscriberWeeklyMap(weeks);

  const { values, metricRows, sectionRows } = buildDashboardRows(
    weeks,
    sourceRowMap,
    weeklyKpiMap,
    vendorWeeklyMap,
    timesheetWeeklyMap,
    subscriberWeeklyMap
  );

  console.log(`ℹ️ Timesheets status: ${timesheetStatus}`);
  console.log(`ℹ️ Target sheet: ${TARGET_SHEET_TITLE}`);
  console.log(`ℹ️ Weeks: ${weeks[0].label} ... ${weeks[weeks.length - 1].label}`);

  if (DASHBOARD_DRY_RUN) {
    const preview = writePreviewCsv(values);
    console.log(`✅ Dashboard dry run complete. Preview CSV: ${preview}`);
    return;
  }

  const accessToken = await getSheetsAccessToken();
  await writeDashboardToSheet(accessToken, values, metricRows, sectionRows);
  console.log(`✅ Wrote dashboard to Google Sheet tab "${TARGET_SHEET_TITLE}"`);
}

async function generateWeeklyPdf() {
  if (!fs.existsSync(SHEET_CSV_PATH)) {
    throw new Error(`Sheet CSV not found: ${SHEET_CSV_PATH}`);
  }
  if (!fs.existsSync(WEEKLY_KPI_PATH)) {
    throw new Error(`weekly_kpi.json not found: ${WEEKLY_KPI_PATH}`);
  }

  const rows = await readCsvRows(SHEET_CSV_PATH);
  const header = rows[0] || [];
  const rowByLabel = {};
  const sheetRowsInOrder = [];
  for (const row of rows) {
    const label = String(row[0] || '').trim();
    if (label) {
      rowByLabel[label] = row;
      sheetRowsInOrder.push({ label, row });
    }
  }

  const weeklyKpiMap = getWeeklyKpiMap();
  const vendorWeeklyMap = await buildVendorWeeklyMap();

  const metrics = [
    {
      label: 'Num Orders',
      rowLabel: 'Num Orders',
      type: 'int',
      scriptValue: (d) => (d ? Number(d.numOrders) : null),
    },
    {
      label: 'Num Subscriber Orders',
      rowLabel: 'Num Subscriber Orders',
      type: 'int',
      scriptValue: (d) => (d ? Number(d.numSubscriberOrders) : null),
    },
    {
      label: 'Num Guest Orders',
      rowLabel: 'Num Guest Orders',
      type: 'int',
      scriptValue: (d) => (d ? Number(d.numGuestOrders) : null),
    },
    {
      label: 'New Subscribers',
      rowLabel: 'New Subscribers',
      type: 'int',
      scriptValue: (_d, _start, _vendorInfo, _timesheetInfo, subscriberInfo) => {
        const value = subscriberInfo?.newSubscribers;
        return value === null || value === undefined ? null : Number(value);
      },
    },
    {
      label: 'Exiting Subscribers',
      rowLabel: 'Exiting Subscribers',
      type: 'int',
      scriptValue: (_d, _start, _vendorInfo, _timesheetInfo, subscriberInfo) => {
        const value = subscriberInfo?.exitingSubscribers;
        return value === null || value === undefined ? null : Number(value);
      },
    },
    {
      label: 'Total Subscribers',
      rowLabel: 'Total Subscribers',
      type: 'int',
      scriptValue: (_d, _start, _vendorInfo, _timesheetInfo, subscriberInfo) =>
        subscriberInfo ? Number(subscriberInfo.totalSubscribers) : null,
    },
    {
      label: 'Average Items / Order',
      rowLabel: 'Average items Per order',
      type: 'int',
      scriptValue: (d) => (d ? Number(d.averageItemsPerOrder) : null),
    },
    {
      label: 'Average Order Amount',
      rowLabel: 'Average Order Amount',
      type: 'currency',
      scriptValue: (d) => (d ? Number(d.averageOrderAmount) : null),
    },
    {
      label: 'Retail Sales',
      rowLabel: 'Retail Sales',
      type: 'currency',
      scriptValue: (d) => (d ? Number(d.totalSales) : null),
    },
    {
      label: 'Purchase Cost',
      rowLabel: 'PURCHASE COST',
      type: 'currency',
      scriptValue: (_d, _start, vendorInfo) =>
        vendorInfo ? Number(vendorInfo.purchaseCost) : null,
    },
    {
      label: '% Product Markup',
      rowLabel: '%  product markup',
      type: 'percent',
      scriptValue: (_d, _start, vendorInfo) => {
        if (!vendorInfo) return null;
        const purchase = Number(vendorInfo.purchaseCost || 0);
        const retail = Number(vendorInfo.retailSales || 0);
        if (!purchase) return null;
        return ((retail - purchase) / purchase) * 100;
      },
    },
    {
      label: 'Wages (FFCSA)',
      rowLabel: 'Wages',
      type: 'currency',
      scriptValue: (_d, _start, _vendorInfo, timesheetInfo) =>
        timesheetInfo ? Number(timesheetInfo.wages) : null,
    },
    {
      label: 'Skipped Subscriptions',
      rowLabel: '# of skipped subscriptions',
      type: 'int',
      scriptValue: (d) => (d ? Number(d.skippedSubscribers) : null),
    },
    {
      label: 'Feed-a-Friend Subscribers',
      rowLabel: '# of subscribers Feed a Friend',
      type: 'int',
      scriptValue: (d) => (d ? Number(d.feedAFriendSubscribers) : null),
    },
    {
      label: '% Active Subscribers Ordering',
      rowLabel: '% of active subscribers that made an order',
      type: 'percent',
      scriptValue: (d, _start, _vendorInfo, _timesheetInfo, subscriberInfo) => {
        if (!d) return null;
        const active = Number(
          subscriberInfo?.totalSubscribers ?? d.totalActiveSubscribers
        );
        const subOrders = Number(d.numSubscriberOrders);
        if (!active) return null;
        return (subOrders / active) * 100;
      },
    },
  ];

  const weeks = [];
  for (let col = 1; col < header.length; col++) {
    const weekStart = toYMDFromSheetWeekLabel(header[col]);
    if (!weekStart) continue;
    weeks.push({
      weekStart,
      weekEnd: addDaysYMD(weekStart, 6),
      col,
    });
  }
  const {
    map: timesheetWeeklyMap,
    status: timesheetStatus,
  } = await buildTimesheetWeeklyMap(weeks);
  const subscriberWeeklyMap = await buildSubscriberWeeklyMap(weeks);

  fs.mkdirSync(path.dirname(OUTPUT_PDF_PATH), { recursive: true });
  const doc = new PDFDocument({ margin: 28, size: 'LETTER' });
  const out = fs.createWriteStream(OUTPUT_PDF_PATH);
  doc.pipe(out);

  doc.fontSize(18).text('FFCSA Weekly Report Auto-Fill Preview', { align: 'left' });
  doc.fontSize(11).text(`Generated: ${new Date().toISOString()}`, { align: 'left' });
  doc.text(`Sheet CSV: ${SHEET_CSV_PATH}`, { align: 'left' });
  doc.text(`Weekly KPI source: ${WEEKLY_KPI_PATH}`, { align: 'left' });
  doc.text(`Timesheets DB (FFCSA wages): ${timesheetStatus}`, { align: 'left' });
  doc.moveDown(0.5);
  doc.text('View: Sheet value vs script value vs delta (script - sheet).');
  doc.text('N/A indicates the script source for that metric/week is not present yet.');
  doc.moveDown(1);

  const coverageRows = metrics.map((metric) => {
    let available = 0;
    for (const week of weeks) {
      const kpi = weeklyKpiMap[week.weekStart];
      const vendorInfo = vendorWeeklyMap[week.weekStart];
      const timesheetInfo = timesheetWeeklyMap[week.weekStart];
      const subscriberInfo = subscriberWeeklyMap[week.weekStart];
      const val = metric.scriptValue(
        kpi,
        week.weekStart,
        vendorInfo,
        timesheetInfo,
        subscriberInfo
      );
      if (val !== null && val !== undefined && !Number.isNaN(val)) available++;
    }
    return [metric.label, `${available}/${weeks.length}`];
  });

  doc.table(
    {
      headers: ['Metric', 'Script Coverage'],
      rows: coverageRows,
    },
    { width: 540 }
  );

  for (let i = 0; i < weeks.length; i++) {
    const week = weeks[i];
    const kpi = weeklyKpiMap[week.weekStart];
    const vendorInfo = vendorWeeklyMap[week.weekStart];
    const timesheetInfo = timesheetWeeklyMap[week.weekStart];
    const subscriberInfo = subscriberWeeklyMap[week.weekStart];

    doc.addPage();
    doc.fontSize(16).text(`Week Beginning ${week.weekStart}`, { align: 'left' });
    doc.fontSize(11).text(`Range: ${week.weekStart} to ${week.weekEnd}`);
    doc.text(
      `weekly_kpi: ${kpi ? 'present' : 'missing'} | ` +
      `vendor_weekly_summary: ${vendorInfo ? 'present' : 'missing'} | ` +
      `timesheets_wages: ${timesheetInfo ? 'present' : 'missing'}`
    );
    doc.moveDown(0.5);

    const metricRows = metrics.map((metric) => {
      const sheetRow = rowByLabel[metric.rowLabel] || [];
      const sheetRaw = sheetRow[week.col] || '';
      const sheetNum = parseNumeric(sheetRaw, metric.type);

      const scriptNum = metric.scriptValue(
        kpi,
        week.weekStart,
        vendorInfo,
        timesheetInfo,
        subscriberInfo
      );
      const delta =
        sheetNum !== null &&
        sheetNum !== undefined &&
        scriptNum !== null &&
        scriptNum !== undefined
          ? scriptNum - sheetNum
          : null;

      return [
        metric.label,
        sheetRaw || 'N/A',
        formatValue(scriptNum, metric.type),
        formatDelta(delta, metric.type),
      ];
    });

    doc.table(
      {
        headers: ['Metric', 'Sheet', 'Script', 'Delta'],
        rows: metricRows,
      },
      { width: 540 }
    );

    const sectionLabelsToSkip = new Set([
      'Week beginning',
      'GIVENS',
      'REVENUES',
      'COGS',
      'LABOR HOURS',
      'OTHER DATA',
    ]);
    const metricByRowLabel = new Map(metrics.map((m) => [m.rowLabel, m]));
    const fullSheetRows = [];

    for (const item of sheetRowsInOrder) {
      if (sectionLabelsToSkip.has(item.label)) continue;

      const sheetRaw = String(item.row[week.col] || '').trim();
      const metric = metricByRowLabel.get(item.label);

      let scriptValue = null;
      let delta = null;
      if (metric) {
        scriptValue = metric.scriptValue(
          kpi,
          week.weekStart,
          vendorInfo,
          timesheetInfo
        );
        const sheetNum = parseNumeric(sheetRaw, metric.type);
        if (
          sheetNum !== null &&
          sheetNum !== undefined &&
          scriptValue !== null &&
          scriptValue !== undefined
        ) {
          delta = scriptValue - sheetNum;
        }
      }

      if (!sheetRaw && !metric) continue;

      fullSheetRows.push([
        item.label,
        sheetRaw || 'N/A',
        metric ? formatValue(scriptValue, metric.type) : 'N/A',
        metric ? formatDelta(delta, metric.type) : 'N/A',
      ]);
    }

    doc.moveDown(0.3);
    doc.fontSize(12).text('All Sheet Rows (same week)', { align: 'left' });
    doc.table(
      {
        headers: ['Row', 'Sheet', 'Script Candidate', 'Delta'],
        rows: fullSheetRows,
      },
      { width: 540 }
    );
  }

  doc.end();
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });

  console.log(`✅ Wrote weekly report PDF: ${OUTPUT_PDF_PATH}`);
}

async function main() {
  if (!NO_PDF) {
    await generateWeeklyPdf();
  }

  if (PUBLISH_DASHBOARD) {
    await publishDashboardAuto26();
  }

  if (NO_PDF && !PUBLISH_DASHBOARD) {
    console.log('ℹ️ Nothing to do. Use default mode for PDF or --publish-dashboard for Sheets publish.');
  }
}

main().catch((err) => {
  console.error('❌ Failed in weekly_report.js:', err.message || err);
  if (err.response?.status) {
    console.error(`❌ HTTP ${err.response.status}:`, JSON.stringify(err.response.data));
  }
  process.exit(1);
});
