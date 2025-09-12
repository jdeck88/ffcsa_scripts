// kpi_product_totals.js (products export + XLSX pricelist fallback + debug)
require('dotenv').config();
const fs = require('fs');
const fastcsv = require('fast-csv');
const XLSX = require('xlsx');
const utilities = require('./utilities');

// ---- Debug helpers ----
const DEBUG = process.argv.includes('--debug') || process.env.DEBUG === '1';
const SHOW_TOKEN = process.argv.includes('--show-token') || process.env.SHOW_TOKEN === '1';
const dbg = (...args) => { if (DEBUG) console.log('[DBG]', ...args); };
const mask = (s) => !s ? s : (s.length <= 12 ? s : `${s.slice(0,6)}...${s.slice(-6)}`);

// ---- CONFIG / CLI ----
function parseArgs() {
  const dateArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
  const pidArg = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : (process.env.PRODUCT_IDS || '805461,805474,990712');
  const productIds = pidArg.split(',').map(s => s.trim()).filter(Boolean).map(String);
  return { dateArg, productIds };
}

// CSV helpers
function getProductId(row) {
  const candidates = ['Product ID','Product Id','ProductId','Item ID','Item Id','ItemID','Variant ID','Product Variant ID'];
  for (const k of candidates) {
    const v = row[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}
function getProductName(row) {
  const candidates = ['Product','Product Name','Item','Item Name'];
  for (const k of candidates) {
    const v = row[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}
function getLineSubtotal(row) {
  const candidates = ['Product Subtotal','Line Subtotal','Subtotal','Line Item Total','Amount'];
  for (const k of candidates) {
    const raw = String(row[k] ?? '').replace(/[^0-9.\-]/g, '');
    const v = parseFloat(raw);
    if (!Number.isNaN(v)) return v;
  }
  return 0;
}

// ---- Fetch orders CSV for the week ----
async function fetchOrdersCSVPath(start, end) {
  const tokenStr = await utilities.getAccessToken();
  const accessToken = JSON.parse(tokenStr).access;
  dbg('ACCESS_TOKEN:', SHOW_TOKEN ? accessToken : mask(accessToken));

  const url =
    'https://localline.ca/api/backoffice/v2/orders/export/?' +
    'file_type=orders_list_view&send_to_email=false&direct=true&' +
    `fulfillment_date_start=${start}&` +
    `fulfillment_date_end=${end}&` +
    'payment__status=PAID&price_lists=2966%2C2718%2C3124&status=OPEN';
  dbg('Orders export URL:', url);

  const reqIdStr = await utilities.getRequestID(url, accessToken);
  const id = JSON.parse(reqIdStr).id;
  dbg('Orders export ID:', id);

  const resultsUrl = await utilities.pollStatus(id, accessToken);
  dbg('Orders result URL:', resultsUrl);

  const outPath = await utilities.downloadData(resultsUrl, `tmp_orders_${end}.csv`);
  dbg('Orders CSV path:', outPath);

  return { outPath, accessToken };
}

// ---- Preferred: Products export → name map ----
async function fetchProductNameMapFromExport(accessToken) {
  try {
    const PRODUCT_EXPORT_URL =
      'https://localline.ca/api/backoffice/v2/products/export/?file_type=products&send_to_email=false&direct=true';
    dbg('Products export URL:', PRODUCT_EXPORT_URL);

    const reqStr = await utilities.getRequestID(PRODUCT_EXPORT_URL, accessToken);
    const expId = JSON.parse(reqStr).id;
    dbg('Products export ID:', expId);

    const resultUrl = await utilities.pollStatus(expId, accessToken);
    dbg('Products result URL:', resultUrl);

    const csvPath = await utilities.downloadData(resultUrl, 'tmp_products.csv');
    dbg('Products CSV path:', csvPath);

    return await new Promise((resolve, reject) => {
      const map = new Map();
      fs.createReadStream(csvPath)
        .pipe(fastcsv.parse({ headers: true }))
        .on('data', (row) => {
          const pid = getProductId(row);
          const name = getProductName(row);
          if (pid && name) map.set(pid, name);
        })
        .on('end', () => { dbg('Products export mapped IDs:', map.size); resolve(map); })
        .on('error', reject);
    });
  } catch (e) {
    console.warn('⚠️ Products export not available; will try price list XLSX fallback.', e.message || e);
    return new Map();
  }
}

// ---- Fallback: parse XLSX price list exports → name map ----
async function fetchProductNameMapFromPriceLists(accessToken) {
  const priceListIds = [2966, 3124, 2718]; // herdshare, guest, members
  const map = new Map();

  // helper: detect column index by header names (case-insensitive)
  const idxOf = (headers, candidates) => {
    const lower = headers.map(h => String(h || '').trim().toLowerCase());
    for (const c of candidates) {
      const i = lower.indexOf(c.toLowerCase());
      if (i !== -1) return i;
    }
    return -1;
  };

  for (const id of priceListIds) {
    try {
      const url = `https://localline.ca/api/backoffice/v2/price-lists/${id}/products/export/?direct=true`;
      dbg('Price list export URL:', url);

      const xlsxPath = await utilities.downloadBinaryData(url, `tmp_pricelist_${id}.xlsx`, accessToken);
      dbg(`Price list XLSX path (${id}):`, xlsxPath);

      const wb = XLSX.readFile(xlsxPath);
      const sheet = wb.Sheets['Products'] || wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      if (!rows || !rows.length) continue;

      const headers = rows[0];
      const idIdx = idxOf(headers, ['Product ID','Product Id','ProductId','Item ID','Item Id','ItemID','Variant ID','Product Variant ID']);
      const nameIdx = idxOf(headers, ['Product','Product Name','Item','Item Name']);

      if (idIdx === -1 || nameIdx === -1) {
        dbg(`Headers not found in price list ${id}:`, headers);
        continue;
      }

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const pid = row[idIdx] != null ? String(row[idIdx]).trim() : '';
        const name = row[nameIdx] != null ? String(row[nameIdx]).trim() : '';
        if (pid && name && !map.has(pid)) {
          map.set(pid, name);
        }
      }
      dbg(`Mapped IDs from price list ${id}:`, map.size);
    } catch (e) {
      console.warn(`⚠️ Failed to parse price list ${id}:`, e.message || e);
    }
  }

  return map;
}

// ---- Compute totals for desired product IDs ----
async function computeProductTotals(csvPath, desiredIds, fallbackNameMap = new Map()) {
  return new Promise((resolve, reject) => {
    const totals = new Map();            // pid -> sum
    const namesSeenInOrders = new Map(); // pid -> name
    desiredIds.forEach(pid => totals.set(pid, 0));

    fs.createReadStream(csvPath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => {
        const pid = getProductId(row);
        if (!pid || !totals.has(pid)) return;

        const amt = getLineSubtotal(row);
        totals.set(pid, (totals.get(pid) || 0) + amt);

        const nm = getProductName(row);
        if (nm) namesSeenInOrders.set(pid, nm);
      })
      .on('end', () => {
        const nameFor = (pid) => fallbackNameMap.get(pid) || namesSeenInOrders.get(pid) || '';
        resolve({ totals, nameFor });
      })
      .on('error', reject);
  });
}

// ---- Main ----
(async function main() {
  try {
    const { dateArg, productIds } = parseArgs();
    const anchor = dateArg || utilities.getToday();
    const { start, end } = utilities.getPreviousWeek(anchor);
    dbg('Anchor date:', anchor, '| Week:', start, 'to', end);
    dbg('Product IDs:', productIds);

    const { outPath: ordersCSV, accessToken } = await fetchOrdersCSVPath(start, end);

    // Build product name map: prefer global Products export → fallback to price lists XLSX
    const exportNameMap = await fetchProductNameMapFromExport(accessToken);
    const priceListNameMap = exportNameMap.size ? exportNameMap : await fetchProductNameMapFromPriceLists(accessToken);
    if (!exportNameMap.size && priceListNameMap.size) dbg('Using price list XLSX for names:', priceListNameMap.size, 'entries');

    const { totals, nameFor } = await computeProductTotals(ordersCSV, productIds.map(String), priceListNameMap);

    console.log(`Weekly product totals for ${start} to ${end}`);
    for (const pid of productIds.map(String)) {
      const sum = totals.get(pid) || 0;
      const nm = nameFor(pid);
      console.log(`- ${pid}${nm ? ` (${nm})` : ''}: $${sum.toFixed(2)}`);
    }

    if (DEBUG) {
      const dump = {};
      for (const pid of productIds.map(String)) dump[pid] = { name: nameFor(pid) || '', total: Number((totals.get(pid) || 0).toFixed(2)) };
      console.log('[DBG] Summary:', JSON.stringify(dump, null, 2));
    }
  } catch (err) {
    console.error('Error computing product totals:', err);
    process.exit(1);
  }
})();
