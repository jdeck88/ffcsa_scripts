// monthly_customers.js
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const utilities = require('./utilities');

/**
 * Build the Customers PDF from a CSV file and resolve with:
 * { pdfPath, pdfFileName, totalBalanceStr }
 */
async function buildCustomersPdf(csvFile, asOfDate) {
  return new Promise((resolve, reject) => {
    try {
      const pdfFileName = `customers_${asOfDate}.pdf`;
      const pdfPath = path.join('data', pdfFileName);
      fs.mkdirSync(path.dirname(pdfPath), { recursive: true });

      const doc = new PDFDocument();
      const out = fs.createWriteStream(pdfPath);

      out.on('finish', () => {
        console.log('PDF created successfully:', pdfPath);
        resolve({ pdfPath, pdfFileName, totalBalanceStr });
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

      const customers = [];
      let totalBalance = 0;
      let totalBalanceStr = '0.00';

      fs.createReadStream(csvFile)
        .pipe(fastcsv.parse({ headers: true }))
        .on('data', (row) => {
          const name = row['Customer'];
          const amount = parseFloat(row['Store Credit'] || 0) || 0;
          customers.push({ name, amount });
        })
        .on('end', () => {
          // Sort by balance (desc)
          customers.sort((a, b) => b.amount - a.amount);

          const rows = customers.map(({ name, amount }) => {
            totalBalance += amount;
            return [
              name,
              amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
            ];
          });

          totalBalanceStr = totalBalance
            .toFixed(2)
            .replace(/\B(?=(\d{3})+(?!\d))/g, ',');

          doc.fontSize(14).text(
            `Total member balances = $${totalBalanceStr} as of ${asOfDate} 11:59pm`
          );
          doc.moveDown(1);

          const table = {
            title: 'Customer Balances',
            headers: ['customer', 'balance'],
            rows,
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
async function customers(today, yesterday) {
  console.log('running monthly customer balance report');

  const url = 'https://localline.ca/api/backoffice/v2/customers/export/?direct=true';
  console.log(url);

  // Login → access token
  const tokenResp = await utilities.getAccessToken();
  const accessToken = JSON.parse(tokenResp).access;

  console.log('fetching customers ...');

  // Download CSV (binary)
  const csvPath = await utilities.downloadBinaryData(
    url,
    path.join('data', `customers_${today}.csv`),
    accessToken
  );
  console.log('Downloaded file path:', csvPath);

  // Build PDF (resolves after write stream 'finish')
  const { pdfPath, pdfFileName, totalBalanceStr } = await buildCustomersPdf(
    csvPath,
    yesterday
  );

  // Email — do NOT set `from` here; let utilities.sendEmail use the verified sender.
  const emailOptions = {
    // adjust recipients as desired:
    to: 'jdeck88@gmail.com',
    // to: 'fullfarmcsa@deckfamilyfarm.com',
    // cc: 'mhobart@bworcpas.com',
    replyTo: 'fullfarmcsa@deckfamilyfarm.com',
    subject: `FFCSA Reports: Monthly Customer Balance Report for ${yesterday}`,
    text: `Total Member Balance as of ${yesterday} = $${totalBalanceStr}`,
    attachments: [
      {
        filename: pdfFileName,
        path: pdfPath,
        contentType: 'application/pdf',
      },
    ],
  };

  await utilities.sendEmail(emailOptions);
  console.log('Email sent.');
}

// ---- Run and ensure the process exits (SMTP pool can keep event loop alive) ----
(async () => {
  const HARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes hard stop
  const timeout = setTimeout(() => {
    console.error(`Global timeout (${HARD_TIMEOUT_MS} ms) — forcing exit.`);
    process.exit(2);
  }, HARD_TIMEOUT_MS);

  try {
    await customers(utilities.getToday(), utilities.getYesterday());
    clearTimeout(timeout);
    setTimeout(() => process.exit(0), 10);
  } catch (err) {
    clearTimeout(timeout);
    console.error('Fatal error:', err && err.stack || err);
    try { await utilities.sendErrorEmail(err && err.stack || String(err)); } catch (_) {}
    setTimeout(() => process.exit(1), 10);
  }
})();

