const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const utilities = require('./utilities');
const { aggregateVendorSummaryFromOrders, writeVendorSummaryCsv } = require('./order_pricing');

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
  const refDateStr = process.argv.slice(2).find(arg => !arg.startsWith('--')); // optional YYYY-MM-DD
  const { start, end, startStr, endStr } = getLastFullMonthRange(refDateStr);

  console.log(`📆 Monthly vendor summary for last full month: ${startStr} to ${endStr}`);

  try {
    const token = JSON.parse(await utilities.getAccessToken()).access;

    const ordersCsvPath = await downloadMonthlyOrdersCsv(startStr, endStr, token);
    const summary = await aggregateVendorSummaryFromOrders(ordersCsvPath, token);

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

    if (!process.argv.includes('--dry-run')) await emailSummaryPdf(pdfPath, startStr, endStr);

    console.log('✅ Done. Example row:', summary[0]);
  } catch (err) {
    process.exitCode = 1;
    console.error('❌ Error during vendor monthly summary:', err);
    if (!process.argv.includes('--dry-run') && utilities && typeof utilities.sendErrorEmail === 'function') {
      utilities.sendErrorEmail(
        `Monthly Vendor summary failed:\n\n${err.stack || err.message || err}`
      );
    }
  }
}

/* CLI entrypoint */
if (require.main === module) main()
  .then(() => {
    console.log('✅ Monthly vendor summary completed.');
    // Give stdout a brief chance to flush, then exit
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  })
  .catch(err => {
    console.error('❌ Fatal error in vendor monthly summary:', err);
    setTimeout(() => process.exit(1), 100);
  });
