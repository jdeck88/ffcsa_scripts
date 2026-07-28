const fs = require('fs');
const path = require('path');
const fastcsv = require('fast-csv');
const ExcelJS = require('exceljs');
const utilities = require('./utilities');

const FULL_FARM_VENDOR = 'Full Farm CSA';

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isNaN(number)) return String(Math.trunc(number));
  return String(value).trim();
}

function getOrderId(row) {
  return row['Order'] || row['\ufeffOrder'] || '';
}

function toPositiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function formatQuantity(value) {
  const quantity = Number(value || 0);
  if (Math.abs(quantity - Math.round(quantity)) < 0.0001) {
    return `${Math.round(quantity)}.000`;
  }
  return quantity.toFixed(3);
}

function csvEscape(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function readOrdersCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const headers = [];

    fs.createReadStream(filePath)
      .pipe(fastcsv.parse({ headers: true, ignoreEmpty: true }))
      .on('headers', parsedHeaders => headers.push(...parsedHeaders))
      .on('data', row => rows.push(row))
      .on('end', () => resolve({ rows, headers }))
      .on('error', reject);
  });
}

function writeOrdersCsv(filePath, headers, rows) {
  const content = [
    headers.map(csvEscape).join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
  ].join('\n') + '\n';

  fs.writeFileSync(filePath, content, 'utf8');
}

async function readProductCatalog(productsFilePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(productsFilePath);

  const byProductId = new Map();
  const byPackageId = new Map();

  const readWorksheetRows = (worksheet) => {
    if (!worksheet) return [];
    const headers = worksheet.getRow(1).values;
    const rows = [];

    for (let i = 2; i <= worksheet.actualRowCount; i++) {
      const values = worksheet.getRow(i).values;
      const row = {};
      for (let j = 1; j < headers.length; j++) {
        row[headers[j]] = values[j];
      }
      rows.push(row);
    }

    return rows;
  };

  for (const row of readWorksheetRows(workbook.getWorksheet('Availability') || workbook.getWorksheet(1))) {
    const productId = normalizeId(row['Local Line Product ID']);
    if (!productId) continue;
    byProductId.set(productId, {
      product: row['Product'] || '',
      vendor: row['Vendor'] || '',
      itemUnit: row['Item Unit'] || row['Charge Unit'] || '',
      packingTag: row['Packing Tag'] || '',
    });
  }

  for (const row of readWorksheetRows(workbook.getWorksheet('Packages and pricing') || workbook.getWorksheet(2))) {
    const packageId = normalizeId(row['Package ID']);
    if (!packageId) continue;
    byPackageId.set(packageId, {
      productId: normalizeId(row['Local Line Product ID']),
      product: row['Product'] || '',
      packageName: row['Package Name'] || '',
      itemUnit: row['Item Unit'] || row['Charge Unit'] || '',
    });
  }

  return { byProductId, byPackageId };
}

function getCatalogDetails(subEntry, catalog) {
  const productId = normalizeId(subEntry.product);
  const packageId = normalizeId(subEntry.product_package || subEntry.package_id);
  const productDetails = catalog.byProductId.get(productId) || {};
  const packageDetails = catalog.byPackageId.get(packageId) || {};

  return {
    productId,
    packageId,
    product: subEntry.product_name || packageDetails.product || productDetails.product || '',
    packageName: subEntry.package_name || packageDetails.packageName || '',
    vendor: subEntry.vendor_name || productDetails.vendor || '',
    itemUnit:
      subEntry.item_unit ||
      subEntry.item_unit_name ||
      subEntry.unit ||
      subEntry.charge_unit ||
      packageDetails.itemUnit ||
      productDetails.itemUnit ||
      '',
    packingTag: productDetails.packingTag || '',
  };
}

function getBoxQuantity(boxEntry, parentRow) {
  return toPositiveNumber(
    boxEntry.quantity_to_charge ?? boxEntry.unit_quantity ?? boxEntry.quantity,
    toPositiveNumber(parentRow['Quantity'], 1)
  );
}

function getComponentUnitQuantity(subEntry) {
  return toPositiveNumber(
    subEntry.unit_quantity ?? subEntry.quantity_to_charge ?? subEntry.quantity,
    1
  );
}

function buildComponentRow(parentRow, boxEntry, subEntry, catalog) {
  const details = getCatalogDetails(subEntry, catalog);
  const quantity = getComponentUnitQuantity(subEntry) * getBoxQuantity(boxEntry, parentRow);
  const formattedQuantity = formatQuantity(quantity);

  return {
    ...parentRow,
    'Vendor': details.vendor || parentRow['Vendor'],
    'Product ID': details.productId,
    'Category': `Box Contents - ${boxEntry.product_name || parentRow['Product']}`,
    'Product': details.product,
    'Item Unit': details.itemUnit,
    'Package Name': details.packageName,
    '# of Items': formattedQuantity,
    'Quantity': formattedQuantity,
    'Product Subtotal': '',
    'Product Sales Tax': '',
    'Package ID': details.packageId ? `${details.packageId}.0` : '',
    'Packing Tag': details.packingTag,
    'Back Office Note': [
      parentRow['Back Office Note'],
      `Box Contents from ${boxEntry.product_name || parentRow['Product']}`,
    ].filter(Boolean).join(' | '),
  };
}

function isMatchingParentRow(row, orderId, boxEntry) {
  return (
    getOrderId(row) === String(orderId) &&
    row['Vendor'] === FULL_FARM_VENDOR &&
    normalizeId(row['Product ID']) === normalizeId(boxEntry.product)
  );
}

async function fetchOrderDetails(orderIds, accessToken) {
  const orders = new Map();

  for (const orderId of orderIds) {
    const order = await utilities.getJsonFromUrl(
      `https://localline.ca/api/backoffice/v2/orders/${orderId}/`,
      accessToken
    );
    if (!Array.isArray(order?.order_entries)) {
      throw new Error(`[box_contents] LocalLine order ${orderId} detail did not include order_entries; cannot expand box contents.`);
    }
    orders.set(String(orderId), order);
  }

  return orders;
}

async function expandOrderRowsWithBoxContents(orderFilePath, options = {}) {
  const productsFilePath = options.productsFilePath || path.join(path.dirname(orderFilePath), 'products.xlsx');
  const outputFilePath = options.outputFilePath || orderFilePath.replace(/\.csv$/i, '_expanded.csv');
  const { rows, headers } = await readOrdersCsv(orderFilePath);

  const candidateOrderIds = [...new Set(
    rows
      .filter(row => row['Vendor'] === FULL_FARM_VENDOR && row['Category'] !== 'Membership')
      .map(getOrderId)
      .filter(Boolean)
  )];

  if (!candidateOrderIds.length) {
    return orderFilePath;
  }

  if (!fs.existsSync(productsFilePath)) {
    console.warn(`[box_contents] Products export not found at ${productsFilePath}; leaving box rows unexpanded.`);
    return orderFilePath;
  }

  const tokenPayload = options.accessToken
    ? { access: options.accessToken }
    : JSON.parse(await utilities.getAccessToken());
  const accessToken = tokenPayload.access;
  if (!accessToken) {
    throw new Error('[box_contents] LocalLine access token was not available; cannot expand box contents.');
  }

  const [catalog, orderDetails] = await Promise.all([
    readProductCatalog(productsFilePath),
    fetchOrderDetails(candidateOrderIds, accessToken),
  ]);

  const parentRowsToReplace = new Set();
  const componentRows = [];
  const boxSummaries = [];

  for (const [orderId, order] of orderDetails.entries()) {
    const boxEntries = (order.order_entries || []).filter(entry =>
      entry.vendor_name === FULL_FARM_VENDOR &&
      entry.is_box &&
      Array.isArray(entry.sub_order_entries) &&
      entry.sub_order_entries.length
    );

    for (const boxEntry of boxEntries) {
      const parentRowIndexes = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => isMatchingParentRow(row, orderId, boxEntry));

      for (const { row, index } of parentRowIndexes) {
        parentRowsToReplace.add(index);
        for (const subEntry of boxEntry.sub_order_entries) {
          componentRows.push(buildComponentRow(row, boxEntry, subEntry, catalog));
        }
      }

      boxSummaries.push({
        orderId,
        box: boxEntry.product_name,
        parentRows: parentRowIndexes.length,
        components: boxEntry.sub_order_entries.length,
      });
    }
  }

  if (!componentRows.length) {
    return orderFilePath;
  }

  const expandedRows = rows
    .filter((_, index) => !parentRowsToReplace.has(index))
    .concat(componentRows);
  writeOrdersCsv(outputFilePath, headers, expandedRows);

  console.log(
    `[box_contents] Expanded ${boxSummaries.length} box order entr${boxSummaries.length === 1 ? 'y' : 'ies'} ` +
    `into ${componentRows.length} component row(s): ${outputFilePath}`
  );
  for (const summary of boxSummaries) {
    console.log(
      `[box_contents] Order ${summary.orderId}: ${summary.box} ` +
      `(${summary.components} component(s), ${summary.parentRows} parent row(s))`
    );
  }

  return outputFilePath;
}

module.exports = {
  expandOrderRowsWithBoxContents,
};
