const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const csv = require('fast-csv');
const pricing = require('./order_pricing');
const vendors = require('./vendors');
const weekly = require('./weekly_report');
const dashboard = require('./publish_dashboard_auto26');

function entry(overrides = {}) {
  return {
    id: 100, product: 10, product_name: 'Salami', package_name: 'Each',
    vendor_name: 'Example Farm', category: 'Meat', charge_type: 'package', charge_unit: 'ea',
    unit_quantity: 3, quantity_to_charge: 3, package_unit_price: 20,
    price: 22.4, total_price: 67.2, sub_order_entries: [], ...overrides,
  };
}

function order(id, entries) { return { id, status: 'OPEN', order_entries: entries }; }

async function fixture(t, orders) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffcsa-order-pricing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const csvPath = path.join(dir, 'orders.csv');
  const rows = orders.flatMap(o => o.order_entries.map(e => ({
    Order: o.id, 'Product ID': e.product, Product: e.product_name, 'Package Name': e.package_name,
    Category: e.category, Vendor: e.vendor_name, Quantity: e.quantity_to_charge,
    '# of Items': e.unit_quantity, 'Product Subtotal': e.total_price,
  })));
  fs.writeFileSync(csvPath, await csv.writeToString(rows, { headers: true }));
  const options = {
    historyDir: path.join(dir, 'history'),
    fetchOrder: async id => structuredClone(orders.find(o => String(o.id) === id)),
  };
  return { dir, csvPath, options };
}

test('mixed $20/$15 prices agree across vendor rows, summaries and dashboard readers', async t => {
  const orders = [order(1, [entry()]), order(2, [entry({ id: 101, unit_quantity: 2, quantity_to_charge: 2, package_unit_price: 15, price: 16.8, total_price: 33.6 })])];
  const f = await fixture(t, orders);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', f.options);
  const grouped = vendors.groupOrdersByVendor(data, '2026-09-29');
  const rows = vendors.groupByCategoryWithSubtotals(grouped['Example Farm']);
  assert.deepEqual(rows.slice(0, 2).map(r => [r[1], r[2], r[3]]), [[2, 15, '30.00'], [3, 20, '60.00']]);
  const [summary] = await pricing.aggregateVendorSummaryFromOrders(f.csvPath, 'unused', f.options);
  assert.equal(summary.purchaseCost, 90);
  assert.ok(Math.abs(summary.retailSales - 100.8) < 1e-8);
  const file = path.join(f.dir, 'summary.csv');
  await pricing.writeVendorSummaryCsv([summary], file);
  assert.deepEqual(await weekly.readVendorSummary(file), { purchaseCost: 90, retailSales: 100.8 });
  assert.deepEqual(await dashboard.parseVendorWeeklySummary(file), { purchaseCost: 90, retailSales: 100.8 });
});

test('two prices within the same order remain separate; each order is fetched once', async t => {
  const orders = [order(1, [entry(), entry({ id: 101, package_unit_price: 15 })])];
  const f = await fixture(t, orders);
  let calls = 0;
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', { ...f.options, fetchOrder: async () => { calls++; return orders[0]; } });
  assert.equal(calls, 1);
  assert.equal(data.lines.length, 2);
  assert.equal(pricing.summarizeVendorLines(data.lines)[0].purchaseCost, 105);
});

test('saved zero price is valid; missing/invalid prices never use retail or current catalog prices', () => {
  assert.equal(pricing.priceOrderEntry(entry({ package_unit_price: 0 })).totalPrice, 0);
  for (const value of [undefined, null, '', ' ', 'oops', -1, Infinity, false]) {
    assert.throws(() => pricing.priceOrderEntry(entry({ package_unit_price: value })), /historical vendor price needs review/);
  }
});

test('charge quantities preserve fractional weights and do not multiply package inventory twice', () => {
  assert.equal(pricing.priceOrderEntry(entry({ quantity_to_charge: 1.25 })).totalPrice, 25);
  assert.equal(pricing.priceOrderEntry(entry({ quantity_to_charge: 2, unit_quantity: 2, inventory_per_unit: 12, inventory_quantity: 24 })).totalPrice, 40);
  assert.throws(() => pricing.priceOrderEntry(entry({ quantity_to_charge: null })), /quantity_to_charge/);
});

test('missing historical prices write a review file and reject the whole priced report', async t => {
  const f = await fixture(t, [order(1, [entry({ package_unit_price: null })])]);
  await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', f.options), error => {
    assert.match(error.message, /No priced report generated/);
    const review = fs.readFileSync(error.reviewPath, 'utf8');
    assert.match(review, /Salami/);
    assert.match(review, /package_unit_price/);
    return true;
  });
});

test('fresh product vendors fill blank order vendors without replacing saved assignments or prices', async t => {
  const orders = [order(1, [entry({ vendor_name: null })]),
    order(2, [entry({ id: 101, product: 11, package_unit_price: 15 })])];
  const f = await fixture(t, orders);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', {
    ...f.options, productVendorMap: { '10': 'Deck Family Farm', '11': 'Changed Vendor' },
  });
  assert.deepEqual(data.lines.map(line => [line.vendor, line.price, line.totalPrice]),
    [['Deck Family Farm', 20, 60], ['Example Farm', 15, 45]]);
  assert.equal(data.orders.get('1').order_entries[0].vendor_name, null);
  const snapshot = fs.readdirSync(f.options.historyDir).find(file => file.startsWith('1-'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.historyDir, snapshot))).entries[0].vendor_name, null);

  orders[0].order_entries[0].package_unit_price = null;
  await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', {
    ...f.options, productVendorMap: { '10': 'Deck Family Farm' },
  }), error => error.issues.some(issue => /package_unit_price/.test(issue.reason)));
});

test('missing vendors still block reporting when the fresh catalog cannot resolve the product ID', async t => {
  const f = await fixture(t, [order(1, [entry({ vendor_name: ' ' })])]);
  await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', {
    ...f.options, productVendorMap: { '11': 'Deck Family Farm', '10': ' ' },
  }), error => {
    assert.match(error.message, /Order 1, Product ID 10: Salami/);
    assert.match(error.message, /no product vendor was resolved/);
    assert.match(error.message, /Assign a vendor to this product in Local Line/);
    return true;
  });
});

test('a box with a recovered vendor still validates and includes its components', async t => {
  const component = { id: 20, product: 30, product_name: 'Ground Beef', charge_type: 'package', unit_quantity: 2, package_unit_price: 6, price: 12 };
  const orders = [order(1, [entry({ vendor_name: null, is_box: true, sub_order_entries: [component] })])];
  const f = await fixture(t, orders);
  const productVendorMap = { '10': 'Full Farm CSA', '30': 'Deck Family Farm' };
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', { ...f.options, productVendorMap });
  const grouped = vendors.groupOrdersByVendor(data, '2026-09-30');
  const details = await vendors.buildFullFarmBundleDetails(grouped['Full Farm CSA'], data.orders, productVendorMap);
  assert.equal(details.length, 1);
  assert.equal(details[0].components[0].sourceVendor, 'Deck Family Farm');
  assert.equal(details[0].components[0].quantity, 6);
  assert.equal(details[0].vendorCostTotal, 36);

  component.charge_type = 'weight';
  await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', { ...f.options, productVendorMap }),
    error => error.issues.some(issue => /weighted box component needs review/.test(issue.reason)));
});

test('API failure, cancelled orders and invalid responses cannot become zero cost', async t => {
  const f = await fixture(t, [order(1, [entry()])]);
  for (const getOrder of [async () => { throw new Error('HTTP unavailable'); }, async () => ({}), async () => ({ ...order(1, [entry()]), status: 'CANCELLED' })]) {
    await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', { ...f.options, fetchOrder: getOrder }), /needs review/);
  }
});

test('stale or partial CSV and order API totals cannot be combined silently', async t => {
  const f = await fixture(t, [order(1, [entry()])]);
  await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', {
    ...f.options, fetchOrder: async () => order(1, [entry({ total_price: 50 })]),
  }), error => error.issues.some(issue => /refresh the orders export/.test(issue.reason)));
  await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', {
    ...f.options, fetchOrder: async () => order(1, [entry(), entry({ id: 200, product: 11, product_name: 'Eggs' })]),
  }), /needs review/);
});

test('price snapshots are immutable, contain no customer data, and preserve later order corrections', async t => {
  const orders = [order(1, [entry()])];
  orders[0].customer = { email: 'private@example.invalid' };
  const f = await fixture(t, orders);
  await pricing.loadOrderPricing(f.csvPath, 'unused', f.options);
  const [first] = fs.readdirSync(f.options.historyDir);
  const original = fs.readFileSync(path.join(f.options.historyDir, first), 'utf8');
  assert.ok(!original.includes('private@example.invalid'));
  await pricing.loadOrderPricing(f.csvPath, 'unused', f.options);
  assert.equal(fs.readdirSync(f.options.historyDir).length, 1);
  orders[0].order_entries[0].package_unit_price = 15;
  const updated = await pricing.loadOrderPricing(f.csvPath, 'unused', f.options);
  assert.equal(updated.lines[0].price, 15);
  assert.equal(fs.readdirSync(f.options.historyDir).length, 2);
  assert.equal(fs.readFileSync(path.join(f.options.historyDir, first), 'utf8'), original);
});

test('bundle quantities multiply saved component costs once and split price changes', async t => {
  const component = { id: 20, product: 30, product_package: 40, product_name: 'Ground Beef', package_name: '1 lb', vendor_name: 'Example Farm', unit_quantity: 2, charge_type: 'package', charge_unit_name: 'ea', package_unit_price: 6.49, price: 12.98 };
  const priced = pricing.priceBoxComponent(component, 3);
  assert.equal(priced.quantity, 6);
  assert.ok(Math.abs(priced.totalPrice - 38.94) < 1e-8);
  assert.equal(priced.boxUnitPrice, 6.49);
  assert.ok(Math.abs(priced.boxTotalPrice - 38.94) < 1e-8);
  const parent = entry({ vendor_name: 'Full Farm CSA', product_name: 'Meat Box', is_box: true, sub_order_entries: [component] });
  const orders = [order(1, [parent]), order(2, [{ ...parent, id: 101, package_unit_price: 15, sub_order_entries: [{ ...component, package_unit_price: 5, price: 10 }] }])];
  const f = await fixture(t, orders);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', f.options);
  const grouped = vendors.groupOrdersByVendor(data, '2026-09-29');
  const details = await vendors.buildFullFarmBundleDetails(grouped['Full Farm CSA'], data.orders, { '30': 'Example Farm' });
  assert.equal(details.length, 2);
  const report = vendors.buildBoxContentReport(details, {}, '2026-09-29');
  assert.equal(report.bundleSummaries.length, 2);
  assert.equal(report.additions.length, 2);
  assert.deepEqual(report.additions.map(a => a.price).sort(), [5, 6.49]);
  assert.ok(Math.abs(report.totals.vendorCostTotal - 68.94) < 1e-8);
});

test('unknown weighted component quantities are flagged rather than guessed', () => {
  assert.throws(() => pricing.priceBoxComponent({ id: 1, product_name: 'Beef', package_unit_price: 12, price: 18, unit_quantity: 1, charge_type: 'weight' }, 1), /weighted box component needs review/);
});

test('legacy summaries are excluded until rebuilt, and preserved when replaced', async t => {
  const f = await fixture(t, [order(1, [entry()])]);
  const file = path.join(f.dir, 'summary.csv');
  const old = 'Vendor,RetailSales,PurchaseCost\nExample Farm,67.20,45.00\n';
  fs.writeFileSync(file, old);
  assert.equal(await weekly.readVendorSummary(file), null);
  assert.equal(await dashboard.parseVendorWeeklySummary(file), null);
  await pricing.writeVendorSummaryCsv(pricing.summarizeVendorLines([{ vendor: 'Example Farm', retailTotal: 67.2, totalPrice: 60 }]), file);
  const archive = path.join(f.dir, 'vendor_summary_history');
  assert.equal(fs.readFileSync(path.join(archive, fs.readdirSync(archive)[0]), 'utf8'), old);
  assert.equal((await weekly.readVendorSummary(file)).purchaseCost, 60);
});

test('an empty week can be recorded without treating it as a legacy summary', async t => {
  const f = await fixture(t, [order(1, [entry()])]);
  const file = path.join(f.dir, 'summary.csv');
  await pricing.writeVendorSummaryCsv([], file);
  assert.deepEqual(await weekly.readVendorSummary(file), { purchaseCost: 0, retailSales: 0 });
});

test('membership lines are excluded from vendor costing', async t => {
  const f = await fixture(t, [order(1, [entry(), entry({ id: 101, product: 12, category: 'Membership', package_unit_price: null })])]);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', f.options);
  assert.equal(data.lines.length, 1);
});

test('side purchases, deposits, fees and payments need no vendor cost; mixed orders retain ordinary products', async t => {
  const names = ['Lamb Side', '1/4 Beef Side', '1/2 Pork Side', 'Side Delivery Fee',
    'Side Deposit', 'Side Order to pay with credit', '3rd side payment', '2nd Side Payment',
    'Delivery Fee', 'Split payments'];
  const sides = names.map((product_name, i) => entry({
    id: 200 + i, product: null, product_name, package_name: '', vendor_name: null,
    package_unit_price: null, quantity_to_charge: null, total_price: i === 4 ? -100 : 100,
  }));
  const f = await fixture(t, [order(1, [entry(), ...sides])]);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', f.options);
  assert.deepEqual(data.lines.map(line => line.entryId), [100]);
  assert.equal(data.excludedSideEntries.length, names.length);
  assert.equal(data.orders.get('1').order_entries.length, names.length + 1);
  const [summary] = await pricing.aggregateVendorSummaryFromOrders(f.csvPath, 'unused', f.options);
  assert.equal(summary.purchaseCost, 60);
  assert.equal(summary.retailSales, 67.2);
  const snapshot = JSON.parse(fs.readFileSync(path.join(f.options.historyDir, fs.readdirSync(f.options.historyDir)[0])));
  assert.equal(snapshot.entries.length, names.length + 1);

  // Excluding sides from costing must not hide stale customer-charge exports.
  sides[0].total_price = 200;
  await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', f.options), /refresh the orders export/);
});

test('side-only and payment-only orders can complete without priced vendor lines', async t => {
  const f = await fixture(t, [order(1, [entry({ product_name: ' SIDE DEPOSIT ', package_unit_price: null })]),
    order(2, [entry({ product_name: '3rd side payment', package_unit_price: null })])]);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', f.options);
  assert.deepEqual(data.lines, []);
  assert.equal(data.excludedSideEntries.length, 2);
  assert.deepEqual(vendors.groupOrdersByVendor(data, '2026-10-17'), {});
});

test('side exclusions do not bypass missing prices for unrelated products or fees', async t => {
  const f = await fixture(t, [order(1, [entry({ product_name: 'Lamb Side', package_unit_price: null }),
    entry({ id: 101, product_name: 'Riverside Cheese', package_unit_price: null })]),
  order(2, [entry({ id: 102, product_name: 'Delivery Fee', package_unit_price: null }),
    entry({ id: 103, product_name: 'Split payments', package_unit_price: null })])]);
  await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', f.options), error => {
    assert.deepEqual(error.issues.map(issue => issue.entryId).sort(), [101, 102, 103]);
    return true;
  });
  assert.equal(pricing.isSideRelatedEntry(entry({ product_name: 'Custom beef', category: 'Meat Sides' })), true);
});

test('side boxes are not expanded into vendor costs in a mixed Full Farm order', async t => {
  const component = { id: 20, product: 30, product_name: 'Ground Beef', charge_type: 'package', unit_quantity: 2, package_unit_price: 6, price: 12 };
  const orders = [order(1, [entry({ vendor_name: 'Full Farm CSA', is_box: true, sub_order_entries: [component] }),
    entry({ id: 101, product_name: 'Lamb Side', vendor_name: 'Full Farm CSA', is_box: true,
      package_unit_price: null, sub_order_entries: [{ ...component, package_unit_price: null }] })])];
  const f = await fixture(t, orders);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', f.options);
  const grouped = vendors.groupOrdersByVendor(data, '2026-10-17');
  const details = await vendors.buildFullFarmBundleDetails(grouped['Full Farm CSA'], data.orders, { '30': 'Deck Family Farm' });
  assert.equal(details.length, 1);
  assert.equal(details[0].vendorCostTotal, 36);
});

test('partial mode withholds all lines for a bad vendor across orders and retains complete good vendors', async t => {
  const f = await fixture(t, [order(1, [entry({ vendor_name: 'Bad Farm', package_unit_price: null }),
    entry({ id: 101, product: 11, vendor_name: 'Good Farm' })]),
  order(2, [entry({ id: 102, vendor_name: 'Bad Farm' })])]);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', { ...f.options, allowPartialVendors: true });
  assert.deepEqual(data.blockedVendors, ['Bad Farm']);
  assert.deepEqual(data.lines.map(line => line.vendor), ['Good Farm']);
  assert.equal(data.lines[0].totalPrice, 60);
  assert.equal(data.issues[0].vendor, 'Bad Farm');
  assert.match(fs.readFileSync(data.reviewPath, 'utf8'), /Bad Farm/);
  assert.match(vendors.formatVendorRunSummary(data), /PARTIAL REPORT/);
  // Accounting summaries must never accept partial vendor totals.
  await assert.rejects(pricing.aggregateVendorSummaryFromOrders(f.csvPath, 'unused', {
    ...f.options, allowPartialVendors: true,
  }), /No priced report generated/);
});

test('partial mode still stops when the affected vendors cannot be established', async t => {
  const original = order(1, [entry()]);
  const f = await fixture(t, [original]);
  for (const fetchOrder of [
    async () => { throw new Error('API unavailable'); },
    async () => order(1, [entry({ vendor_name: '', package_unit_price: null })]),
    async () => order(1, [entry({ total_price: 999 })]),
  ]) {
    await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', {
      ...f.options, allowPartialVendors: true, fetchOrder,
    }), /No priced report generated/);
  }
});

test('a bad box component withholds its parent and all linked vendors while unrelated vendors proceed', async t => {
  const component = { id: 20, product: 30, product_name: 'Beef', vendor_name: 'Beef Farm',
    charge_type: 'package', unit_quantity: 1, package_unit_price: null, price: 12 };
  const f = await fixture(t, [order(1, [
    entry({ vendor_name: 'Full Farm CSA', is_box: true, sub_order_entries: [component,
      { ...component, id: 21, vendor_name: 'Other Box Farm', package_unit_price: 6 }] }),
    entry({ id: 101, vendor_name: 'Beef Farm' }),
    entry({ id: 102, vendor_name: 'Unrelated Farm' }),
  ])]);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', { ...f.options, allowPartialVendors: true });
  assert.deepEqual(data.blockedVendors, ['Beef Farm', 'Full Farm CSA', 'Other Box Farm']);
  assert.deepEqual(data.lines.map(line => line.vendor), ['Unrelated Farm']);
});

test('a failing source vendor also withholds linked boxes and their other suppliers', async t => {
  const component = { id: 20, product: 30, product_name: 'Beef', vendor_name: 'Beef Farm',
    charge_type: 'package', unit_quantity: 1, package_unit_price: 6, price: 12 };
  const f = await fixture(t, [order(1, [
    entry({ vendor_name: 'Full Farm CSA', is_box: true, sub_order_entries: [component,
      { ...component, id: 21, vendor_name: 'Other Box Farm' }] }),
    entry({ id: 101, vendor_name: 'Beef Farm', package_unit_price: null }),
    entry({ id: 102, vendor_name: 'Unrelated Farm' }),
  ])]);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', { ...f.options, allowPartialVendors: true });
  assert.deepEqual(data.blockedVendors, ['Beef Farm', 'Full Farm CSA', 'Other Box Farm']);
  assert.deepEqual(data.lines.map(line => line.vendor), ['Unrelated Farm']);
});

test('a box with an unknown supplier cannot produce partial fulfillment reports', async t => {
  const component = { id: 20, product: 30, product_name: 'Beef',
    charge_type: 'package', unit_quantity: 1, package_unit_price: 6, price: 12 };
  const f = await fixture(t, [order(1, [entry({ vendor_name: 'Full Farm CSA', is_box: true, sub_order_entries: [component] })])]);
  await assert.rejects(pricing.loadOrderPricing(f.csvPath, 'unused', { ...f.options, allowPartialVendors: true }), /missing box component vendor assignment/);
});

test('partial mode supports withholding every vendor and writes a clearly marked PDF', async t => {
  const f = await fixture(t, [order(1, [entry({ package_unit_price: null })])]);
  const data = await pricing.loadOrderPricing(f.csvPath, 'unused', { ...f.options, allowPartialVendors: true });
  assert.deepEqual(data.lines, []);
  const notice = vendors.formatVendorRunSummary(data, { sent: [], failed: [] });
  assert.match(notice, /Vendor emails sent: none/);
  assert.match(notice, /Example Farm/);
  const pdfPath = path.join(f.dir, 'partial.pdf');
  await vendors.generateSummaryPDF({}, pdfPath, null, notice);
  assert.ok(fs.statSync(pdfPath).size > 0);
});

test('email failures and missing addresses do not stop later vendors, and are reported', async t => {
  const utilities = require('./utilities');
  const attempts = [];
  t.mock.method(utilities, 'mailADocument', async (doc, options) => {
    doc.resume();
    doc.end();
    attempts.push(options.to);
    if (options.to === 'bad@example.invalid') throw new Error('SMTP rejected');
  });
  const line = { product: 'Cheese', productId: 10, category: 'Dairy', price: 20, quantity: 3, totalPrice: 60 };
  const result = await vendors.sendVendorEmails({ Bad: [{ ...line }], Missing: [{ ...line }], Good: [{ ...line }] },
    { Bad: 'bad@example.invalid', Good: 'good@example.invalid' }, '2026-10-17', false, null, { delayMs: 0 });
  assert.deepEqual(attempts, ['bad@example.invalid', 'good@example.invalid']);
  assert.deepEqual(result.sent, ['Good']);
  assert.deepEqual(result.failed.map(item => item.vendor), ['Bad', 'Missing']);
  const summary = vendors.formatVendorRunSummary({ blockedVendors: [] }, result);
  assert.match(summary, /Vendor emails sent: Good/);
  assert.match(summary, /Bad: SMTP rejected/);
  assert.match(summary, /Missing: No vendor email address/);
});

test('vendor run sends good reports and an administrator summary with withheld vendors and review CSV', async t => {
  const utilities = require('./utilities');
  const axios = require('axios');
  const ExcelJS = require('exceljs');
  const orders = [order(1, [entry({ vendor_name: 'Bad Farm', package_unit_price: null }),
    entry({ id: 101, product: 11, vendor_name: 'Good Farm' })])];
  const f = await fixture(t, orders);
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Availability').addRow(['Local Line Product ID', 'Vendor']);
  await workbook.xlsx.writeFile(path.join(f.dir, 'products.xlsx'));
  fs.writeFileSync(path.join(f.dir, 'vendors.csv'), 'Vendor,Email\nBad Farm,bad@example.invalid\nGood Farm,good@example.invalid\n');
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  t.mock.method(utilities, 'downloadOrdersCsv', async () => f.csvPath);
  t.mock.method(utilities, 'getAccessToken', async () => JSON.stringify({ access: 'test-token' }));
  t.mock.method(utilities, 'downloadBinaryData', async () => {});
  t.mock.method(axios, 'get', async url => {
    assert.equal(url, 'https://localline.ca/api/backoffice/v2/orders/1/');
    return { data: structuredClone(orders[0]) };
  });
  const recipients = [];
  const summaries = [];
  const errors = [];
  t.mock.method(utilities, 'mailADocument', async (doc, options) => {
    doc.resume();
    doc.end();
    recipients.push(options.to);
  });
  t.mock.method(utilities, 'sendEmail', async options => { summaries.push(options); });
  t.mock.method(utilities, 'sendErrorEmail', error => { errors.push(error); });
  const window = { start: '2026-10-16', end: '2026-10-17', date: '2026-10-17' };
  await vendors.runVendorReports(window, false, { dataDir: f.dir, emailDelayMs: 0 });
  assert.deepEqual(recipients, ['good@example.invalid']);
  assert.deepEqual(errors, []);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0].subject, /PARTIAL Vendor Report/);
  assert.match(summaries[0].text, /reports withheld for Bad Farm/);
  assert.match(summaries[0].text, /Vendor emails sent: Good Farm/);
  assert.deepEqual(summaries[0].attachments.map(a => a.filename), ['vendors.pdf', 'orders_pricing_review.csv']);
  assert.equal(process.exitCode, 1);

  // A dry run must still create the review artifacts without any email calls.
  const argv = process.argv;
  process.argv = [...argv, '--dry-run'];
  t.after(() => { process.argv = argv; });
  recipients.length = 0;
  summaries.length = 0;
  await vendors.runVendorReports(window, false, { dataDir: f.dir, emailDelayMs: 0 });
  assert.deepEqual(recipients, []);
  assert.deepEqual(summaries, []);
  assert.deepEqual(errors, []);
  assert.ok(fs.statSync(path.join(f.dir, 'vendors.pdf')).size > 0);
});
