const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const fastcsv = require('fast-csv');

const PRICING_BASIS = 'order-package-unit-price-v1';
const DEFAULT_HISTORY_DIR = path.join(__dirname, 'data', 'order_price_history');

function normalizeId(value) {
  if (value && typeof value === 'object') value = value.id;
  if (value == null || String(value).trim() === '') return '';
  const n = Number(value);
  return Number.isSafeInteger(n) ? String(n) : String(value).trim();
}

function numberOrNull(value) {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isMembership(category) {
  return String(category || '').trim().toLowerCase() === 'membership';
}

function pricingError(entry, message) {
  return new Error(`${entry.product_name || 'Unnamed product'} (entry ${entry.id ?? 'unknown'}): ${message}`);
}

function historicalUnitPrice(entry) {
  const price = numberOrNull(entry.package_unit_price);
  if (price === null || price < 0) {
    throw pricingError(entry, 'missing or invalid saved package_unit_price; historical vendor price needs review');
  }
  return price; // Zero is a valid saved price; never substitute a retail/catalog price.
}

function chargeQuantity(entry) {
  const quantity = numberOrNull(entry.quantity_to_charge);
  if (quantity === null || quantity < 0) {
    throw pricingError(entry, 'missing or invalid quantity_to_charge');
  }
  return quantity;
}

function priceOrderEntry(entry) {
  const price = historicalUnitPrice(entry);
  const quantity = chargeQuantity(entry);
  const retailTotal = numberOrNull(entry.total_price);
  if (retailTotal === null || retailTotal < 0) throw pricingError(entry, 'missing or invalid saved total_price');
  return { price, quantity, totalPrice: price * quantity, retailTotal };
}

// SubOrderEntry.price is the component's TOTAL per box, not its unit price.
function priceBoxComponent(entry, boxQuantity) {
  const price = historicalUnitPrice(entry);
  let perBoxQuantity = numberOrNull(entry.quantity_to_charge);
  if (perBoxQuantity === null && entry.charge_type === 'package') {
    perBoxQuantity = numberOrNull(entry.unit_quantity);
  }
  // The API does not document a charge quantity for weighted sub-entries.
  // Do not guess a weight or infer a vendor price from the retail amount.
  if (perBoxQuantity === null || perBoxQuantity < 0) {
    throw pricingError(entry, 'component charge quantity unavailable; weighted box component needs review');
  }
  const boxValue = numberOrNull(entry.price);
  if (boxValue === null || boxValue < 0) throw pricingError(entry, 'missing component value saved on the box');
  const quantity = perBoxQuantity * boxQuantity;
  return {
    price,
    quantity,
    totalPrice: price * quantity,
    boxUnitPrice: perBoxQuantity > 0 ? boxValue / perBoxQuantity : 0,
    boxTotalPrice: boxValue * boxQuantity,
  };
}

async function readOrderRows(csvPath) {
  const rows = [];
  const stream = fs.createReadStream(csvPath);
  const parser = stream.pipe(fastcsv.parse({ headers: headers => headers.map(h => h.replace(/^\uFEFF/, '')) }));
  stream.on('error', error => parser.destroy(error));
  for await (const row of parser) rows.push(row);
  return rows;
}

function productKey(productId, productName, packageName) {
  return JSON.stringify([normalizeId(productId) || String(productName || ''), String(packageName || '')]);
}

function reconcileOrder(order, rows) {
  const exported = new Map();
  const actual = new Map();
  for (const row of rows) {
    if (isMembership(row.Category)) continue;
    const key = productKey(row['Product ID'], row.Product, row['Package Name']);
    const subtotal = numberOrNull(row['Product Subtotal']);
    if (subtotal === null) throw new Error('Order export has a missing Product Subtotal; use the unexpanded orders CSV');
    exported.set(key, (exported.get(key) || 0) + subtotal);
  }
  for (const entry of order.order_entries) {
    if (isMembership(entry.category)) continue;
    const key = productKey(entry.product, entry.product_name, entry.package_name);
    const subtotal = numberOrNull(entry.total_price);
    if (subtotal === null) throw pricingError(entry, 'missing saved total_price');
    actual.set(key, (actual.get(key) || 0) + subtotal);
  }
  for (const key of new Set([...exported.keys(), ...actual.keys()])) {
    if (!exported.has(key) || !actual.has(key) || Math.abs(exported.get(key) - actual.get(key)) > 0.011) {
      throw new Error(`Order details differ from the orders CSV for ${key}; refresh the orders export before reporting`);
    }
  }
}

const SNAPSHOT_FIELDS = [
  'id', 'product', 'product_package', 'package_price_list_entry', 'product_name',
  'package_name', 'vendor_name', 'vendor', 'vendor_id', 'category', 'is_box',
  'created_at', 'updated_at', 'package_unit_price', 'unit_quantity',
  'quantity_to_charge', 'charge_type', 'track_type', 'charge_unit', 'charge_unit_name',
  'pack_weight', 'price', 'total_price', 'sub_order_entries_total_price',
];

function snapshotEntry(entry) {
  const result = Object.fromEntries(SNAPSHOT_FIELDS.filter(k => k in entry).map(k => [k, entry[k]]));
  if (entry.sub_order_entries?.length) result.sub_order_entries = entry.sub_order_entries.map(snapshotEntry);
  return result;
}

function preserveOrderPrices(order, historyDir) {
  if (!historyDir) return;
  const snapshot = {
    pricingBasis: PRICING_BASIS,
    orderId: normalizeId(order.id),
    updatedAt: order.updated_at,
    entries: order.order_entries.map(snapshotEntry),
  };
  const json = JSON.stringify(snapshot, null, 2) + '\n';
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  fs.mkdirSync(historyDir, { recursive: true });
  // Append-only versions: order edits are honored without destroying older evidence.
  const file = path.join(historyDir, `${snapshot.orderId}-${hash}.json`);
  try { fs.writeFileSync(file, json, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

async function fetchOrder(orderId, accessToken) {
  const response = await axios.get(`https://localline.ca/api/backoffice/v2/orders/${encodeURIComponent(orderId)}/`, {
    headers: { Authorization: `Bearer ${accessToken}` }, timeout: 60000,
  });
  return response.data;
}

function csvCell(value) {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}

function throwPricingReview(issues, csvPath) {
  const reviewPath = csvPath.replace(/\.csv$/i, '') + '_pricing_review.csv';
  const content = [['Order', 'Entry', 'Product', 'Reason'], ...issues.map(i => [i.orderId, i.entryId, i.product, i.reason])];
  fs.writeFileSync(reviewPath, content.map(row => row.map(csvCell).join(',')).join('\n') + '\n');
  const error = new Error(`Vendor pricing needs review (${issues.length} issue(s)). No priced report generated. See ${reviewPath}`);
  error.issues = issues;
  error.reviewPath = reviewPath;
  throw error;
}

async function loadOrderPricing(csvPath, accessToken, options = {}) {
  const rows = await readOrderRows(csvPath);
  const rowsByOrder = new Map();
  const issues = [];
  for (const row of rows) {
    const id = normalizeId(row.Order);
    if (!id) {
      issues.push({ product: row.Product, reason: 'Missing order ID in export' });
      continue;
    }
    if (!rowsByOrder.has(id)) rowsByOrder.set(id, []);
    rowsByOrder.get(id).push(row);
  }
  const orders = new Map();
  const lines = [];
  const pending = [...rowsByOrder.keys()];
  const getOrder = options.fetchOrder || fetchOrder;
  const historyDir = options.historyDir === undefined ? DEFAULT_HISTORY_DIR : options.historyDir;
  async function worker() {
    while (pending.length) {
      const id = pending.shift();
      try {
        const order = await getOrder(id, accessToken);
        if (normalizeId(order?.id) !== id || !Array.isArray(order?.order_entries)) throw new Error('Invalid order API response');
        if (order.status === 'CANCELLED') throw new Error('Order has been cancelled; refresh the orders export');
        reconcileOrder(order, rowsByOrder.get(id));
        preserveOrderPrices(order, historyDir);
        orders.set(id, order);
        for (const entry of order.order_entries) {
          if (isMembership(entry.category)) continue;
          try {
            const priced = priceOrderEntry(entry);
            if (!String(entry.vendor_name || '').trim()) throw pricingError(entry, 'missing vendor name');
            if (entry.is_box && entry.vendor_name === 'Full Farm CSA') {
              for (const component of entry.sub_order_entries || []) priceBoxComponent(component, priced.quantity);
            }
            lines.push({
              ...priced, orderId: id, entryId: entry.id, entry,
              vendor: entry.vendor_name, category: entry.category || 'Uncategorized',
              productId: normalizeId(entry.product), packageName: entry.package_name || '',
              sourceProductName: entry.product_name,
              product: [entry.charge_unit, entry.product_name].filter(Boolean).join(', ') + (entry.package_name ? ` - ${entry.package_name}` : ''),
              priceSource: PRICING_BASIS,
            });
          } catch (error) {
            issues.push({ orderId: id, entryId: entry.id, product: entry.product_name, reason: error.message });
          }
        }
      } catch (error) {
        // Do not serialize HTTP request configuration (which contains the access token).
        issues.push({ orderId: id, reason: error.response ? `Order API HTTP ${error.response.status}` : error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  if (issues.length) throwPricingReview(issues, csvPath);
  lines.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.orderId.localeCompare(b.orderId) || a.entryId - b.entryId);
  return { orders, lines };
}

function summarizeVendorLines(lines) {
  const vendors = new Map();
  for (const line of lines) {
    if (!vendors.has(line.vendor)) vendors.set(line.vendor, { vendor: line.vendor, retailSales: 0, purchaseCost: 0 });
    const vendor = vendors.get(line.vendor);
    vendor.retailSales += line.retailTotal;
    vendor.purchaseCost += line.totalPrice;
  }
  return [...vendors.values()].map(v => ({
    ...v,
    markupAmount: v.retailSales - v.purchaseCost,
    markupPercent: v.purchaseCost > 0 ? ((v.retailSales - v.purchaseCost) / v.purchaseCost) * 100 : 0,
  })).sort((a, b) => b.retailSales - a.retailSales || a.vendor.localeCompare(b.vendor));
}

async function aggregateVendorSummaryFromOrders(csvPath, accessToken, options) {
  return summarizeVendorLines((await loadOrderPricing(csvPath, accessToken, options)).lines);
}

async function writeVendorSummaryCsv(summary, filePath) {
  const records = summary.length ? summary : [{ vendor: '(No orders)', retailSales: 0, purchaseCost: 0, markupAmount: 0, markupPercent: 0 }];
  const rows = records.map(row => ({
    Vendor: row.vendor,
    RetailSales: row.retailSales.toFixed(2),
    PurchaseCost: row.purchaseCost.toFixed(2),
    MarkupAmount: row.markupAmount.toFixed(2),
    MarkupPercent: row.markupPercent.toFixed(2),
    PricingBasis: PRICING_BASIS,
  }));
  const csv = await fastcsv.writeToString(rows, {
    headers: ['Vendor', 'RetailSales', 'PurchaseCost', 'MarkupAmount', 'MarkupPercent', 'PricingBasis'],
    alwaysWriteHeaders: true,
  });
  // Preserve the previous summary before replacing a legacy or corrected version.
  if (fs.existsSync(filePath)) {
    const previous = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256').update(previous).digest('hex');
    const archive = path.join(path.dirname(filePath), 'vendor_summary_history');
    fs.mkdirSync(archive, { recursive: true });
    const archivedPath = path.join(archive, `${path.basename(filePath, '.csv')}-${hash}.csv`);
    try { fs.writeFileSync(archivedPath, previous, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  fs.writeFileSync(filePath, csv + '\n');
}

function isHistoricalSummary(rows) {
  return rows.length > 0 && rows.every(row => row.PricingBasis === PRICING_BASIS &&
    numberOrNull(row.PurchaseCost) !== null && numberOrNull(row.RetailSales) !== null);
}

module.exports = {
  PRICING_BASIS, historicalUnitPrice, chargeQuantity, priceOrderEntry, priceBoxComponent,
  readOrderRows, reconcileOrder, preserveOrderPrices, loadOrderPricing, summarizeVendorLines,
  aggregateVendorSummaryFromOrders, writeVendorSummaryCsv, isHistoricalSummary,
};
