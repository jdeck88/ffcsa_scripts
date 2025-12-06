const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const ExcelJS = require('exceljs');
const utilities = require('./utilities');


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

function lookupPackagePrice(productID, packageName, productsData) {
  const match = productsData.find(p => p['Local Line Product ID'] === productID && p['Package Name'] === packageName);
  return match ? parseFloat(match['Package Price']) : 0;
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
            const price = lookupPackagePrice(parseInt(row['Product ID'], 10), row['Package Name'], productData);
            const totalPrice = price * quantity;

            orders[vendor].push({
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

// Generate summary PDF
async function generateSummaryPDF(vendorOrders, outputFile) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(outputFile);

    doc.pipe(stream);

    const vendorNames = Object.keys(vendorOrders).filter(vendor => vendorOrders[vendor].length > 0);

    vendorNames.forEach((vendor, i) => {
      const items = vendorOrders[vendor];
      if (!items || items.length === 0) return;

      doc.fontSize(16).text(items[0].fulfillmentDate.date, { align: 'right' });
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
async function sendVendorEmails(vendorOrders, vendorEmails, productData, fulfillmentDate, testing = false) {
  for (const [vendor, items] of Object.entries(vendorOrders)) {
    let email = vendorEmails[vendor];
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

    // 🔹 Testing mode: send ONLY to jdeck88@gmail.com
    const toAddress = testing ? 'jdeck88@gmail.com' : email;
    const fromAddress = testing ? 'jdeck88@gmail.com' : 'fullfarmcsa@deckfamilyfarm.com';

    const mailOptions = {
      from: fromAddress,
      to: toAddress,
      cc: testing ? undefined : 'fullfarmcsa@deckfamilyfarm.com',
      bcc: testing ? undefined : 'jdeck88@gmail.com',
      subject: `${testing ? '[TEST] ' : ''}FFCSA Reports: Vendor Fulfillments for ${vendor} - ${utilities.getToday()}`,
      text: testing
        ? `TESTING MODE: This fulfillment report would normally go to ${email || '(no email on file)'} for vendor "${vendor}".`
        : 'The attached PDF contains the Full Farm CSA Order for the next fulfillment cycle. Please reply with questions.'
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
    const vendorOrders = await groupOrdersByVendor(orderFile, productData, fulfillmentDate.date);

    await sendVendorEmails(vendorOrders, vendorEmails, productData, fulfillmentDate.date, testing);
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
