// dufb_summary_sales_report.js (now with daily breakdown per member)

const fs = require('fs');
const path = require('path');
const fastcsv = require('fast-csv');
const PDFDocument = require('pdfkit');
const utilities = require('./utilities');
require('dotenv').config();

async function fetchAllOrdersForMonth(month, year) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0).toISOString().split('T')[0];
  const filename = `data/tmp_all_orders_${year}_${month}.csv`;

  if (fs.existsSync(filename)) {
    console.log(`✅ Using cached orders for ${year}-${month}`);
  } else {
    const accessToken = JSON.parse(await utilities.getAccessToken()).access;
    const url = `https://localline.ca/api/backoffice/v2/orders/export/?file_type=orders_list_view&send_to_email=false&direct=true&fulfillment_date_start=${startDate}&fulfillment_date_end=${endDate}`;
    const requestId = JSON.parse(await utilities.getRequestID(url, accessToken)).id;
    const csvUrl = await utilities.pollStatus(requestId, accessToken);
    if (!csvUrl) return [];
    await utilities.downloadData(csvUrl, `tmp_all_orders_${year}_${month}.csv`);
  }

  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filename)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', row => results.push(row))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

async function generateReportFromCSV() {
  const filepath = path.join(__dirname, 'data', 'snap_data.csv');

  const sheetRows = await new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filepath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', row => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });

  const emailMap = {}; // email => { first, last, months: Set, dufbTotal, vegFruitTotal, allTotal, ordersByDate }
  const grouped = {}; // month => emails

  for (const row of sheetRows) {
    const email = row.Email?.toLowerCase().trim();
    const month = row.Month?.padStart(2, '0');
    const year = row.Year;
    const hasBenefit = row.SNAP || row.DUFB;
    if (!email || !hasBenefit) continue;

    const key = `${year}-${month}`;
    if (!grouped[key]) grouped[key] = new Set();
    grouped[key].add(email);

    if (!emailMap[email]) {
      emailMap[email] = {
        firstName: row.First?.trim(),
        lastName: row.Last?.trim(),
        months: new Set(),
        dufbTotal: 0,
        vegFruitTotal: 0,
        allTotal: 0,
        ordersByDate: {}
      };
    }
    emailMap[email].months.add(key);
    emailMap[email].dufbTotal += parseFloat(row.DUFB) || 0;
  }

  const allKeys = Object.keys(grouped);
  for (const key of allKeys) {
    const [year, month] = key.split('-');
    const orders = await fetchAllOrdersForMonth(month, year);
    for (const order of orders) {
      const email = order['Email']?.toLowerCase().trim();
      if (!emailMap[email]) continue;

      const category = order['Category']?.trim() || 'Uncategorized';
      if (/membership/i.test(category)) continue;

      const qty = parseFloat(order['Quantity']) || 0;
      const date = order['Date']?.split('T')[0] || 'Unknown Date';
      const orderDate = new Date(date);
      const isBeforeMarch2025 = orderDate < new Date('2025-03-01');

      const basePrice = parseFloat(order['Product Subtotal']) || 0;
      //const price = isBeforeMarch2025 ? basePrice * 1.13 : basePrice;
      const price = basePrice;
      //const date = order['Date']?.split('T')[0] || 'Unknown Date';

      if (!emailMap[email].ordersByDate[date]) emailMap[email].ordersByDate[date] = {};
      if (!emailMap[email].ordersByDate[date][category]) {
        emailMap[email].ordersByDate[date][category] = { quantity: 0, total: 0 };
      }

      emailMap[email].ordersByDate[date][category].quantity += qty;
      emailMap[email].ordersByDate[date][category].total += price;

      emailMap[email].allTotal += price;
      if (/vegetable|fruit/i.test(category)) {
        emailMap[email].vegFruitTotal += price;
      }
    }
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const pdfPath = `data/dufb_summary_sales_${dateStr}.pdf`;

  const stream = fs.createWriteStream(pdfPath);
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(stream);

  //doc.font('Helvetica-Bold').fontSize(16).text(`SNAP / DUFB Purchase Summary`, { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(16).text(`Members with SNAP / DUFB Subscription Purchase Summary\nJanuary 1, 2024 to June 18, 2025`, { align: 'center' });
  doc.font('Helvetica').fontSize(11).text(`Generated on ${dateStr}`, { align: 'center' }).moveDown(1);

  let totalVeg = 0, totalDufb = 0;

  for (const email of Object.keys(emailMap).sort()) {
    const member = emailMap[email];
    totalVeg += member.vegFruitTotal;
    totalDufb += member.dufbTotal;
  }

  const unreimbursed = 2600;
  const unpaid = 1000;
  const reimbursed = totalDufb - unreimbursed - unpaid;
  const overallPct = totalDufb ? (100 * totalVeg / totalDufb).toFixed(1) : '0.0';
  const formatCurrency = (n) => `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

  //doc.font('Helvetica-Bold').fontSize(12);
  //doc.text(`Members with SNAP/DUFB subscriptions order report - January 1, 2024 to June 18, 2025`).moveDown(0.4);
    /*
  doc.font('Helvetica');
  doc.text(`DUFB Allocated: ${formatCurrency(totalDufb)}`);
  doc.text(`DUFB Unreimbursed (May/June 2025): ${formatCurrency(unreimbursed)}`);
  doc.text(`Bad Payments in 2024: ${formatCurrency(unpaid)}`);
  doc.text(`DUFB Reimbursed: ${formatCurrency(reimbursed)}`);
  doc.text(`Veg/Fruit Purchased: ${formatCurrency(totalVeg)}`).moveDown(1);
  */

  for (const email of Object.keys(emailMap).sort()) {
    const member = emailMap[email];
    const pct = member.dufbTotal ? (100 * member.vegFruitTotal / member.dufbTotal).toFixed(1) : '0.0';
    const statusColor = 'black'

    doc.font('Helvetica-Bold').fontSize(12).fillColor(statusColor)
      .text(`${member.lastName}, ${member.firstName} (${email})`);
    doc.font('Helvetica').fontSize(10).fillColor('black');

    doc.text(`Participated Months: ${Array.from(member.months).sort().join(', ')}`);

    for (const date of Object.keys(member.ordersByDate).sort()) {
      doc.font('Helvetica-Bold').text(`  ${date}`);
      const catMap = member.ordersByDate[date];
      for (const [cat, data] of Object.entries(catMap)) {
        doc.font('Helvetica').text(`    ${cat}: ${data.quantity.toFixed(2)} units | $${data.total.toFixed(2)}`);
      }
    }

    doc.font('Helvetica-Bold');
    //doc.text(`Total $: $${member.allTotal.toFixed(2)} | Veg/Fruit $: $${member.vegFruitTotal.toFixed(2)} | DUFB Received: $${member.dufbTotal.toFixed(2)} | % of DUFB spent on Veg/Fruit: ${pct}%`);
    //doc.text(`Member Total: $${member.allTotal.toFixed(2)} | Veg/Fruit $: $${member.vegFruitTotal.toFixed(2)} | DUFB Received: $${member.dufbTotal.toFixed(2)}`);
    doc.moveDown(1);
  }

  doc.end();

  stream.on('finish', () => {
    const emailOptions = {
      from: "fullfarmcsa@deckfamilyfarm.com",
      to: "jdeck88@gmail.com",
      subject: `FFCSA DUFB Purchase Summary PDF (${dateStr})`,
      text: [
        "Attached is your PDF summary of DUFB/SNAP purchases from Full Farm CSA members.",
        "It includes purchase summaries per person and highlights DUFB-eligible (Veg/Fruit) spending.",
        "Green indicates eligibility (>= 50%), red indicates under-threshold spending.",
        "",
        "Contact FFCSA at 541-998-4697 with questions."
      ].join("\n"),
      attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
    };
    utilities.sendEmail(emailOptions);
  });
}

if (require.main === module) {
  (async () => {
    await generateReportFromCSV();
  })();
}

