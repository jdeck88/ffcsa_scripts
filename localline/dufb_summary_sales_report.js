// dufb_summary_sales_report
const fs = require('fs');
const path = require('path');
const fastcsv = require('fast-csv');
require('dotenv').config();
const utilities = require('./utilities');
const PDFDocument = require('pdfkit');


async function writeAndEmailReport(report, overall, beginDate, endDate) {
  const pdfPath = `data/dufb_summary_sales_${endDate}.pdf`;
  const stream = fs.createWriteStream(pdfPath);
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(stream);

  stream.on('error', (err) => {
    console.error('Stream error:', err);
  });
  doc.on('error', (err) => {
    console.error('PDF error:', err);
  });

  // 🔹 DUFB Purchase Summary Header with Legend
  doc.font('Helvetica-Bold').fontSize(16).text(`DUFB Purchase Summary`, { align: 'center' });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(11).text(`Members with DUFB Tag | ${beginDate} to ${endDate}`, { align: 'center' });
  doc.moveDown(0.5);

  // 🔸 Legend
  doc.font('Helvetica').fontSize(10);
  doc.fillColor('green').text('Eligible (>= 50% Veg/Fruit)', { align: 'center'});
  doc.fillColor('red').text('Not Eligible (< 50% Veg/Fruit)', { align: 'center' });
  doc.fillColor('black');
  doc.moveDown(1);

  doc.moveDown();

  for (const email of Object.keys(report).sort()) {
    const customer = report[email];

    const pctTotal = customer.allTotal
      ? (100 * customer.vegFruitTotal / customer.allTotal)
      : 0.0;
    const pctString = pctTotal.toFixed(1);
    const isBelowThreshold = pctTotal < 50;

    // 🔹 Set color based on threshold
    const statusColor = isBelowThreshold ? 'red' : 'green';

    // 🔸 Highlight customer name
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(statusColor)
      .text(`${customer.lastName}, ${customer.firstName} (${email})`);

    // 🔸 Reset color for normal text
    doc.font('Helvetica').fontSize(8).fillColor('black');

    for (const [category, data] of Object.entries(customer.categories)) {
      doc.text(`${category}: ${data.quantity.toFixed(2)} units | $${data.total.toFixed(2)}`);
    }

    doc.moveDown(0.3);

    // 🔸 Summary line with bold
    doc.font('Helvetica-Bold');
    const summaryLine = `Total $: $${customer.allTotal.toFixed(2)} | Veg/Fruit $: $${customer.vegFruitTotal.toFixed(2)} | % on Veg/Fruit: ${pctString}%`;
    doc.text(summaryLine);

    doc.moveDown(1);
  }

  // Wait for file then email
  stream.on('finish', () => {
    const emailOptions = {
      from: "fullfarmcsa@deckfamilyfarm.com",
      to: "fullfarmcsa@deckfamilyfarm.com",
      cc: "jdeck88@gmail.com",
      subject: `FFCSA Report: Customer Purchase Summary ${beginDate} - ${endDate}`,
      text: "Attached is your PDF summary of customer purchases by category.",
      attachments: [
        {
          filename: `dufb_summary_sales_${endDate}.pdf`,
          path: pdfPath, // ✅ use `path:` instead of `content: fs.readFileSync(...)`
        },
      ],
    };

    utilities.sendEmail(emailOptions);
  });
  doc.end();
}

async function generateReport(beginDate, endDate) {
  try {
    const accessToken = JSON.parse(await utilities.getAccessToken()).access;

    const url = `https://localline.ca/api/backoffice/v2/orders/export/?file_type=orders_list_view&send_to_email=false&direct=true&fulfillment_date_start=${beginDate}&fulfillment_date_end=${endDate}&customer_tags=1695`;

    const requestId = JSON.parse(await utilities.getRequestID(url, accessToken)).id;
    const csvUrl = await utilities.pollStatus(requestId, accessToken);
    if (!csvUrl) throw new Error("Export URL not available.");

    const filename = `orders_tag1695_${endDate}.csv`;
    await utilities.downloadData(csvUrl, filename);

    const report = {}; // email -> category -> { quantity, total }

    let overall = {
      vegFruitQty: 0,
      vegFruitTotal: 0,
      allQty: 0,
      allTotal: 0,
    };

    return new Promise((resolve, reject) => {
      fs.createReadStream('data/' + filename)
        .pipe(fastcsv.parse({ headers: true }))
        .on('data', row => {
          const email = row['Email']?.trim().toLowerCase();
          const lastName = row['Last Name']?.trim()
          const firstName = row['First Name']?.trim()
          const category = row['Category']?.trim() || 'Uncategorized';
          if (!email || category === 'Membership') return;

          const qty = parseFloat(row['Quantity']) || 0;
          const price = parseFloat(row['Product Subtotal']) || 0;

          // Initialize customer entry
          if (!report[email]) {
            report[email] = {
              categories: {},
              lastName: lastName,
              firstName: firstName,
              vegFruitQty: 0,
              vegFruitTotal: 0,
              allQty: 0,
              allTotal: 0,
            };
          }

          if (!report[email].categories[category]) {
            report[email].categories[category] = { quantity: 0, total: 0 };
          }

          // Tally per category
          report[email].categories[category].quantity += qty;
          report[email].categories[category].total += price;

          // Tally groupings
          report[email].allQty += qty;
          report[email].allTotal += price;
          overall.allQty += qty;
          overall.allTotal += price;

          if (/vegetable/i.test(category) || /fruit/i.test(category)) {
            report[email].vegFruitQty += qty;
            report[email].vegFruitTotal += price;
            overall.vegFruitQty += qty;
            overall.vegFruitTotal += price;
          }
        })
        .on('end', () => {
          console.log(`\n📦 DUFB Report for DUFB Tag (1695)`);
          console.log(`From ${beginDate} to ${endDate}\n`);

          writeAndEmailReport(report, overall, beginDate, endDate).then(resolve).catch(console.error);
        })
        .on('error', reject);
    });
  } catch (err) {
    console.error("❌ Error generating report:", err.message);
  }
}

// run dufb_summary_sales_report
if (require.main === module) {
  let beginDate, endDate;

  if (process.argv.length >= 4) {
    // CLI arguments provided
    [beginDate, endDate] = process.argv.slice(2);
  } else {
    // Default to last month
    const { first, last } = utilities.getLastMonth();
    beginDate = first;
    endDate = last;
    console.log(`📆 No dates provided. Defaulting to last month: ${beginDate} to ${endDate}`);
  }

  generateReport(beginDate, endDate);
}
