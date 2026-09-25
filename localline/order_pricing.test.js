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
