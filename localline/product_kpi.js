// product_kpi2.js
// Usage:
//   node product_kpi2.js 2025-01-01 2025-08-31 805461,805474,990712
//
// Output:
//   data/product_kpi_2025-01-01_to_2025-08-31.csv
//
require('dotenv').config();
const fs = require('fs');
const fastcsv = require('fast-csv');
const path = require('path');
const utilities = require('./utilities');

const DEBUG = process.argv.includes('--debug') || process.env.DEBUG === '1';
const dbg = (...args) => { if (DEBUG) console.log('[DBG]', ...args); };

function parseArgs() {
  if (process.argv.length < 5) {
    console.error('Usage: node product_kpi2.js <begin YYYY-MM-DD> <end YYYY-MM-DD> <pid1,pid2,...>');
    process.exit(1);
  }
  const begin = process.argv[2];
  const end = process.argv[3];
  const pids = [...new Set(process.argv[4].split(',').map(s => s.trim()).filter(Boolean).map(String))];
  return { begin, end, productIds: pids };
}

function toYMD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function startOfMondayWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dow = (d.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}
function endOfSundayWeek(mondayUtc) {
  const d = new Date(mondayUtc);
  d.setUTCDate(d.getUTCDate() + 6);
  return d;
}
function nextMonday(mondayUtc) {
  const d = new Date(mondayUtc);
  d.setUTCDate(d.getUTCDate() + 7);
  return d;
}
function parseLooseDateString(s) {
  const d1 = new Date(s);
  if (!isNaN(d1)) return d1;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const m2 = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m2) return new Date(Number(m2[3]), Number(m2[1]) - 1, Number(m2[2]));
  return new Date(NaN);
}

function getFulfillmentDate(row) {
  const candidates = [
    'Fulfillment Date','Delivery Date','Pickup Date','Delivery/Pickup Date','Order Fulfillment Date','Date',
  ];
  for (const k of candidates) {
    if (k in row && row[k]) {
      const d = parseLooseDateString(row[k]);
      if (!isNaN(d)) return d;
    }
  }
  for (const key of Object.keys(row)) {
    const lk = key.toLowerCase();
    if (lk.includes('fulfillment') && lk.includes('date')) {
      const d = parseLooseDateString(row[key]);
      if (!isNaN(d)) return d;
    }
  }
  return null;
}
function getProductId(row) {
  const candidates = [
    'Product ID','Product Id','ProductId',
    'Item ID','Item Id','ItemID',
    'Variant ID','Product Variant ID'
  ];
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
  // MONEY: sum "Product Subtotal" (robust fallback)
  const candidates = ['Product Subtotal','Line Subtotal','Subtotal','Line Item Total','Amount'];
  for (const k of candidates) {
    const raw = String(row[k] ?? '').replace(/[^0-9.\-]/g, '');
    const v = parseFloat(raw);
    if (!Number.isNaN(v)) return v;
  }
  return 0;
}
function getLineQuantity(row) {
  // QUANTITY: common header fallbacks
  const candidates = ['Quantity','Qty','Item Quantity','# of Items','Quantity Ordered','Product Quantity'];
  for (const k of candidates) {
    const raw = String(row[k] ?? '').replace(/[^0-9.\-]/g, '');
    const v = parseFloat(raw);
    if (!Number.isNaN(v)) return v;
  }
  // If no quantity column, count 1 when subtotal is non-zero
  const amt = getLineSubtotal(row);
  return amt !== 0 ? 1 : 0;
}

// Fetch one orders CSV for the whole range
async function fetchOrdersCSV(begin, end) {
  const tokenStr = await utilities.getAccessToken();
  const accessToken = JSON.parse(tokenStr).access;

  const url =
    'https://localline.ca/api/backoffice/v2/orders/export/?' +
    'file_type=orders_list_view&send_to_email=false&direct=true&' +
    `fulfillment_date_start=${begin}&` +
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
  return outPath;
}

// Parse → weekly (Mon–Sun) amounts & quantities; also collect product names
async function computeWeekly(csvPath, beginStr, endStr, productIds) {
  const begin = parseLooseDateString(beginStr);
  const end = parseLooseDateString(endStr);
  if (isNaN(begin) || isNaN(end)) throw new Error('Invalid begin/end date.');

  const beginMon = startOfMondayWeek(begin);
  const endMon = startOfMondayWeek(end);
  const lastSun = endOfSundayWeek(endMon);

  // Build all week keys
  const weekKeys = [];
  for (let cur = new Date(beginMon); cur <= lastSun; cur = nextMonday(cur)) {
    const mon = new Date(cur);
    const sun = endOfSundayWeek(mon);
    weekKeys.push(`${toYMD(mon)} to ${toYMD(sun)}`);
  }

  // Initialize
  const zeroA = Object.fromEntries(productIds.map(pid => [pid, 0]));
  const zeroQ = Object.fromEntries(productIds.map(pid => [pid, 0]));
  const byWeekA = new Map(weekKeys.map(k => [k, { ...zeroA }]));
  const byWeekQ = new Map(weekKeys.map(k => [k, { ...zeroQ }]));
  const names = new Map(); // pid -> first-seen product name

  let rowCount = 0;
  await new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => {
        rowCount++;
        const d = getFulfillmentDate(row);
        if (!d || d < begin || d > end) return;

        const pid = getProductId(row);
        if (!pid || !productIds.includes(pid)) return;

        const monday = startOfMondayWeek(d);
        const k = `${toYMD(monday)} to ${toYMD(endOfSundayWeek(monday))}`;
        if (!byWeekA.has(k)) return;

        const amt = getLineSubtotal(row);
        const qty = getLineQuantity(row);

        const recA = byWeekA.get(k);
        const recQ = byWeekQ.get(k);
        recA[pid] = (recA[pid] || 0) + amt;
        recQ[pid] = (recQ[pid] || 0) + qty;

        const nm = getProductName(row);
        if (nm && !names.has(pid)) names.set(pid, nm);
      })
      .on('end', resolve)
      .on('error', reject);
  });
  dbg('Parsed rows:', rowCount);

  return { weekKeys, byWeekA, byWeekQ, names };
}

// csvEsc without regex literals (pastes cleanly)
function csvEsc(v) {
  var s = v == null ? "" : String(v);
  var needsQuotes =
    s.indexOf('"') !== -1 ||
    s.indexOf(",") !== -1 ||
    s.indexOf("\n") !== -1 ||
    s.indexOf("\r") !== -1;
  if (needsQuotes) {
    s = s.split('"').join('""');
    return '"' + s + '"';
  }
  return s;
}

function writeCSV(headers, rows, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const head = headers.map(csvEsc).join(',');
  const body = rows.map(r => r.map(csvEsc).join(',')).join('\n');
  fs.writeFileSync(outPath, head + '\n' + body + '\n');
}

(async function main() {
  try {
    const { begin, end, productIds } = parseArgs();
    dbg('Begin:', begin, '| End:', end, '| Product IDs:', productIds);

    const csvPath = await fetchOrdersCSV(begin, end);
    const { weekKeys, byWeekA, byWeekQ, names } = await computeWeekly(csvPath, begin, end, productIds);

    // Build headers: for each product → Amount + Qty columns
    const label = (pid) => {
      const nm = names.get(pid);
      return nm ? (nm + " (" + pid + ")") : "(" + pid + ")";
    };
    const amountHeaders = productIds.map(pid => label(pid) + " Amount");
    const qtyHeaders = productIds.map(pid => label(pid) + " Qty");
    const headers = ['Week', ...amountHeaders, 'Total Amount', ...qtyHeaders, 'Total Qty'];

    // Build rows
    const rows = weekKeys.map(k => {
      const recA = byWeekA.get(k) || {};
      const recQ = byWeekQ.get(k) || {};

      const amounts = productIds.map(pid => (recA[pid] || 0));
      const qtys    = productIds.map(pid => (recQ[pid] || 0));

      const totA = amounts.reduce((a,b)=>a+b,0);
      const totQ = qtys.reduce((a,b)=>a+b,0);

      // Format: amounts 2 decimals; quantities show integer or 3 decimals
      const fmtAmt = (n) => n.toFixed(2);
      const fmtQty = (n) => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(3));

      return [
        k,
        ...amounts.map(fmtAmt),
        fmtAmt(totA),
        ...qtys.map(fmtQty),
        fmtQty(totQ)
      ];
    });

    const outFile = path.join('data', `product_kpi_${begin}_to_${end}.csv`);
    writeCSV(headers, rows, outFile);
    console.log('Wrote: ' + outFile);
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  }
})();

