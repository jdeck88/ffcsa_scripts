const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const ExcelJS = require('exceljs');
const utilities = require('./utilities');

const FULL_FARM_VENDOR = 'Full Farm CSA';
const FULL_FARM_EMAIL = 'fullfarmcsa@deckfamilyfarm.com';

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isNaN(num)) {
    return String(Math.trunc(num));
  }
  return String(value).trim();
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return amount.toFixed(2);
}

function normalizeText(value) {
  return String(value || '').trim();
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

function lookupPackagePrice(productID, packageName, productsData) {
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
            const lookupPrice = lookupPackagePrice(parseInt(row['Product ID'], 10), row['Package Name'], productData);
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

      const bundleKey = `${entry.product_name}|${entry.package_name}`;
      if (!bundleMap.has(bundleKey)) {
        const boxBasePrice = lookupPackagePrice(entry.product, entry.package_name, productData);
        const defaultContentsValue = Number(entry.sub_order_entries_total_price || 0);
        const memberPrice = Number(entry.total_price || entry.price || 0);
        bundleMap.set(bundleKey, {
          bundleName: entry.product_name,
          bundlePackage: entry.package_name,
          boxBasePrice,
          defaultContentsValue,
          memberPrice,
          members: [],
          components: new Map()
        });
      }

      const bundle = bundleMap.get(bundleKey);
      const bundleQuantity = Number(
        entry.quantity_to_charge ?? entry.unit_quantity ?? 1
      );

      if (customerName) {
        bundle.members.push({
          customerName,
          orderId,
          quantity: bundleQuantity
        });
      }

      for (const subEntry of entry.sub_order_entries) {
        const sourceVendor =
          productVendorMap[normalizeId(subEntry.product)] ||
          productVendorMap[normalizeId(subEntry.product_package)] ||
          `Vendor ${subEntry.vendor}`;
        const unitPrice = Number(subEntry.package_unit_price ?? subEntry.price ?? 0);
        const quantity = Number(subEntry.unit_quantity || 0) * bundleQuantity;
        const componentKey = [
          sourceVendor,
          subEntry.product_name,
          subEntry.package_name,
          unitPrice
        ].join('|');

        if (!bundle.components.has(componentKey)) {
          bundle.components.set(componentKey, {
            sourceVendor,
            productName: subEntry.product_name,
            packageName: subEntry.package_name,
            quantity: 0,
            unitPrice
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
      defaultContentsValue: bundle.defaultContentsValue,
      memberPrice: bundle.memberPrice,
      markupValue: bundle.memberPrice - bundle.defaultContentsValue,
      markupPercent:
        bundle.defaultContentsValue > 0
          ? ((bundle.memberPrice - bundle.defaultContentsValue) / bundle.defaultContentsValue) * 100
          : 0,
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
          totalPrice: component.unitPrice * component.quantity
        }))
    }))
    .sort((a, b) => a.bundleName.localeCompare(b.bundleName));
}

function addFullFarmNotesToPdf(doc, bundleDetails) {
  if (!bundleDetails.length) return;

  doc.moveDown(1);
  doc.fontSize(14).text('FFCSA Notes', { bold: true });
  doc.moveDown(0.2);
  doc.fontSize(10).text(
    'Bundle component note: The bundle items below were expanded from Local Line order details. These constituent products may need to be invoiced separately by the source vendors.'
  );
  doc.moveDown(0.2);
  doc.fontSize(10).text(
    'Members shown below ordered the bundle listed in the main table. Source prices are the component prices saved on the order. Box base price is inferred from the current configured bundle price in the products export.'
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
        ['Box base price', formatMoney(bundle.boxBasePrice)],
        ['Default contents value', formatMoney(bundle.defaultContentsValue)],
        ['Member price', formatMoney(bundle.memberPrice)],
        ['Markup', `${formatMoney(bundle.markupValue)} (${formatMoney(bundle.markupPercent)}%)`]
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
      component.quantity,
      formatMoney(component.unitPrice),
      formatMoney(component.totalPrice)
    ]);

    doc.table({
      headers: ['Product', 'Qty', 'Price', 'Total Price'],
      rows
    });
  }
}

// Generate summary PDF
async function generateSummaryPDF(vendorOrders, outputFile) {
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
  productData,
  fulfillmentDate,
  accessToken,
  productVendorMap,
  testing = false
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

    let bundleDetails = [];
    if (vendor === FULL_FARM_VENDOR) {
      bundleDetails = await buildFullFarmBundleDetails(items, accessToken, productVendorMap, productData);
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

    await sendVendorEmails(
      vendorOrders,
      vendorEmails,
      productData,
      fulfillmentDate.date,
      token,
      productVendorMap,
      testing
    );
    const summaryPDF = await generateSummaryPDF(vendorOrders, pdfFile);

    const summaryMail = {
      from: 'jdeck88@gmail.com',
      to: testing ? 'jdeck88@gmail.com' : 'fullfarmcsa@deckfamilyfarm.com',
      cc: testing ? undefined : 'jdeck88@gmail.com',
      subject: `${testing ? '[TEST] ' : ''}FFCSA Reports: All Vendor Data for ${fulfillmentDate.date}`,
      text: testing
        ? 'TESTING MODE: This is the consolidated vendor report. In production this would go to fullfarmcsa@deckfamilyfarm.com.'
        : 'Please see the attached file. Reports are generated twice per week in advance of fulfillment dates.',
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
