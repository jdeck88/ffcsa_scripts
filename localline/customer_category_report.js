
// SNAP report
// run like:
// node customer_category_report.js 2024-01-01 2024-12-31
const fs = require('fs');
const path = require('path');
const fastcsv = require('fast-csv');
require('dotenv').config();
const utilities = require('./utilities');
const PDFDocument = require('pdfkit');



async function writeAndEmailCustomerSummaryPDF(report, overall, beginDate, endDate) {
  console.log('in writeAndEmail function');
  const pdfPath = `data/customer_summary_${endDate}.pdf`;
  const stream = fs.createWriteStream(pdfPath);
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(stream);

  stream.on('error', (err) => {
    console.error('Stream error:', err);
  });
  doc.on('error', (err) => {
    console.error('PDF error:', err);
  });


  doc.fontSize(16).text(`Customer Purchase Summary`, { align: 'center' });
  doc.fontSize(12).text(`Tag: 959 | Date Range: ${beginDate} to ${endDate}`, { align: 'center' });
  doc.moveDown();

for (const email of Object.keys(report).sort()) {
  const customer = report[email];

  // ✅ Bold email header
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text(`${email}`);

  // ✅ Regular category data
  doc.font('Helvetica').fontSize(12);
  for (const [category, data] of Object.entries(customer.categories)) {
    doc.text(`- ${category}: ${data.quantity.toFixed(2)} units | $${data.total.toFixed(2)}`);
  }

  const pctTotal = customer.allTotal
    ? (100 * customer.vegFruitTotal / customer.allTotal).toFixed(1)
    : '0.0';

  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text(`Total $: $${customer.allTotal.toFixed(2)} | Veg/Fruit $: $${customer.vegFruitTotal.toFixed(2)} | % on Veg/Fruit: ${pctTotal}%`);
  doc.moveDown(1);
}

// ✅ Bold overall summary header
const overallPct = overall.allTotal
  ? (100 * overall.vegFruitTotal / overall.allTotal).toFixed(1)
  : '0.0';

doc.font('Helvetica-Bold').fontSize(14).text(`Overall Summary`, { underline: true });
doc.moveDown(0.5);

// ✅ Regular summary body
doc.font('Helvetica').fontSize(12);
doc.text(`Total $ (All Products): $${overall.allTotal.toFixed(2)}`);
doc.text(`Total $ (Veg/Fruit): $${overall.vegFruitTotal.toFixed(2)}`);
doc.text(`% Spent on Veg/Fruit: ${overallPct}%`);


  // Wait for file then email
  stream.on('finish', () => {
    console.log('📧 emailing');

    const emailOptions = {
      from: "jdeck88@gmail.com",
      to: "jdeck88@gmail.com",
      subject: `FFCSA Report: Customer Purchase Summary ${beginDate} - ${endDate}`,
      text: "Attached is your PDF summary of customer purchases by category.",
      attachments: [
        {
          filename: `customer_summary_${endDate}.pdf`,
          path: pdfPath, // ✅ use `path:` instead of `content: fs.readFileSync(...)`
        },
      ],
    };

    utilities.sendEmail(emailOptions);
    console.log("✅ Summary emailed to jdeck88@gmail.com");
  });
  console.log('Calling doc.end().');
  doc.end();
  console.log('doc.end() called.');

}

async function generateCategoryReportGroupedByCustomer(beginDate, endDate) {
  try {
    const accessToken = JSON.parse(await utilities.getAccessToken()).access;

    const url = `https://localline.ca/api/backoffice/v2/orders/export/?file_type=orders_list_view&send_to_email=false&direct=true&fulfillment_date_start=${beginDate}&fulfillment_date_end=${endDate}&customer_tags=959`;

    const requestId = JSON.parse(await utilities.getRequestID(url, accessToken)).id;
    const csvUrl = await utilities.pollStatus(requestId, accessToken);
    if (!csvUrl) throw new Error("Export URL not available.");

    const filename = `orders_tag959_${endDate}.csv`;
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
          const category = row['Category']?.trim() || 'Uncategorized';
          if (!email || category === 'Membership') return;

          const qty = parseFloat(row['Quantity']) || 0;
          const price = parseFloat(row['Product Subtotal']) || 0;

          // Initialize customer entry
          if (!report[email]) {
            report[email] = {
              categories: {},
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
          console.log(`\n📦 Category Report for Customer Tag 959`);
          console.log(`From ${beginDate} to ${endDate}\n`);

          /*
          for (const email of Object.keys(report).sort()) {
            console.log(`🧑 ${email}`);

            const customer = report[email];
            const categorySummary = Object.entries(customer.categories).map(([category, data]) => ({
              Category: category,
              Quantity: data.quantity.toFixed(2),
              Total: `$${data.total.toFixed(2)}`
            }));

            console.table(categorySummary);

            const pctTotal = customer.allTotal ? (100 * customer.vegFruitTotal / customer.allTotal).toFixed(1) : '0.0';
            const pctQty = customer.allQty ? (100 * customer.vegFruitQty / customer.allQty).toFixed(1) : '0.0';

            console.log(`💰 Total $: $${customer.allTotal.toFixed(2)} | Veg/Fruit $: $${customer.vegFruitTotal.toFixed(2)} | % on Veg/Fruit: ${pctTotal}%\n`);
          }

          // Final overall summary
          const overallPctTotal = overall.allTotal ? (100 * overall.vegFruitTotal / overall.allTotal).toFixed(1) : '0.0';
          const overallPctQty = overall.allQty ? (100 * overall.vegFruitQty / overall.allQty).toFixed(1) : '0.0';

          console.log('🧾 Overall Summary (All Members)\n');
          console.table([{
            'Total $ (All Products)': `$${overall.allTotal.toFixed(2)}`,
            'Total $ (Veg/Fruit)': `$${overall.vegFruitTotal.toFixed(2)}`,
            '% Spent on Veg/Fruit': `${overallPctTotal}%`
          }]);
          */

          writeAndEmailCustomerSummaryPDF(report, overall, beginDate, endDate).then(resolve).catch(console.error);
        })
        .on('error', reject);
    });
  } catch (err) {
    console.error("❌ Error generating report:", err.message);
  }
}

// Usage: node customer_category_report.js 2025-04-01 2025-04-30
if (require.main === module) {
  const [beginDate, endDate] = process.argv.slice(2);
  if (!beginDate || !endDate) {
    console.error("Usage: node customer_category_report.js <beginDate> <endDate>");
    process.exit(1);
  }
  generateCategoryReportGroupedByCustomer(beginDate, endDate);
}

