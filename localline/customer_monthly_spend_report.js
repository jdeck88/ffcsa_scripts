#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const fastcsv = require('fast-csv');

const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_MIN_AVERAGE = 100;
const AVG_DAYS_PER_MONTH = 365.25 / 12;

function usage() {
  console.log([
    'Usage:',
    '  node customer_monthly_spend_report.js [customers.csv] [as-of YYYY-MM-DD] [min-average] [orders.csv]',
    '',
    'Defaults:',
    '  customers.csv: latest data/customers_YYYY-MM-DD.csv',
    '  as-of: date from customers filename, or today',
    `  min-average: ${DEFAULT_MIN_AVERAGE}`,
    '  orders.csv: latest data/all_time_orders_YYYY-MM-DD_to_YYYY-MM-DD.csv, if present',
    '',
    'Output:',
    '  data/customer_spend_at_least_<min>_per_month_<as-of>.csv',
    '',
    'Notes:',
    '  Uses LocalLine customer export Total Spent for all-time spend.',
    '  Average monthly spend is Total Spent divided by months since Customer Since.',
    '  Account addresses are kept separate from last fulfillment/drop-site addresses.',
  ].join('\n'));
}

function latestCustomerCsv() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(file => /^customers_\d{4}-\d{2}-\d{2}\.csv$/.test(file))
    .sort();

  if (files.length === 0) {
    throw new Error(`No customers_YYYY-MM-DD.csv files found in ${DATA_DIR}`);
  }

  return path.join(DATA_DIR, files[files.length - 1]);
}

function latestOrdersCsv() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(file => /^all_time_orders_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv$/.test(file))
    .sort();

  return files.length === 0 ? null : path.join(DATA_DIR, files[files.length - 1]);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const customersCsv = argv[0] ? path.resolve(argv[0]) : latestCustomerCsv();
  const asOf = argv[1] || dateFromCustomerFilename(customersCsv) || todayYMD();
  const minAverage = argv[2] == null ? DEFAULT_MIN_AVERAGE : Number(argv[2]);
  const ordersCsv = argv[3] ? path.resolve(argv[3]) : latestOrdersCsv();

  if (!fs.existsSync(customersCsv)) {
    throw new Error(`Customer CSV not found: ${customersCsv}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error(`as-of must be YYYY-MM-DD; received ${asOf}`);
  }
  if (!Number.isFinite(minAverage) || minAverage < 0) {
    throw new Error(`min-average must be a non-negative number; received ${argv[2]}`);
  }
  if (ordersCsv && !fs.existsSync(ordersCsv)) {
    throw new Error(`Orders CSV not found: ${ordersCsv}`);
  }

  return { customersCsv, asOf, minAverage, ordersCsv };
}

function dateFromCustomerFilename(filePath) {
  const match = /customers_(\d{4}-\d{2}-\d{2})\.csv$/.exec(path.basename(filePath));
  return match ? match[1] : null;
}

function todayYMD() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function parseMoney(value) {
  const cleaned = String(value == null ? '' : value).replace(/[$,]/g, '').trim();
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseInteger(value) {
  const parsed = Number(String(value == null ? '' : value).replace(/,/g, '').trim());
  return Number.isInteger(parsed) ? parsed : 0;
}

function parseYMD(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function parseLocalLineDate(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;

  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (ymdMatch) {
    return new Date(Number(ymdMatch[1]), Number(ymdMatch[2]) - 1, Number(ymdMatch[3]));
  }

  const monthMatch = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(text);
  if (monthMatch) {
    const monthIndex = monthNameToIndex(monthMatch[2]);
    if (monthIndex >= 0) {
      return new Date(Number(monthMatch[3]), monthIndex, Number(monthMatch[1]));
    }
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function monthNameToIndex(value) {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(value.slice(0, 3).toLowerCase());
}

function monthsBetween(startDate, endDate) {
  if (!startDate || Number.isNaN(startDate.getTime())) return 1;

  const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  const days = Math.max(1, (end - start) / 86400000 + 1);

  return Math.max(1, days / AVG_DAYS_PER_MONTH);
}

function trim(value) {
  return value == null ? '' : String(value).trim();
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

function formatNumber(value) {
  return Number(value || 0).toFixed(2);
}

function fullAddress(row) {
  return [
    row['Address'],
    row['City'],
    row['Province'],
    row['Postal Code'],
    row['Country'],
  ].map(trim).filter(Boolean).join(', ');
}

function rowAddress(row, prefix) {
  return [
    row[`${prefix}Street`],
    row[`${prefix}City`],
    row[`${prefix}State`],
    row[`${prefix}Zip`],
    row[`${prefix}Country`],
  ].map(trim).filter(Boolean).join(', ');
}

function customerKey(row) {
  const email = trim(row['Email']).toLowerCase();
  if (email) return `email:${email}`;
  return `customer:${trim(row['Customer']).toLowerCase()}|${trim(row['Phone']).toLowerCase()}`;
}

function orderKey(row) {
  const email = trim(row.email).toLowerCase();
  if (email) return `email:${email}`;
  return `customer:${trim(row.customerName).toLowerCase()}|${trim(row.phone).toLowerCase()}`;
}

function orderSortValue(row) {
  const values = [
    trim(row.orderPlacedAt).replace(' ', 'T'),
    trim(row.orderDate),
    trim(row.fulfillmentDate),
  ].filter(Boolean);

  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return 0;
}

async function readCustomers(filePath) {
  const rows = [];

  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', row => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  return rows;
}

async function readLatestFulfillmentByCustomer(filePath) {
  if (!filePath) {
    return { latestAny: new Map(), latestHome: new Map() };
  }

  const latestAny = new Map();
  const latestHome = new Map();

  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', row => {
        const key = orderKey(row);
        if (!key) return;

        const destinationAddress = trim(row.destinationAddress) || rowAddress(row, 'destination');
        if (!destinationAddress) return;

        const candidate = {
          value: orderSortValue(row),
          type: trim(row.destinationType),
          name: trim(row.destinationName) || trim(row.fulfillmentName),
          address: destinationAddress,
        };

        const currentAny = latestAny.get(key);
        if (!currentAny || candidate.value >= currentAny.value) {
          latestAny.set(key, candidate);
        }

        if (candidate.type === 'home_delivery') {
          const currentHome = latestHome.get(key);
          if (!currentHome || candidate.value >= currentHome.value) {
            latestHome.set(key, candidate);
          }
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  return { latestAny, latestHome };
}

async function writeCsv(rows, outputPath) {
  await new Promise((resolve, reject) => {
    const stream = fastcsv.format({ headers: true });
    const writeStream = fs.createWriteStream(outputPath);

    stream.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);

    stream.pipe(writeStream);
    rows.forEach(row => stream.write(row));
    stream.end();
  });
}

async function main() {
  const { customersCsv, asOf, minAverage, ordersCsv } = parseArgs(process.argv.slice(2));
  const asOfDate = parseYMD(asOf);
  const customers = await readCustomers(customersCsv);
  const fulfillment = await readLatestFulfillmentByCustomer(ordersCsv);

  const results = customers
    .map(row => {
      const totalSpend = parseMoney(row['Total Spent']);
      const customerSince = parseLocalLineDate(row['Customer Since']);
      const months = monthsBetween(customerSince, asOfDate);
      const averageMonthlySpend = totalSpend / months;
      const accountAddress = fullAddress(row);
      const latestAnyFulfillment = fulfillment.latestAny.get(customerKey(row));
      const latestHomeFulfillment = fulfillment.latestHome.get(customerKey(row));
      const reportAddress = accountAddress || (latestHomeFulfillment && latestHomeFulfillment.address) || '';

      return {
        Customer: trim(row['Customer']),
        Email: trim(row['Email']),
        Phone: trim(row['Phone']),
        Address: reportAddress,
        'Street Address': trim(row['Address']),
        City: trim(row['City']),
        Province: trim(row['Province']),
        Country: trim(row['Country']),
        'Postal Code': trim(row['Postal Code']),
        'Address Source': accountAddress
          ? 'Customer export'
          : latestHomeFulfillment
            ? 'Last home delivery fulfillment'
            : 'Missing customer account address',
        'Last Fulfillment Type': latestAnyFulfillment ? latestAnyFulfillment.type : '',
        'Last Fulfillment Name': latestAnyFulfillment ? latestAnyFulfillment.name : '',
        'Last Fulfillment Address': latestAnyFulfillment ? latestAnyFulfillment.address : '',
        'Average Spend Per Month': formatMoney(averageMonthlySpend),
        'Total Spend All Time': formatMoney(totalSpend),
        'Months In Average': formatNumber(months),
        'Customer Since': trim(row['Customer Since']),
        'Last Order': trim(row['Last Order']),
        Orders: parseInteger(row['Orders']),
        Status: trim(row['Status']),
        'Customer ID': trim(row['Customer ID']),
      };
    })
    .filter(row => Number(row['Average Spend Per Month']) >= minAverage)
    .sort((a, b) => {
      const spendDelta = Number(b['Average Spend Per Month']) - Number(a['Average Spend Per Month']);
      if (spendDelta !== 0) return spendDelta;
      return a.Customer.localeCompare(b.Customer);
    });

  const minLabel = String(minAverage).replace(/\./g, '_');
  const outputPath = path.join(DATA_DIR, `customer_spend_at_least_${minLabel}_per_month_${asOf}.csv`);
  await writeCsv(results, outputPath);

  console.log(`Read ${customers.length} customer row(s) from ${path.relative(process.cwd(), customersCsv)}`);
  if (ordersCsv) {
    console.log(`Read latest fulfillment addresses from ${path.relative(process.cwd(), ordersCsv)}`);
  }
  console.log(`Wrote ${results.length} customer row(s) to ${path.relative(process.cwd(), outputPath)}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
