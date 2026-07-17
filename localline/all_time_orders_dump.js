#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const fastcsv = require('fast-csv');

const SCRIPT_DIR = __dirname;
process.chdir(SCRIPT_DIR);
require('dotenv').config({ path: path.join(SCRIPT_DIR, '.env') });

const utilities = require('./utilities');

const DEFAULT_START_DATE = process.env.LL_ALL_TIME_START || '2000-01-01';
const DEFAULT_DELAY_MS = Number(process.env.LL_ALL_TIME_DELAY_MS || 10000);
const DEFAULT_MAX_POLL_MS = Number(process.env.LL_ALL_TIME_MAX_POLL_MS || 300000);
const DEFAULT_RETRIES = Number(process.env.LL_ALL_TIME_RETRIES || 3);
const OUTPUT_HEADERS = [
  'orderId',
  'orderDate',
  'orderPlacedTime',
  'orderPlacedAt',
  'fulfillmentDate',
  'customerName',
  'firstName',
  'lastName',
  'email',
  'phone',
  'destinationType',
  'fulfillmentTypeRaw',
  'fulfillmentName',
  'destinationName',
  'destinationAddress',
  'destinationStreet',
  'destinationCity',
  'destinationState',
  'destinationZip',
  'destinationCountry',
  'vendor',
  'category',
  'productId',
  'internalProductId',
  'packageId',
  'productName',
  'packageName',
  'itemUnit',
  'quantity',
  'rawQuantity',
  'rawItemCount',
  'unitPrice',
  'lineTotal',
  'productSalesTax',
  'orderTotal',
  'paymentStatus',
  'paymentCompletedDate',
  'paymentMethod',
  'orderStatus',
  'fulfillmentStatus',
  'sourceFile',
];

function usage() {
  console.log([
    'Usage:',
    '  node all_time_orders_dump.js [start YYYY-MM-DD] [end YYYY-MM-DD] [--use-cache] [--delay-ms N]',
    '',
    'Defaults:',
    `  start: ${DEFAULT_START_DATE} (or LL_ALL_TIME_START)`,
    '  end: today',
    '',
    'Output:',
    '  data/all_time_orders_<start>_to_<end>.csv',
    '',
    'Notes:',
    '  Exports LocalLine orders by order date, one month at a time.',
    '  Membership rows are skipped; subscription metadata is not exported.',
    `  Delay between uncached monthly export jobs defaults to ${DEFAULT_DELAY_MS} ms.`,
  ].join('\n'));
}

function parseArgs(argv) {
  const positional = [];
  const flags = {
    useCache: false,
    delayMs: DEFAULT_DELAY_MS,
    maxPollMs: DEFAULT_MAX_POLL_MS,
    retries: DEFAULT_RETRIES,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--use-cache') {
      flags.useCache = true;
      continue;
    }
    if (arg === '--delay-ms') {
      flags.delayMs = parsePositiveInteger(argv[++i], '--delay-ms');
      continue;
    }
    if (arg === '--max-poll-ms') {
      flags.maxPollMs = parsePositiveInteger(argv[++i], '--max-poll-ms');
      continue;
    }
    if (arg === '--retries') {
      flags.retries = parsePositiveInteger(argv[++i], '--retries');
      continue;
    }
    positional.push(arg);
  }

  if (positional.length > 2) {
    usage();
    process.exit(1);
  }

  const start = positional[0] || DEFAULT_START_DATE;
  const end = positional[1] || todayYMD();

  assertYMD(start, 'start');
  assertYMD(end, 'end');

  if (parseYMD(start) > parseYMD(end)) {
    throw new Error(`start date must be before end date: ${start} > ${end}`);
  }

  return { start, end, ...flags };
}

function parsePositiveInteger(value, flagName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flagName} must be a non-negative integer; received ${value}`);
  }
  return parsed;
}

function assertYMD(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parseYMD(value).getTime())) {
    throw new Error(`${label} must be YYYY-MM-DD; received ${value}`);
  }
}

function parseYMD(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function todayYMD() {
  return formatYMD(new Date());
}

function formatYMD(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function monthWindows(startYMD, endYMD) {
  const windows = [];
  const finalEnd = parseYMD(endYMD);
  let currentStart = parseYMD(startYMD);

  while (currentStart <= finalEnd) {
    const currentEnd = endOfMonth(currentStart);
    const clippedEnd = currentEnd < finalEnd ? currentEnd : finalEnd;
    windows.push({
      start: formatYMD(currentStart),
      end: formatYMD(clippedEnd),
    });
    currentStart = addDays(clippedEnd, 1);
  }

  return windows;
}

async function getAccessToken() {
  const tokenRaw = await utilities.getAccessToken();
  const payload = typeof tokenRaw === 'string' ? JSON.parse(tokenRaw) : tokenRaw;
  if (!payload || !payload.access) {
    throw new Error(`LocalLine token response did not include access: ${JSON.stringify(payload)}`);
  }
  return payload.access;
}

async function exportOrdersWindow(accessToken, window, useCache, options = {}) {
  const fileName = `all_time_orders_raw_${window.start}_to_${window.end}.csv`;
  const outPath = path.join('data', fileName);

  if (useCache && fs.existsSync(outPath)) {
    console.log(`Using cached raw export: ${outPath}`);
    return outPath;
  }

  const params = new URLSearchParams({
    file_type: 'orders_list_view',
    send_to_email: 'false',
    direct: 'true',
    start_date: window.start,
    end_date: window.end,
  });
  const url = `https://localline.ca/api/backoffice/v2/orders/export/?${params.toString()}`;

  console.log(`Requesting LocalLine orders export ${window.start} to ${window.end}`);
  const requestRaw = await utilities.getRequestID(url, accessToken);
  const requestPayload = typeof requestRaw === 'string' ? JSON.parse(requestRaw) : requestRaw;
  if (!requestPayload || !requestPayload.id) {
    throw new Error(`LocalLine export response did not include id: ${JSON.stringify(requestPayload)}`);
  }

  console.log(`LocalLine export id ${requestPayload.id}`);
  const resultUrl = await pollExportStatus(requestPayload.id, accessToken, {
    maxPollMs: options.maxPollMs,
  });
  if (!resultUrl) {
    throw new Error(`LocalLine export ${requestPayload.id} completed without a file URL`);
  }

  return utilities.downloadData(resultUrl, fileName);
}

async function exportOrdersWindowWithRetry(accessToken, window, args) {
  let lastError = null;

  for (let attempt = 1; attempt <= args.retries; attempt++) {
    try {
      return await exportOrdersWindow(accessToken, window, args.useCache, {
        maxPollMs: args.maxPollMs,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= args.retries) break;

      const retryDelay = Math.max(args.delayMs, 30000);
      console.warn(
        `Export ${window.start} to ${window.end} failed on attempt ${attempt}/${args.retries}: ${error.message}`
      );
      console.warn(`Waiting ${retryDelay} ms before retrying that month`);
      await sleep(retryDelay);
    }
  }

  throw lastError;
}

async function pollExportStatus(id, accessToken, options = {}) {
  const pollIntervalMs = options.pollIntervalMs || 10000;
  const maxPollMs = options.maxPollMs || DEFAULT_MAX_POLL_MS;
  const startedAt = Date.now();
  let missingStatusCount = 0;

  while (Date.now() - startedAt < maxPollMs) {
    const raw = await utilities.checkRequestId(id, accessToken);
    let payload;
    try {
      payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      missingStatusCount++;
      console.warn(`Export ${id} returned non-JSON status response; waiting`);
      await sleep(pollIntervalMs);
      continue;
    }

    if (payload && payload.file_path && !payload.status) {
      return payload.file_path;
    }

    const status = payload && payload.status;
    if (status) {
      console.log(status);
      if (status === 'COMPLETE') {
        return payload.file_path;
      }
      if (status === 'FAILED' || status === 'ERROR') {
        throw new Error(`LocalLine export ${id} returned status ${status}: ${JSON.stringify(payload)}`);
      }
    } else {
      missingStatusCount++;
      const detail = JSON.stringify(payload).slice(0, 300);
      console.warn(`Export ${id} returned no status (${missingStatusCount}); waiting. Response: ${detail}`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`LocalLine export ${id} did not complete within ${maxPollMs} ms`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeRowKeys(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[String(key).replace(/^\uFEFF/, '')] = value;
  }
  return normalized;
}

function trim(value) {
  return value == null ? '' : String(value).trim();
}

function parseNumber(value) {
  const cleaned = trim(value).replace(/[$,]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value) {
  if (value == null || !Number.isFinite(value)) return '';
  return Number(value.toFixed(6)).toString();
}

function formatMoney(value) {
  if (value == null || !Number.isFinite(value)) return '';
  return value.toFixed(2);
}

function effectiveQuantity(row) {
  const quantity = parseNumber(row['Quantity']);
  const itemCount = parseNumber(row['# of Items']);

  if (itemCount != null && itemCount > 1 && quantity === 1) {
    return itemCount;
  }
  if (quantity != null) {
    return quantity;
  }
  return itemCount || 0;
}

function normalizeId(value) {
  const text = trim(value);
  if (!text) return '';
  return text.replace(/\.0$/, '');
}

function isMembershipRow(row) {
  const category = trim(row['Category']).toLowerCase();
  const product = trim(row['Product']).toLowerCase();
  return category === 'membership' || product.includes('membership');
}

function destinationType(row) {
  const fulfillmentType = trim(row['Fulfillment Type']).toLowerCase();
  if (fulfillmentType === 'pickup') return 'dropsite';
  if (fulfillmentType === 'delivery') return 'home_delivery';
  return fulfillmentType || 'unknown';
}

function parseOrderDateTime(row) {
  const dateText = trim(row['Date']);
  if (!dateText) return { sortValue: 0, orderPlacedAt: '' };

  const parsedDate = parseLooseLocalDate(dateText);
  if (Number.isNaN(parsedDate.getTime())) {
    return { sortValue: 0, orderPlacedAt: dateText };
  }

  const timeText = trim(row['Order Placed Time']);
  applyTime(parsedDate, timeText);

  const ymd = formatYMD(parsedDate);
  const hh = String(parsedDate.getHours()).padStart(2, '0');
  const mm = String(parsedDate.getMinutes()).padStart(2, '0');
  return {
    sortValue: parsedDate.getTime(),
    orderPlacedAt: timeText ? `${ymd} ${hh}:${mm}` : ymd,
  };
}

function parseLooseLocalDate(value) {
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (ymdMatch) {
    return new Date(Number(ymdMatch[1]), Number(ymdMatch[2]) - 1, Number(ymdMatch[3]));
  }

  const monthMatch = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(value);
  if (monthMatch) {
    const monthIndex = monthNameToIndex(monthMatch[2]);
    if (monthIndex >= 0) {
      return new Date(Number(monthMatch[3]), monthIndex, Number(monthMatch[1]));
    }
  }

  const parsed = new Date(value);
  return parsed;
}

function monthNameToIndex(value) {
  const names = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  return names.indexOf(value.slice(0, 3).toLowerCase());
}

function applyTime(date, timeText) {
  if (!timeText) return;
  const match = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(timeText);
  if (!match) return;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3].toUpperCase();

  if (meridiem === 'PM' && hours < 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;

  date.setHours(hours, minutes, 0, 0);
}

function normalizeOrderRow(sourceRow, sourceFile) {
  const row = normalizeRowKeys(sourceRow);
  if (isMembershipRow(row)) return null;

  const quantity = effectiveQuantity(row);
  const lineTotal = parseNumber(row['Product Subtotal']);
  const unitPrice = quantity > 0 && lineTotal != null ? lineTotal / quantity : null;
  const type = destinationType(row);
  const customerName = trim(row['Customer']);
  const fulfillmentName = trim(row['Fulfillment Name']);
  const parsedDate = parseOrderDateTime(row);

  return {
    sortValue: parsedDate.sortValue,
    row: {
      orderId: normalizeId(row['Order']),
      orderDate: trim(row['Date']),
      orderPlacedTime: trim(row['Order Placed Time']),
      orderPlacedAt: parsedDate.orderPlacedAt,
      fulfillmentDate: trim(row['Fulfillment Date']),
      customerName,
      firstName: trim(row['First Name']),
      lastName: trim(row['Last Name']),
      email: trim(row['Email']),
      phone: trim(row['Phone']),
      destinationType: type,
      fulfillmentTypeRaw: trim(row['Fulfillment Type']),
      fulfillmentName,
      destinationName: type === 'dropsite' ? fulfillmentName : customerName,
      destinationAddress: trim(row['Fulfillment Address']),
      destinationStreet: trim(row['Fulfillment Street Address']),
      destinationCity: trim(row['Fulfillment City']),
      destinationState: trim(row['Fulfillment State']),
      destinationZip: trim(row['Fulfillment ZIP Code']),
      destinationCountry: trim(row['Fulfillment Country']),
      vendor: trim(row['Vendor']),
      category: trim(row['Category']),
      productId: normalizeId(row['Product ID']),
      internalProductId: normalizeId(row['Internal Product ID']),
      packageId: normalizeId(row['Package ID']),
      productName: trim(row['Product']),
      packageName: trim(row['Package Name']),
      itemUnit: trim(row['Item Unit']),
      quantity: formatNumber(quantity),
      rawQuantity: trim(row['Quantity']),
      rawItemCount: trim(row['# of Items']),
      unitPrice: formatMoney(unitPrice),
      lineTotal: formatMoney(lineTotal),
      productSalesTax: formatMoney(parseNumber(row['Product Sales Tax'])),
      orderTotal: formatMoney(parseNumber(row['Order Total'])),
      paymentStatus: trim(row['Payment Status']),
      paymentCompletedDate: trim(row['Payment Completed Date']),
      paymentMethod: trim(row['Payment Method']),
      orderStatus: trim(row['Order Status']),
      fulfillmentStatus: trim(row['Fulfillment Status']),
      sourceFile,
    },
  };
}

async function readNormalizedRows(csvPath) {
  const rows = [];
  const sourceFile = path.basename(csvPath);

  await new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', sourceRow => {
        const normalized = normalizeOrderRow(sourceRow, sourceFile);
        if (normalized) rows.push(normalized);
      })
      .on('end', resolve)
      .on('error', reject);
  });

  return rows;
}

async function writeNormalizedCsv(rows, outputPath) {
  await new Promise((resolve, reject) => {
    const stream = fastcsv.format({ headers: OUTPUT_HEADERS });
    const writeStream = fs.createWriteStream(outputPath);

    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    stream.on('error', reject);
    stream.pipe(writeStream);

    for (const { row } of rows) {
      stream.write(row);
    }
    stream.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync('data', { recursive: true });

  const windows = monthWindows(args.start, args.end);
  const outputPath = path.join('data', `all_time_orders_${args.start}_to_${args.end}.csv`);

  console.log(`Exporting ${windows.length} monthly LocalLine window(s) from ${args.start} to ${args.end}`);
  const accessToken = await getAccessToken();

  const rows = [];
  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    const rawFilePath = path.join('data', `all_time_orders_raw_${window.start}_to_${window.end}.csv`);
    const rawFileWasCached = args.useCache && fs.existsSync(rawFilePath);
    const rawPath = await exportOrdersWindowWithRetry(accessToken, window, args);
    const normalizedRows = await readNormalizedRows(rawPath);
    rows.push(...normalizedRows);
    console.log(`Parsed ${normalizedRows.length} product row(s) from ${rawPath}`);

    const moreWindows = i < windows.length - 1;
    if (moreWindows && args.delayMs > 0 && !rawFileWasCached) {
      console.log(`Waiting ${args.delayMs} ms before the next LocalLine export job`);
      await sleep(args.delayMs);
    }
  }

  rows.sort((a, b) => {
    if (a.sortValue !== b.sortValue) return a.sortValue - b.sortValue;
    return String(a.row.orderId).localeCompare(String(b.row.orderId), undefined, { numeric: true });
  });

  await writeNormalizedCsv(rows, outputPath);
  console.log(`Wrote ${rows.length} product row(s) to ${outputPath}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
