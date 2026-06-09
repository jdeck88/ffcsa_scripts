const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const ExcelJS = require('exceljs');
const utilities = require('./utilities');

const FULL_FARM_VENDOR = 'Full Farm CSA';
const FULL_FARM_EMAIL = 'fullfarmcsa@deckfamilyfarm.com';
const BOX_CONTENT_CATEGORY = 'Box Contents';
const BOX_COMPONENT_SOURCE = 'full_farm_box_component';

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isNaN(num)) {
    return String(Math.trunc(num));
  }
  const trimmed = String(value).trim();
  return trimmed && trimmed !== 'NaN' ? trimmed : null;
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return amount.toFixed(2);
}

function formatQuantity(value) {
  const quantity = Number(value || 0);
  if (Math.abs(quantity - Math.round(quantity)) < 0.0001) {
    return String(Math.round(quantity));
  }
  return quantity.toFixed(2).replace(/\.?0+$/, '');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function toPositiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getOrderId(row) {
  return row['Order'] || row['\ufeffOrder'] || '';
}

function groupByCategoryWithSubtotals(items) {
  const merged = {};

  // Step 1: Merge by product + category
  for (const item of items) {
    // normalize categories & strip emojis / icon chars
    let category = (item.category || '').toString();

    category = category
      .normalize("NFKC")
      .replace(/[^\x00-\x7F]/g, '')             // 🔹 strip non-ASCII (emoji/icons/etc)
      .replace(/[–—]/g, '-')                    // normalize fancy dashes
      .replace(/\s+/g, ' ')                     // collapse whitespace
      .replace(/\s*-\s*/g, ' - ')               // normalize spaces around hyphen
      .trim();

    item.category = category || 'Uncategorized';

    const key = `${item.product}|${item.category}`;
    if (!merged[key]) {
      merged[key] = {
        product: item.product,
        quantity: 0,
        price: item.price,
        totalPrice: 0,
        category: item.category
      };
    }
    merged[key].quantity += item.quantity;
    merged[key].totalPrice += item.totalPrice;
  }

  // Step 2: Sort merged entries by category, then product
  const mergedItems = Object.values(merged);
  mergedItems.sort((a, b) => {
    const catCompare = a.category.localeCompare(b.category);
    return catCompare !== 0 ? catCompare : a.product.localeCompare(b.product);
  });

  // Step 3: Build rows grouped by category with subtotals
  const finalRows = [];
  let currentCategory = null;
  let subtotal = 0;

  for (const item of mergedItems) {
    if (item.category !== currentCategory) {
      // Add subtotal row for previous category
      if (currentCategory !== null) {
        finalRows.push(['', '', `${currentCategory}`, subtotal.toFixed(2)]);
      }

      currentCategory = item.category;
      subtotal = 0;
    }

    subtotal += item.totalPrice;
    finalRows.push([
      item.product,
      item.quantity,
      item.price,
      item.totalPrice.toFixed(2)
    ]);
  }

  // Final subtotal row
  if (currentCategory !== null) {
    finalRows.push(['', '', ` ${currentCategory}`, subtotal.toFixed(2)]);
  }

  return finalRows;
}

// Load vendor emails from CSV
async function readVendorsCSV(filePath) {
  const vendors = {};
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', row => {
        if (row['Vendor'] && row['Email']) {
          vendors[row['Vendor']] = row['Email'];
        }
      })
      .on('end', () => resolve(vendors))
      .on('error', reject);
  });
}

// Load product price data from Excel
async function readVendorProductsExcel(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.getWorksheet(2);
  const headers = worksheet.getRow(1).values;
  const rows = [];

  for (let i = 2; i <= worksheet.actualRowCount; i++) {
    const row = worksheet.getRow(i).values;
    const item = {};
    for (let j = 1; j < headers.length; j++) {
      item[headers[j]] = row[j];
    }
    rows.push(item);
  }
  return rows;
}

async function readProductVendorMapExcel(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.getWorksheet('Availability') || workbook.getWorksheet(1);
  const headers = worksheet.getRow(1).values;
  const vendorMap = {};

  for (let i = 2; i <= worksheet.actualRowCount; i++) {
    const row = worksheet.getRow(i).values;
    const item = {};
    for (let j = 1; j < headers.length; j++) {
      item[headers[j]] = row[j];
    }

    const productId = normalizeId(item['Local Line Product ID']);
    const vendorName = item['Vendor'];
    if (productId && vendorName) {
      vendorMap[productId] = vendorName;
    }
  }

  return vendorMap;
}

function lookupPackagePrice(productID, packageName, productsData, packageID = null) {
  const normalizedPackageId = normalizeId(packageID);
  if (normalizedPackageId) {
    const packageMatch = productsData.find(
      p => normalizeId(p['Package ID']) === normalizedPackageId
    );
    if (packageMatch) {
      return parseFloat(packageMatch['Package Price']) || 0;
    }
  }

  const normalizedProductId = normalizeId(productID);
  const normalizedPackageName = normalizeText(packageName);
  const productMatches = productsData.filter(
    p => normalizeId(p['Local Line Product ID']) === normalizedProductId
  );
  const exactMatch = productMatches.find(
    p => normalizeText(p['Package Name']) === normalizedPackageName
  );

  if (exactMatch) {
    return parseFloat(exactMatch['Package Price']) || 0;
  }

  if (productMatches.length === 1) {
    return parseFloat(productMatches[0]['Package Price']) || 0;
  }

  const blankPackageMatch = productMatches.find(
    p => !normalizeText(p['Package Name'])
  );
  return blankPackageMatch ? parseFloat(blankPackageMatch['Package Price']) || 0 : 0;
}

// Parse order CSV and group by vendor
async function groupOrdersByVendor(orderFile, productData, fulfillmentDate) {
  return new Promise((resolve, reject) => {
    const orders = {};
    const data = [];

    fs.createReadStream(orderFile)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', row => data.push(row))
      .on('end', () => {
        data.sort((a, b) => a['Vendor'].localeCompare(b['Vendor']));
        let currentVendor = null;

        data.forEach(row => {
          const vendor = row['Vendor'];
          if (!orders[vendor]) {
            orders[vendor] = [];
          }

          if (row['Category'] !== 'Membership') {
            // Account for two different methods of quantifying orders
            let quantity = Math.round(parseFloat(row['Quantity']));
            const numItems = Math.round(parseFloat(row['# of Items']));
            if (numItems > 1 && quantity == 1) {
              quantity = numItems;
            }
            const lookupPrice = lookupPackagePrice(row['Product ID'], row['Package Name'], productData, row['Package ID']);
            const rowSubtotal = Number(row['Product Subtotal'] || 0) || 0;
            const fallbackUnitPrice = quantity > 0 ? rowSubtotal / quantity : 0;
            const price = lookupPrice > 0 ? lookupPrice : fallbackUnitPrice;
            const totalPrice = price * quantity;

            orders[vendor].push({
              orderId: getOrderId(row),
              sourceProductName: row['Product'],
              packageName: row['Package Name'],
              product: row['Item Unit'] + ', ' + row['Product'] + ' - ' + row['Package Name'],
              quantity,
              price,
              totalPrice,
              category: row['Category'],
              fulfillmentDate
            });
          }
        });
        resolve(orders);
      })
      .on('error', reject);
  });
}

function lookupSourceVendor(subEntry, productVendorMap) {
  const candidates = [
    subEntry.product,
    subEntry.product_id,
    subEntry.product_package,
    subEntry.package_id
  ];

  for (const candidate of candidates) {
    const vendor = productVendorMap[normalizeId(candidate)];
    if (vendor) {
      return { vendor, matched: true };
    }
  }

  const vendorName = normalizeText(subEntry.vendor_name);
  if (vendorName) {
    return { vendor: vendorName, matched: true };
  }

  const fallbackVendor = normalizeId(subEntry.vendor) ? `Vendor ${normalizeId(subEntry.vendor)}` : 'Unknown Vendor';
  return { vendor: fallbackVendor, matched: false };
}

function getSubEntryOrderUnitPrice(subEntry, componentQuantity = 0) {
  const directPrice = toPositiveNumber(subEntry.package_unit_price ?? subEntry.price, 0);
  if (directPrice > 0) return directPrice;

  const totalPrice = toPositiveNumber(subEntry.total_price, 0);
  if (totalPrice > 0 && componentQuantity > 0) {
    return totalPrice / componentQuantity;
  }

  return 0;
}

function formatBoxComponentProduct(component) {
  const unitPrefix = component.itemUnit ? `${component.itemUnit}, ` : '';
  const packageSuffix = component.packageName ? ` - ${component.packageName}` : '';
  return `Box content: ${unitPrefix}${component.productName}${packageSuffix}`;
}

async function buildFullFarmBundleDetails(items, accessToken, productVendorMap, productData) {
  const orderIds = [...new Set(items.map(item => item.orderId).filter(Boolean))];
  const bundleMap = new Map();

  for (const orderId of orderIds) {
    const order = await utilities.getJsonFromUrl(
      `https://localline.ca/api/backoffice/v2/orders/${orderId}/`,
      accessToken
    );

    const customerName = [
      order?.customer?.first_name,
      order?.customer?.last_name
    ].filter(Boolean).join(' ');

    for (const entry of order.order_entries || []) {
      if (entry.vendor_name !== FULL_FARM_VENDOR || !entry.is_box || !entry.sub_order_entries?.length) {
        continue;
      }

      const bundleKey = `${entry.product}|${entry.product_name}|${entry.package_name}`;
      if (!bundleMap.has(bundleKey)) {
        bundleMap.set(bundleKey, {
          bundleName: normalizeText(entry.product_name),
          bundlePackage: normalizeText(entry.package_name),
          boxBasePrice: lookupPackagePrice(entry.product, entry.package_name, productData, entry.product_package),
          boxQuantity: 0,
          boxSalesTotal: 0,
          defaultContentsValueTotal: 0,
          members: [],
          components: new Map()
        });
      }

      const bundle = bundleMap.get(bundleKey);
      const bundleQuantity = toPositiveNumber(
        entry.quantity_to_charge ?? entry.unit_quantity ?? entry.quantity,
        1
      );
      const entryUnitPrice = toPositiveNumber(entry.price ?? entry.package_unit_price, 0);
      const entryTotalPrice = toPositiveNumber(entry.total_price, entryUnitPrice * bundleQuantity);
      const defaultContentsValue = Number(entry.sub_order_entries_total_price || 0) || 0;

      bundle.boxQuantity += bundleQuantity;
      bundle.boxSalesTotal += entryTotalPrice;
      bundle.defaultContentsValueTotal += defaultContentsValue;

      if (customerName) {
        bundle.members.push({
          customerName,
          orderId,
          quantity: bundleQuantity
        });
      }

      for (const subEntry of entry.sub_order_entries) {
        const sourceVendor = lookupSourceVendor(subEntry, productVendorMap);
        const subEntryUnitQuantity = toPositiveNumber(
          subEntry.unit_quantity ?? subEntry.quantity_to_charge ?? subEntry.quantity,
          0
        );
        const quantity = subEntryUnitQuantity * bundleQuantity;
        if (quantity <= 0) continue;

        const boxUnitPrice = getSubEntryOrderUnitPrice(subEntry, quantity);
        const productUnitPrice = lookupPackagePrice(
          subEntry.product,
          subEntry.package_name,
          productData,
          subEntry.product_package
        );
        const unitPrice = productUnitPrice > 0 ? productUnitPrice : boxUnitPrice;
        const componentKey = [
          sourceVendor.vendor,
          subEntry.product,
          subEntry.product_package,
          normalizeText(subEntry.product_name),
          normalizeText(subEntry.package_name),
          unitPrice,
          boxUnitPrice
        ].join('|');

        if (!bundle.components.has(componentKey)) {
          const productName = normalizeText(subEntry.product_name);
          const packageName = normalizeText(subEntry.package_name);
          const itemUnit = normalizeText(
            subEntry.item_unit ||
            subEntry.item_unit_name ||
            subEntry.unit ||
            subEntry.charge_unit
          );
          bundle.components.set(componentKey, {
            sourceVendor: sourceVendor.vendor,
            sourceVendorMatched: sourceVendor.matched,
            productName,
            packageName,
            itemUnit,
            quantity: 0,
            unitPrice,
            boxUnitPrice,
            priceSource: productUnitPrice > 0 ? 'products export' : 'order box detail'
          });
        }

        const component = bundle.components.get(componentKey);
        component.quantity += quantity;
      }
    }
  }

  return [...bundleMap.values()]
    .map(bundle => ({
      bundleName: bundle.bundleName,
      bundlePackage: bundle.bundlePackage,
      boxBasePrice: bundle.boxBasePrice,
      boxQuantity: bundle.boxQuantity,
      boxSalesTotal: bundle.boxSalesTotal,
      defaultContentsValueTotal: bundle.defaultContentsValueTotal,
      members: bundle.members
        .sort((a, b) =>
          a.customerName.localeCompare(b.customerName) ||
          String(a.orderId).localeCompare(String(b.orderId))
        ),
      components: [...bundle.components.values()]
        .sort((a, b) =>
          a.sourceVendor.localeCompare(b.sourceVendor) ||
          a.productName.localeCompare(b.productName) ||
          a.packageName.localeCompare(b.packageName)
        )
        .map(component => ({
          ...component,
          product: formatBoxComponentProduct(component),
          totalPrice: component.unitPrice * component.quantity,
          boxTotalPrice: component.boxUnitPrice * component.quantity
        }))
    }))
    .map(bundle => {
      const componentBoxValueTotal = bundle.components.reduce((sum, component) => sum + component.boxTotalPrice, 0);
      const boxValueTotal = componentBoxValueTotal || bundle.defaultContentsValueTotal || 0;
      const vendorCostTotal = bundle.components.reduce((sum, component) => sum + component.totalPrice, 0);
      const memberPrice = bundle.boxQuantity > 0 ? bundle.boxSalesTotal / bundle.boxQuantity : 0;
      const defaultContentsValue = bundle.boxQuantity > 0 ? boxValueTotal / bundle.boxQuantity : 0;

      return {
        ...bundle,
        boxValueTotal,
        vendorCostTotal,
        memberPrice,
        defaultContentsValue,
        markupValue: memberPrice - defaultContentsValue,
        markupPercent:
          defaultContentsValue > 0
            ? ((memberPrice - defaultContentsValue) / defaultContentsValue) * 100
            : 0
      };
    })
    .sort((a, b) => a.bundleName.localeCompare(b.bundleName));
}

function buildBoxContentAdditions(bundleDetails, fulfillmentDate) {
  const additions = [];

  for (const bundle of bundleDetails) {
    for (const component of bundle.components) {
      if (component.sourceVendor === FULL_FARM_VENDOR) continue;

      additions.push({
        orderId: '',
        sourceProductName: component.productName,
        packageName: component.packageName,
        product: component.product,
        quantity: component.quantity,
        price: component.unitPrice,
        totalPrice: component.totalPrice,
        boxUnitPrice: component.boxUnitPrice,
        boxTotalPrice: component.boxTotalPrice,
        category: `${BOX_CONTENT_CATEGORY} - ${bundle.bundleName}`,
        fulfillmentDate,
        source: BOX_COMPONENT_SOURCE,
        sourceBox: `${bundle.bundleName} - ${bundle.bundlePackage}`,
        sourceVendorMatched: component.sourceVendorMatched,
        priceSource: component.priceSource,
        vendor: component.sourceVendor
      });
    }
  }

  return additions;
}

function addBoxContentAdditionsToVendorOrders(vendorOrders, additions) {
  for (const addition of additions) {
    if (!vendorOrders[addition.vendor]) {
      vendorOrders[addition.vendor] = [];
    }
    vendorOrders[addition.vendor].push(addition);
  }
}

function summarizeBoxContentAdditions(bundleDetails, additions, vendorEmails) {
  const vendorMap = new Map();
  const bundleMap = new Map();

  for (const addition of additions) {
    if (!vendorMap.has(addition.vendor)) {
      vendorMap.set(addition.vendor, {
        vendor: addition.vendor,
        lines: 0,
        quantity: 0,
        vendorCostTotal: 0,
        boxValueTotal: 0,
        hasEmail: Boolean(vendorEmails[addition.vendor] || (addition.vendor === FULL_FARM_VENDOR && FULL_FARM_EMAIL)),
        unmatchedVendorLookups: 0
      });
    }

    const vendorSummary = vendorMap.get(addition.vendor);
    vendorSummary.lines += 1;
    vendorSummary.quantity += addition.quantity;
    vendorSummary.vendorCostTotal += addition.totalPrice;
    vendorSummary.boxValueTotal += addition.boxTotalPrice;
    if (!addition.sourceVendorMatched) {
      vendorSummary.unmatchedVendorLookups += 1;
    }
  }

  for (const bundle of bundleDetails) {
    const boxName = `${bundle.bundleName} - ${bundle.bundlePackage}`;
    bundleMap.set(boxName, {
      boxName,
      boxQuantity: bundle.boxQuantity,
      vendorCostTotal: 0,
      boxValueTotal: 0,
      boxSalesTotal: bundle.boxSalesTotal
    });
  }

  for (const addition of additions) {
    const bundleSummary = bundleMap.get(addition.sourceBox);
    if (!bundleSummary) continue;
    bundleSummary.vendorCostTotal += addition.totalPrice;
    bundleSummary.boxValueTotal += addition.boxTotalPrice;
  }

  const vendorSummaries = [...vendorMap.values()]
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
  const bundleSummaries = [...bundleMap.values()]
    .sort((a, b) => a.boxName.localeCompare(b.boxName));

  return {
    bundleDetails,
    additions,
    vendorSummaries,
    bundleSummaries,
    totals: {
      bundles: bundleDetails.length,
      boxes: bundleDetails.reduce((sum, bundle) => sum + bundle.boxQuantity, 0),
      productLines: additions.length,
      vendors: vendorSummaries.length,
      quantity: additions.reduce((sum, addition) => sum + addition.quantity, 0),
      vendorCostTotal: additions.reduce((sum, addition) => sum + addition.totalPrice, 0),
      boxValueTotal: additions.reduce((sum, addition) => sum + addition.boxTotalPrice, 0),
      boxSalesTotal: bundleDetails.reduce((sum, bundle) => sum + bundle.boxSalesTotal, 0),
      unmatchedVendorLookups: additions.filter(addition => !addition.sourceVendorMatched).length,
      vendorsWithoutEmail: vendorSummaries.filter(summary => !summary.hasEmail).length
    }
  };
}

function buildBoxContentReport(bundleDetails, vendorEmails, fulfillmentDate) {
  const additions = buildBoxContentAdditions(bundleDetails, fulfillmentDate);
  return summarizeBoxContentAdditions(bundleDetails, additions, vendorEmails);
}

function getBoxContentAdditionsForVendor(boxContentReport, vendor) {
  if (!boxContentReport) return [];
  return boxContentReport.additions.filter(addition => addition.vendor === vendor);
}

function formatBoxContentEmailSummary(boxContentReport) {
  if (!boxContentReport || boxContentReport.totals.productLines === 0) {
    return 'No Full Farm CSA box component products were added to vendor orders for this fulfillment.';
  }

  const totals = boxContentReport.totals;
  const parts = [
    `Box content additions: added ${totals.productLines} product line(s) to ${totals.vendors} vendor order(s)`,
    `vendor cost $${formatMoney(totals.vendorCostTotal)}`,
    `box value $${formatMoney(totals.boxValueTotal)}`,
    `box sales $${formatMoney(totals.boxSalesTotal)}`
  ];

  if (totals.unmatchedVendorLookups > 0) {
    parts.push(`${totals.unmatchedVendorLookups} line(s) used fallback vendor names`);
  }
  if (totals.vendorsWithoutEmail > 0) {
    parts.push(`${totals.vendorsWithoutEmail} vendor(s) have no email in the vendor export`);
  }

  return parts.join('; ') + '.';
}

function addFullFarmNotesToPdf(doc, bundleDetails) {
  if (!bundleDetails.length) return;

  doc.moveDown(1);
  doc.fontSize(14).text('FFCSA Notes', { bold: true });
  doc.moveDown(0.2);
  doc.fontSize(10).text(
    'Bundle component note: The bundle items below were expanded from Local Line order details. Non-FFCSA components are added to the source vendor fulfillment sheets under Box Contents.'
  );
  doc.moveDown(0.2);
  doc.fontSize(10).text(
    'Members shown below ordered the bundle listed in the main table. Vendor prices come from the current products export when package IDs match, then fall back to the component price saved on the order.'
  );

  for (const bundle of bundleDetails) {
    doc.moveDown(0.8);
    doc.fontSize(12).text(
      `${bundle.bundleName} - ${bundle.bundlePackage}`,
      { bold: true }
    );
    doc.moveDown(0.2);
    doc.table({
      headers: ['Metric', 'Amount'],
      rows: [
        ['Boxes sold', formatQuantity(bundle.boxQuantity)],
        ['Configured box price/unit', formatMoney(bundle.boxBasePrice)],
        ['Box sales total', formatMoney(bundle.boxSalesTotal)],
        ['Box contents value total', formatMoney(bundle.boxValueTotal)],
        ['Component vendor cost total', formatMoney(bundle.vendorCostTotal)],
        ['Member price/unit', formatMoney(bundle.memberPrice)],
        ['Contents value/unit', formatMoney(bundle.defaultContentsValue)],
        ['Markup/unit', `${formatMoney(bundle.markupValue)} (${formatMoney(bundle.markupPercent)}%)`]
      ]
    });
    doc.moveDown(0.1);
    if (bundle.members.length) {
      doc.fontSize(10).text('Members:');
      for (const member of bundle.members) {
        const qtyText = member.quantity > 1 ? ` x${member.quantity}` : '';
        doc.text(`- ${member.customerName} (Order ${member.orderId})${qtyText}`);
      }
    } else {
      doc.fontSize(10).text('Members: None listed');
    }
    doc.moveDown(0.2);

    const rows = bundle.components.map(component => [
      `${component.sourceVendor} - ${component.productName} - ${component.packageName}`,
      formatQuantity(component.quantity),
      formatMoney(component.unitPrice),
      formatMoney(component.totalPrice),
      formatMoney(component.boxUnitPrice),
      formatMoney(component.boxTotalPrice)
    ]);

    doc.table({
      headers: ['Product', 'Qty', 'Vendor Price', 'Vendor Total', 'Box Price', 'Box Total'],
      rows
    });
  }
}

function addBoxContentAuditToPdf(doc, boxContentReport) {
  if (!boxContentReport || !boxContentReport.bundleDetails.length) return;

  doc.addPage();
  doc.fontSize(16).text('Box Content Additions', { bold: true });
  doc.moveDown(0.2);
  doc.fontSize(10).text(formatBoxContentEmailSummary(boxContentReport));

  if (boxContentReport.totals.productLines === 0) {
    doc.moveDown(0.4);
    doc.text('No non-FFCSA box components were added to vendor fulfillment sheets.');
    return;
  }

  doc.moveDown(0.6);
  doc.fontSize(12).text('Vendor Summary', { bold: true });
  doc.table({
    headers: ['Vendor', 'Lines', 'Qty', 'Vendor Cost', 'Box Value', 'Email?'],
    rows: boxContentReport.vendorSummaries.map(summary => [
      summary.vendor,
      summary.lines,
      formatQuantity(summary.quantity),
      formatMoney(summary.vendorCostTotal),
      formatMoney(summary.boxValueTotal),
      summary.hasEmail ? 'Yes' : 'No'
    ])
  });

  doc.moveDown(0.5);
  doc.fontSize(12).text('Box Summary', { bold: true });
  doc.table({
    headers: ['Box', 'Qty Sold', 'Added Vendor Cost', 'Added Box Value', 'Box Sales'],
    rows: boxContentReport.bundleSummaries.map(summary => [
      summary.boxName,
      formatQuantity(summary.boxQuantity),
      formatMoney(summary.vendorCostTotal),
      formatMoney(summary.boxValueTotal),
      formatMoney(summary.boxSalesTotal)
    ])
  });

  for (const bundle of boxContentReport.bundleDetails) {
    const sourceBox = `${bundle.bundleName} - ${bundle.bundlePackage}`;
    const additions = boxContentReport.additions.filter(addition => addition.sourceBox === sourceBox);
    if (!additions.length) continue;

    doc.moveDown(0.6);
    doc.fontSize(12).text(sourceBox, { bold: true });
    doc.table({
      headers: ['Vendor', 'Product', 'Qty', 'Vendor Price', 'Vendor Total', 'Box Price', 'Box Total'],
      rows: additions.map(addition => [
        addition.vendor,
        addition.product,
        formatQuantity(addition.quantity),
        formatMoney(addition.price),
        formatMoney(addition.totalPrice),
        formatMoney(addition.boxUnitPrice),
        formatMoney(addition.boxTotalPrice)
      ])
    });
  }
}

// Generate summary PDF
async function generateSummaryPDF(vendorOrders, outputFile, boxContentReport = null) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(outputFile);

    doc.pipe(stream);

    const vendorNames = Object.keys(vendorOrders).filter(vendor => vendorOrders[vendor].length > 0);
    const fulfillmentDate = vendorNames.length
      ? vendorOrders[vendorNames[0]][0].fulfillmentDate
      : null;

    const drawPageHeader = () => {
      if (!fulfillmentDate) return;
      const previousFontSize = doc._fontSize || 12;
      const previousX = doc.x;
      const previousY = doc.y;
      const headerFontSize = 16;

      doc.fontSize(headerFontSize);
      const headerHeight = doc.currentLineHeight();
      const headerY = Math.max(0, doc.page.margins.top - headerHeight);
      const headerX = doc.page.margins.left;
      const headerWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      doc.text(fulfillmentDate, headerX, headerY, { align: 'right', width: headerWidth });
      doc.fontSize(previousFontSize);
      doc.x = previousX;
      doc.y = previousY;
    };

    doc.on('pageAdded', drawPageHeader);
    drawPageHeader();

    vendorNames.forEach((vendor, i) => {
      const items = vendorOrders[vendor];
      if (!items || items.length === 0) return;

      doc.fontSize(16).text(vendor, { bold: true });

      const rows = groupByCategoryWithSubtotals(items);

      const table = {
        headers: ['Product', 'Quantity', 'Price', 'Total Price'],
        rows: rows
      };

      // Generate the table and total
      doc.table(table);
      const total = items.reduce((sum, item) => sum + item.totalPrice, 0);
      doc.text('Total Price ' + total.toFixed(2), { align: 'right', bold: true });

      // Only add a new page if it's not the last vendor
      if (i < vendorNames.length - 1) {
        doc.addPage();
      }
    });

    addBoxContentAuditToPdf(doc, boxContentReport);

    doc.end();

    stream.on('finish', () => {
      console.log("✅ PDF generation complete.");
      resolve(outputFile);
    });

    stream.on('error', err => {
      console.error("❌ PDF generation error:", err);
      reject(err);
    });
  });
}

// Send vendor-specific emails
async function sendVendorEmails(
  vendorOrders,
  vendorEmails,
  fulfillmentDate,
  testing = false,
  boxContentReport = null
) {
  for (const [vendor, items] of Object.entries(vendorOrders)) {
    let email = vendorEmails[vendor];
    if (vendor === FULL_FARM_VENDOR) {
      email = FULL_FARM_EMAIL;
    }
    if (!items.length) continue;

    // In normal mode, skip vendors without an email
    if (!email && !testing) continue;

    const doc = new PDFDocument();
    doc.fontSize(16).text('Fulfillment Sheet for Full Farm CSA, LLC', { align: 'right' });
    doc.fontSize(16).text(utilities.getToday(), { align: 'right' });
    doc.fontSize(16).text(vendor, { bold: true });

    const rows = groupByCategoryWithSubtotals(items);
    const table = {
      headers: ['Product', 'Quantity', 'Price', 'Total Price'],
      rows
    };

    const sumTotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
    doc.table(table);
    doc.text('Total Price ' + sumTotal.toFixed(2), { align: 'right', bold: true });

    const vendorBoxAdditions = getBoxContentAdditionsForVendor(boxContentReport, vendor);
    if (vendorBoxAdditions.length && vendor !== FULL_FARM_VENDOR) {
      doc.moveDown(0.4);
      doc.fontSize(10).text(
        `Box Contents note: ${vendorBoxAdditions.length} line(s) in this report were added from Full Farm CSA box orders.`
      );
    }

    const bundleDetails = boxContentReport ? boxContentReport.bundleDetails : [];
    if (vendor === FULL_FARM_VENDOR && bundleDetails.length) {
      addFullFarmNotesToPdf(doc, bundleDetails);
    }

    // 🔹 Testing mode: send ONLY to jdeck88@gmail.com
    const toAddress = testing ? 'jdeck88@gmail.com' : email;
    const fromAddress = testing ? 'jdeck88@gmail.com' : 'fullfarmcsa@deckfamilyfarm.com';
    const ccAddress =
      testing || toAddress === FULL_FARM_EMAIL ? undefined : FULL_FARM_EMAIL;

    let messageText = testing
      ? `TESTING MODE: This fulfillment report would normally go to ${email || '(no email on file)'} for vendor "${vendor}".`
      : 'The attached PDF contains the Full Farm CSA Order for the next fulfillment cycle. Please reply with questions.';

    if (vendor === FULL_FARM_VENDOR && bundleDetails.length) {
      messageText += '\n\nBundle component details are included in the FFCSA notes section of the attached PDF.';
    }
    if (vendorBoxAdditions.length && vendor !== FULL_FARM_VENDOR) {
      messageText += `\n\nThis fulfillment report includes ${vendorBoxAdditions.length} line(s) added from Full Farm CSA box contents. These are grouped under Box Contents in the attached PDF.`;
    }

    const mailOptions = {
      from: fromAddress,
      to: toAddress,
      cc: ccAddress,
      bcc: testing ? undefined : 'jdeck88@gmail.com',
      subject: `${testing ? '[TEST] ' : ''}FFCSA Reports: Vendor Fulfillments for ${vendor} - ${utilities.getToday()}`,
      text: messageText
    };

    try {
      await utilities.mailADocument(doc, mailOptions, 'vendor_fulfillment.pdf');
    } catch (err) {
      console.error(`Failed to send to ${vendor}:`, err.message);
    }

    await new Promise(res => setTimeout(res, 3000)); // delay between sends
  }
}

// Main
async function runVendorReports(fulfillmentDate, testing = false) {
  const productsFile = 'data/products.xlsx';
  const vendorsFile = 'data/vendors.csv';
  const pdfFile = 'data/vendors.pdf';

  try {
    // 🔹 Get the orders CSV (do NOT overwrite if it already exists)
    const orderFile = await utilities.downloadOrdersCsv(
      fulfillmentDate.start, // fulfillment_date_start
      fulfillmentDate.end, // fulfillment_date_end
      false            // overwrite = false
    );

    // You can still get a token for the other exports
    const token = JSON.parse(await utilities.getAccessToken()).access;

    // Download products + vendors (these still overwrite as before)
    await Promise.all([
      utilities.downloadBinaryData(
        'https://localline.ca/api/backoffice/v2/products/export/?direct=true',
        productsFile,
        token
      ),
      utilities.downloadBinaryData(
        'https://localline.ca/api/backoffice/v2/vendors/export/?direct=true',
        vendorsFile,
        token
      )
    ]);

    const vendorEmails = await readVendorsCSV(vendorsFile);
    const productData = await readVendorProductsExcel(productsFile);
    const productVendorMap = await readProductVendorMapExcel(productsFile);
    const vendorOrders = await groupOrdersByVendor(orderFile, productData, fulfillmentDate.date);
    const bundleDetails = await buildFullFarmBundleDetails(
      vendorOrders[FULL_FARM_VENDOR] || [],
      token,
      productVendorMap,
      productData
    );
    const boxContentReport = buildBoxContentReport(bundleDetails, vendorEmails, fulfillmentDate.date);
    addBoxContentAdditionsToVendorOrders(vendorOrders, boxContentReport.additions);
    console.log(formatBoxContentEmailSummary(boxContentReport));

    await sendVendorEmails(
      vendorOrders,
      vendorEmails,
      fulfillmentDate.date,
      testing,
      boxContentReport
    );
    const summaryPDF = await generateSummaryPDF(vendorOrders, pdfFile, boxContentReport);

    const summaryMail = {
      from: 'jdeck88@gmail.com',
      to: testing ? 'jdeck88@gmail.com' : 'fullfarmcsa@deckfamilyfarm.com',
      cc: testing ? undefined : 'jdeck88@gmail.com',
      subject: `${testing ? '[TEST] ' : ''}FFCSA Reports: All Vendor Data for ${fulfillmentDate.date}`,
      text: `${testing
        ? 'TESTING MODE: This is the consolidated vendor report. In production this would go to fullfarmcsa@deckfamilyfarm.com.'
        : 'Please see the attached file. Reports are generated twice per week in advance of fulfillment dates.'}\n\n${formatBoxContentEmailSummary(boxContentReport)}`,
      attachments: [{ filename: 'vendors.pdf', content: fs.readFileSync(summaryPDF) }]
    };

    await utilities.sendEmail(summaryMail);
  } catch (err) {
    console.error('Error during vendor report generation:', err);
    utilities.sendErrorEmail(`Vendor report failed:\n\n${err.stack || err.message || err}`);
  }
}

// 🔹 TESTING flag – set to true to send ALL emails ONLY to jdeck88@gmail.com
const TESTING = false;

// Run it
const fulfillment = utilities.getNextFullfillmentDate();
runVendorReports(fulfillment, TESTING);
