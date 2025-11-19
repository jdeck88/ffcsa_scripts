const fs = require('fs');
const path = require('path');
require('dotenv').config();
const fastcsv = require('fast-csv');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit-table');
const utilities = require('./utilities');

/* ------------------------------------------------
 * Date helpers
 * ------------------------------------------------ */

function formatYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseYMD(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Given a reference date string (YYYY-MM-DD) or nothing,
 * return the start/end Date objects for the LAST FULL MONTH.
 *
 * Example: ref = 2025-11-18 -> last full month = 2025-10-01..2025-10-31
 */
function getLastFullMonthRange(refDateStr) {
  const ref = refDateStr ? parseYMD(refDateStr) : new Date();

  const firstOfThisMonth = new Date(ref.getFullYear(), ref.getMonth(), 1);

  const start = new Date(firstOfThisMonth);
  start.setMonth(start.getMonth() - 1);

  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);

  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  return {
    start,
    end,
    startStr: formatYMD(start),
    endStr: formatYMD(end),
  };
}

/* ------------------------------------------------
 * Downloads (orders + products)
 * ------------------------------------------------ */

async function downloadMonthlyOrdersCsv(fulfillmentDateStart, fulfillmentDateEnd, accessToken) {
  if (!fs.existsSync('data')) {
    fs.mkdirSync('data', { recursive: true });
  }

  const fileName = `orders_list_${fulfillmentDateStart}_to_${fulfillmentDateEnd}.csv`;
  const outPath = path.join('data', fileName);

  console.log(`⬇️ Downloading orders list for ${fulfillmentDateStart} -> ${fulfillmentDateEnd}`);

  const url =
    'https://localline.ca/api/backoffice/v2/orders/export/?' +
    'file_type=orders_list_view&send_to_email=false&destination_email=fullfarmcsa%40deckfamilyfarm.com&direct=true&' +
    `fulfillment_date_start=${fulfillmentDateStart}&` +
    `fulfillment_date_end=${fulfillmentDateEnd}&` +
    '&status=OPEN'; // tweak statuses if you want CLOSED/CANCELLED, etc.

  const data = await utilities.getRequestID(url, accessToken);
  const id = JSON.parse(data).id;

  const orders_result_url = await utilities.pollStatus(id, accessToken);

  if (orders_result_url && orders_result_url !== "") {
    await utilities.downloadData(orders_result_url, fileName); // writes to data/<fileName>
    console.log(`✅ Orders CSV saved to ${outPath}`);
    return outPath;
  } else {
    throw new Error('Orders export URL empty or undefined');
  }
}

async function downloadProductsExcel(accessToken, fulfillmentDateEnd) {
  // Ensure data directory exists
  if (!fs.existsSync("data")) {
    fs.mkdirSync("data", { recursive: true });
  }

  const productsFile = `data/products_${fulfillmentDateEnd}.xlsx`;

  // ✅ Check if file already exists
  if (fs.existsSync(productsFile)) {
    console.log(`⚠️ Products file already exists: ${productsFile}`);
    console.log("⏭️ Skipping download to avoid overwrite.");
    return productsFile; // return path without re-downloading
  }

  // Otherwise, proceed with download
  await utilities.downloadBinaryData(
    "https://localline.ca/api/backoffice/v2/products/export/?direct=true",
    productsFile,
    accessToken
  );

  console.log(`✅ Products Excel saved to ${productsFile}`);
  return productsFile;
}

/* ------------------------------------------------
 * Product price helpers (Package ID join)
 * ------------------------------------------------ */

function normalizePackageId(value) {
  if (value === null || value === undefined) return null;

  // Try numeric first so that 695001.0 → "695001"
  const num = Number(value);
  if (!Number.isNaN(num)) {
    return String(Math.trunc(num));
  }

  return String(value).trim();
}

/**
 * Build a map: packageIdStr -> packagePrice
 * using the "Packages and pricing" tab.
 */
async function buildPackagePriceMap(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  // Prefer by name, fall back to index 2
  const ws =
    workbook.getWorksheet('Packages and pricing') ||
    workbook.getWorksheet(2);

  if (!ws) {
    throw new Error('Could not find "Packages and pricing" worksheet');
  }

  const headerRow = ws.getRow(1).values;

  // Build a lookup: normalized header -> original header text
  const headerMap = {};
  for (let j = 1; j < headerRow.length; j++) {
    const raw = headerRow[j];
    if (!raw) continue;
    const norm = String(raw).toLowerCase().replace(/\s+/g, '');
    headerMap[norm] = raw;
  }

  const packageIdHeader = headerMap['packageid'];
  const packagePriceHeader = headerMap['packageprice'];

  if (!packageIdHeader || !packagePriceHeader) {
    throw new Error(
      `Could not find "Package ID" or "Package Price" headers. Found headers: ${Object.values(headerMap).join(', ')}`
    );
  }

  const map = {};
  let rowCount = 0;

  for (let i = 2; i <= ws.actualRowCount; i++) {
    const row = ws.getRow(i).values;
    const obj = {};

    for (let j = 1; j < headerRow.length; j++) {
      obj[headerRow[j]] = row[j];
    }

    const rawId = obj[packageIdHeader];
    const price = obj[packagePriceHeader];

    const key = normalizePackageId(rawId);
    if (!key || price === null || price === undefined || price === '') continue;

    const numPrice = Number(price);
    if (Number.isNaN(numPrice)) continue;

    map[key] = numPrice;
    rowCount++;
  }

  console.log(
    `🔎 Built packagePriceMap with ${Object.keys(map).length} entries (rows processed: ${rowCount})`
  );
  return map;
}

/* ------------------------------------------------
 * Aggregation: vendor-level summary
 * ------------------------------------------------ */

function computeEffectiveQuantity(row) {
  // Start from Quantity
  let quantity = Number(row['Quantity']);
  if (Number.isNaN(quantity)) quantity = 0;

  // Round to avoid 1.00000001 cases
  quantity = Math.round(quantity);

  // Look at # of Items as a *fix* for the weird 1 vs N case
  let numItems = Number(row['# of Items']);
  if (Number.isNaN(numItems)) numItems = 0;
  numItems = Math.round(numItems);

  // Your original logic: if # of Items > 1 and quantity == 1, trust # of Items
  if (numItems > 1 && quantity === 1) {
    quantity = numItems;
  }

  return quantity;
}

/**
 * Read the monthly orders CSV, and aggregate by vendor:
 * - RetailSales: sum of "Product Subtotal"
 * - PurchaseCost: sum of (Package Price * effective quantity)
 */
async function aggregateMonthlyVendorData(ordersCsvPath, packagePriceMap) {
  return new Promise((resolve, reject) => {
    const summaryByVendor = {};
    let matchedLines = 0;
    let unmatchedLines = 0;

    fs.createReadStream(ordersCsvPath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', row => {
        try {
          const vendor = row['Vendor'];
          if (!vendor) return;

          if (row['Category'] === 'Membership') return;

          if (!summaryByVendor[vendor]) {
            summaryByVendor[vendor] = {
              vendor,
              retailSales: 0,
              purchaseCost: 0
            };
          }

          const effectiveQty = computeEffectiveQuantity(row);
          if (!effectiveQty || effectiveQty <= 0) return;

          // Retail: Product Subtotal
          const retailTotal = Number(row['Product Subtotal'] || 0) || 0;

          // Purchase: Package Price from map
          const packageId = normalizePackageId(row['Package ID']);
          const purchaseUnitPrice = packageId ? packagePriceMap[packageId] || 0 : 0;
          const purchaseTotal = purchaseUnitPrice * effectiveQty;

          if (purchaseUnitPrice > 0) {
            matchedLines++;
          } else {
            unmatchedLines++;
          }

          summaryByVendor[vendor].retailSales += retailTotal;
          summaryByVendor[vendor].purchaseCost += purchaseTotal;
        } catch (e) {
          console.error('Row parse error:', e.message);
        }
      })
      .on('end', () => {
        console.log(`ℹ️ Lines with matched package price: ${matchedLines}`);
        console.log(`ℹ️ Lines with NO package price match: ${unmatchedLines}`);

        const results = Object.values(summaryByVendor).map(v => {
          const markupAmount = v.retailSales - v.purchaseCost;
          const markupPercent =
            v.purchaseCost > 0 ? (markupAmount / v.purchaseCost) * 100 : 0;

          return {
            vendor: v.vendor,
            retailSales: v.retailSales,
            purchaseCost: v.purchaseCost,
            markupAmount,
            markupPercent
          };
        });

        // Sort by largest retail sales first, then vendor name
        results.sort((a, b) => {
          if (b.retailSales !== a.retailSales) {
            return b.retailSales - a.retailSales;
          }
          return a.vendor.localeCompare(b.vendor);
        });

        resolve(results);
      })
      .on('error', reject);
  });
}

/* ------------------------------------------------
 * CSV + PDF output
 * ------------------------------------------------ */

async function writeVendorSummaryCsv(summary, outFile) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outFile);
    const csvStream = fastcsv.format({ headers: true });

    csvStream.pipe(ws)
      .on('finish', resolve)
      .on('error', reject);

    for (const row of summary) {
      csvStream.write({
        Vendor: row.vendor,
        RetailSales: row.retailSales.toFixed(2),
        PurchaseCost: row.purchaseCost.toFixed(2),
        MarkupAmount: row.markupAmount.toFixed(2),
        MarkupPercent: row.markupPercent.toFixed(2)
      });
    }

    csvStream.end();
  });
}

async function generateSummaryPDF(summary, pdfPath, startStr, endStr) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30 });
    const stream = fs.createWriteStream(pdfPath);

    doc.pipe(stream);

    // Derive month name from startStr (YYYY-MM-DD)
    const [year, month] = startStr.split('-').map(Number);
    const monthName = new Date(year, month - 1, 1).toLocaleString('en-US', {
      month: 'long'
    });

    // Title + date range
    doc.fontSize(16).text(`${monthName} Vendor Reports`, { align: 'left' });
    doc.fontSize(12).text(`${startStr} to ${endStr}`, { align: 'left' });
    doc.moveDown();

    // ---- Column totals ----
    const totalRetail = summary.reduce((sum, row) => sum + row.retailSales, 0);
    const totalPurchase = summary.reduce((sum, row) => sum + row.purchaseCost, 0);
    const totalMarkup = summary.reduce((sum, row) => sum + row.markupAmount, 0);
    const totalMarkupPct =
      totalPurchase > 0 ? (totalMarkup / totalPurchase) * 100 : 0;

    // Build rows including a final TOTAL row
    const rows = summary.map(row => [
      row.vendor,
      row.retailSales.toFixed(2),
      row.purchaseCost.toFixed(2),
      row.markupAmount.toFixed(2),
      row.markupPercent.toFixed(2) + '%'
    ]);

    // Add a blank spacer row (optional) then TOTAL row
    rows.push([
      '', '', '', '', ''  // spacer row
    ]);
    rows.push([
      'TOTAL',
      totalRetail.toFixed(2),
      totalPurchase.toFixed(2),
      totalMarkup.toFixed(2),
      totalMarkupPct.toFixed(2) + '%'
    ]);

    const table = {
      headers: ['Vendor', 'Retail Sales', 'Purchase Cost', 'Markup', 'Markup %'],
      rows
    };

    doc.table(table);

    doc.end();

    stream.on('finish', () => {
      console.log(`✅ Wrote PDF summary: ${pdfPath}`);
      resolve(pdfPath);
    });
    stream.on('error', reject);
  });
}

/* ------------------------------------------------
 * Email the PDF result
 * ------------------------------------------------ */

async function emailSummaryPdf(pdfPath, startStr, endStr) {
  const mailOptions = {
    from: 'fullfarmcsa@deckfamilyfarm.com',
    to: 'jan.deckfamilyfarm@gmail.com',
    cc: 'jdeck88@gmail.com',
    subject: `FFCSA Vendor Monthly Summary ${startStr} to ${endStr}`,
    text: `Attached is the vendor monthly summary for ${startStr} to ${endStr}.`,
    attachments: [
      {
        filename: path.basename(pdfPath),
        content: fs.readFileSync(pdfPath)
      }
    ]
  };

  await utilities.sendEmail(mailOptions);
  console.log('📧 Sent vendor monthly summary email.');
}

/* ------------------------------------------------
 * Main
 * ------------------------------------------------ */

async function main() {
  const refDateStr = process.argv[2]; // optional YYYY-MM-DD
  const { start, end, startStr, endStr } = getLastFullMonthRange(refDateStr);

  console.log(`📆 Monthly vendor summary for last full month: ${startStr} to ${endStr}`);

  try {
    const token = JSON.parse(await utilities.getAccessToken()).access;

    const [productsFile, ordersCsvPath] = await Promise.all([
      downloadProductsExcel(token, endStr),
      downloadMonthlyOrdersCsv(startStr, endStr, token)
    ]);

    const packagePriceMap = await buildPackagePriceMap(productsFile);
    const summary = await aggregateMonthlyVendorData(ordersCsvPath, packagePriceMap);

    if (!summary.length) {
      console.log('⚠️ No vendor orders found for that month range.');
      return;
    }

    const csvPath = path.join(
      'data',
      `vendor_monthly_summary_${startStr}_to_${endStr}.csv`
    );
    await writeVendorSummaryCsv(summary, csvPath);

    const pdfPath = path.join(
      'data',
      `vendor_monthly_summary_${startStr}_to_${endStr}.pdf`
    );
    await generateSummaryPDF(summary, pdfPath, startStr, endStr);

    await emailSummaryPdf(pdfPath, startStr, endStr);

    console.log('✅ Done. Example row:', summary[0]);
  } catch (err) {
    console.error('❌ Error during vendor monthly summary:', err);
    if (utilities && typeof utilities.sendErrorEmail === 'function') {
      utilities.sendErrorEmail(
        `Monthly Vendor summary failed:\n\n${err.stack || err.message || err}`
      );
    }
  }
}

/* CLI entrypoint */
main()
  .then(() => {
    console.log('✅ Monthly vendor summary completed.');
    // Give stdout a brief chance to flush, then exit
    setTimeout(() => process.exit(0), 100);
  })
  .catch(err => {
    console.error('❌ Fatal error in vendor monthly summary:', err);
    setTimeout(() => process.exit(1), 100);
  });

