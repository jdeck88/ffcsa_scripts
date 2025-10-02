// monthly_vendors.js
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const utilities = require('./utilities');

/**
 * Build the Vendors PDF from a CSV file and resolve with the PDF file path
 */
async function buildVendorsPdf(csvFile, lastDay) {
  return new Promise((resolve, reject) => {
    try {
      const pdfFile = path.join('data', `vendors_${lastDay}.pdf`);
      fs.mkdirSync(path.dirname(pdfFile), { recursive: true });

      const doc = new PDFDocument();
      const out = fs.createWriteStream(pdfFile);

      out.on('finish', () => {
        console.log('PDF created successfully:', pdfFile);
        resolve(pdfFile);
      });
      out.on('error', (err) => {
        console.error('PDF write error:', err);
        reject(err);
      });

      doc.on('error', (err) => {
        console.error('PDF creation error:', err);
        reject(err);
      });

      doc.pipe(out);

      const vendors = [];
      fs.createReadStream(csvFile)
        .pipe(fastcsv.parse({ headers: true }))
        .on('data', (row) => {
          if (row['Category'] !== 'Membership') {
            vendors.push({
              date: row['Fulfillment Date'],
              vendor: row['Vendor'],
              amount: row['Product Subtotal'],
            });
          }
        })
        .on('end', () => {
          // Sort for stable grouping
          vendors.sort((a, b) => String(a.vendor).localeCompare(String(b.vendor)));

          const months = [
            'January', 'February', 'March', 'April', 'May', 'June', 'July',
            'August', 'September', 'October', 'November', 'December'
          ];

          const grouped = {};
          let allVendorSales = 0;
          let monthLabel = '';

          vendors.forEach(({ date, vendor, amount }) => {
            // Robust month parsing
            let mIdx = NaN;
            if (date) {
              const d = new Date(date);
              if (!isNaN(d)) {
                mIdx = d.getMonth();
              } else {
                const parts = String(date).split(/\s+/); // e.g., ["Fri","Sep","13","2024"] or ["13","Sep","24"]
                const maybeMonth = parts[1] || parts[0] || '';
                const probe = new Date(`${maybeMonth} 1, 2000`);
                if (!isNaN(probe)) mIdx = probe.getMonth();
              }
            }
            if (!isNaN(mIdx) && mIdx >= 0) monthLabel = months[mIdx];

            const amt = parseFloat(amount || 0) || 0;
            if (!grouped[vendor]) {
              grouped[vendor] = { vendor, amount: amt, date: monthLabel };
            } else {
              grouped[vendor].amount += amt;
            }
            allVendorSales += amt;
          });

          let output = Object.values(grouped).sort((a, b) => b.amount - a.amount);
          const formattedRows = output.map(item => [
            item.vendor,
            '$' + item.amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
          ]);

          doc.fontSize(16).text(`${monthLabel} Vendor Reports`);
          doc.moveDown(0.5);
          doc.fontSize(12).text(
            'Total Sales = $' + allVendorSales.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
          );
          doc.moveDown(1);

          const table = {
            title: '',
            headers: ['vendor', 'amount'],
            rows: formattedRows,
          };

          doc.table(table);
          doc.end(); // triggers 'finish' on the write stream
        })
        .on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Main workflow
 */
async function vendor(lastMonth) {
  console.log('running monthly vendor report updater');

  const url =
    'https://localline.ca/api/backoffice/v2/orders/export/?' +
    'file_type=orders_list_view&send_to_email=false&destination_email=fullfarmcsa%40deckfamilyfarm.com&direct=true&' +
    `fulfillment_date_start=${lastMonth.first}&` +
    `fulfillment_date_end=${lastMonth.last}&` +
    '&status=OPEN&status=NEEDS_APPROVAL&status=CANCELLED&status=CLOSED';

  console.log(url);

  // Login → access token
  const tokenResp = await utilities.getAccessToken();
  const accessToken = JSON.parse(tokenResp).access;

  console.log('fetching vendors ...');
  const reqIdResp = await utilities.getRequestID(url, accessToken);
  const id = JSON.parse(reqIdResp).id;

  // wait for export to complete → get file path
  const vendorResultUrl = await utilities.pollStatus(id, accessToken);
  if (!vendorResultUrl) {
    const msg = 'file generation not completed in 1 minute';
    console.error(msg);
    await utilities.sendErrorEmail(msg);
    throw new Error(msg);
  }

  // Download CSV
  const csvPath = await utilities.downloadData(
    vendorResultUrl,
    `vendors_${lastMonth.last}.csv`,
    accessToken
  );
  console.log('Downloaded file path:', csvPath);

  // Build PDF (resolves after write stream 'finish')
  const pdfPath = await buildVendorsPdf(csvPath, lastMonth.last);

  // Prepare email — do NOT set `from` here; let utilities.sendEmail enforce verified sender.
  const emailOptions = {
    to: 'fullfarmcsa@deckfamilyfarm.com',
    cc: 'jdeck88@gmail.com',
    replyTo: 'fullfarmcsa@deckfamilyfarm.com',
    subject: `FFCSA Reports: Monthly Vendor Report for ${lastMonth.last}`,
    text: 'Please see the attached file.',
    attachments: [
      {
        filename: `vendors_${lastMonth.last}.pdf`,
        path: pdfPath,
        contentType: 'application/pdf',
      },
    ],
  };

  await utilities.sendEmail(emailOptions);
  console.log('Email sent.');
}

// ---- Run and make sure the process actually exits ----
(async () => {
  // Global kill switch so a stuck SMTP pool or network op can’t hang forever
  const HARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  const timeout = setTimeout(() => {
    console.error(`Global timeout (${HARD_TIMEOUT_MS} ms) — forcing exit.`);
    process.exit(2);
  }, HARD_TIMEOUT_MS);

  try {
    await vendor(utilities.getLastMonth());
    clearTimeout(timeout);
    // Give a brief tick for any final console flushes, then exit
    setTimeout(() => process.exit(0), 10);
  } catch (err) {
    clearTimeout(timeout);
    console.error('Fatal error:', err && err.stack || err);
    try { await utilities.sendErrorEmail(err && err.stack || String(err)); } catch (_) {}
    setTimeout(() => process.exit(1), 10);
  }
})();

