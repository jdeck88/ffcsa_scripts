const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const utilities = require('./utilities');

const TARGET_TAG = 'csa only';
const TARGET_VENDOR_NAME = 'creamy cow';
const TARGET_VENDOR_ID = '3172';
//const TARGET_VENDOR_NAME = 'radiant';
//const TARGET_VENDOR_ID = '3158';
const PROD_TO_EMAIL = 'fullfarmcsa@deckfamilyfarm.com';
const PROD_CC_EMAIL = 'jdeck88@gmail.com';
const TEST_TO_EMAIL = 'jdeck88@gmail.com';
const CUSTOMERS_EXPORT_URL = 'https://localline.ca/api/backoffice/v2/customers/export/?direct=true';

const TAG_COLUMNS = ['Tags', 'Customer Tags', 'Tag'];
const VENDOR_ID_COLUMNS = ['Vendor ID', 'Vendor Id', 'VendorID', 'vendor_id', 'vendorId'];

function toTrimmedString(value) {
  return (value || '').toString().trim();
}

function splitTags(rawTagText) {
  if (!rawTagText) return [];
  return rawTagText
    .split(/[;,|]/)
    .map(tag => tag.trim())
    .filter(Boolean);
}

function getTagText(row) {
  for (const column of TAG_COLUMNS) {
    const value = toTrimmedString(row[column]);
    if (value) return value;
  }
  return '';
}

function getVendorId(row) {
  for (const column of VENDOR_ID_COLUMNS) {
    const value = toTrimmedString(row[column]);
    if (value) return value;
  }
  return '';
}

function getAccessTokenOrThrow(rawTokenResponse) {
  let tokenPayload;
  try {
    tokenPayload = (typeof rawTokenResponse === 'string')
      ? JSON.parse(rawTokenResponse)
      : rawTokenResponse;
  } catch (error) {
    throw new Error(`Unable to parse access token response: ${rawTokenResponse}`);
  }

  if (!tokenPayload || !tokenPayload.access) {
    throw new Error(`Token response missing access field: ${JSON.stringify(tokenPayload)}`);
  }
  return tokenPayload.access;
}

function hasCsaOnlyTag(tags) {
  for (const tag of tags) {
    if (tag.toLowerCase().includes(TARGET_TAG)) {
      return true;
    }
  }
  return false;
}

function rowMatchesDairyVendor(row) {
  const vendorName = toTrimmedString(row['Vendor']).toLowerCase();
  const vendorId = getVendorId(row);
  const vendorNameMatch = vendorName.includes(TARGET_VENDOR_NAME);
  const vendorIdMatch = vendorId === TARGET_VENDOR_ID;
  return vendorNameMatch || vendorIdMatch;
}

function buildDisplayName(row, currentName = '') {
  const firstName = toTrimmedString(row['First Name']);
  const lastName = toTrimmedString(row['Last Name']);
  const customer = toTrimmedString(row['Customer']);

  if (firstName || lastName) {
    return `${firstName} ${lastName}`.trim();
  }
  if (customer) return customer;
  return currentName;
}

function buildCustomerTagMap(customersFilePath) {
  return new Promise((resolve, reject) => {
    const customersByEmail = new Map();

    fs.createReadStream(customersFilePath)
      .pipe(fastcsv.parse({ headers: true, ignoreEmpty: true }))
      .on('error', reject)
      .on('data', row => {
        const email = toTrimmedString(row['Email']).toLowerCase();
        if (!email) return;

        if (!customersByEmail.has(email)) {
          customersByEmail.set(email, {
            customerName: toTrimmedString(row['Customer']),
            phone: toTrimmedString(row['Phone']),
            tags: new Set(),
          });
        }

        const customer = customersByEmail.get(email);
        const parsedTags = splitTags(getTagText(row));
        for (const tag of parsedTags) {
          customer.tags.add(tag);
        }
      })
      .on('end', () => resolve(customersByEmail));
  });
}

function collectDairyMembers(ordersFilePath, customerTagMap) {
  return new Promise((resolve, reject) => {
    const customers = new Map();

    fs.createReadStream(ordersFilePath)
      .pipe(fastcsv.parse({ headers: true, ignoreEmpty: true }))
      .on('error', reject)
      .on('data', row => {
        const email = toTrimmedString(row['Email']).toLowerCase();
        if (!email) return;

        if (!customers.has(email)) {
          const customerAccount = customerTagMap.get(email);
          customers.set(email, {
            customerName: '',
            email,
            phone: '',
            tags: new Set(customerAccount ? customerAccount.tags : []),
            matchedRowCount: 0,
            matchedOrders: new Set(),
            matchedProducts: new Set(),
            matchedFulfillmentDates: new Set(),
          });
        }

        const customer = customers.get(email);
        const customerAccount = customerTagMap.get(email);

        customer.customerName = buildDisplayName(row, customer.customerName);
        if (!customer.customerName && customerAccount) {
          customer.customerName = customerAccount.customerName;
        }
        const phone = toTrimmedString(row['Phone']);
        if (phone) customer.phone = phone;
        if (!customer.phone && customerAccount) {
          customer.phone = customerAccount.phone;
        }

        if (rowMatchesDairyVendor(row)) {
          customer.matchedRowCount += 1;
          const orderId = toTrimmedString(row['Order']);
          const productName = toTrimmedString(row['Product']);
          const packageName = toTrimmedString(row['Package Name']);
          const fulfillmentDate = toTrimmedString(row['Fulfillment Date']);

          if (orderId) customer.matchedOrders.add(orderId);
          if (productName || packageName) {
            customer.matchedProducts.add(
              [productName, packageName].filter(Boolean).join(' - ')
            );
          }
          if (fulfillmentDate) customer.matchedFulfillmentDates.add(fulfillmentDate);
        }
      })
      .on('end', () => {
        const results = [];

        for (const customer of customers.values()) {
          const tags = Array.from(customer.tags);
          const hasTag = hasCsaOnlyTag(tags);
          const hasVendorMatch = customer.matchedRowCount > 0;

          if (!hasTag || !hasVendorMatch) continue;

          results.push({
            customerName: customer.customerName || '(No name)',
            email: customer.email,
            phone: customer.phone || '',
            tags: tags.sort((a, b) => a.localeCompare(b)),
            matchedRowCount: customer.matchedRowCount,
            matchedOrders: Array.from(customer.matchedOrders).sort((a, b) => a.localeCompare(b)),
            matchedProducts: Array.from(customer.matchedProducts).sort((a, b) => a.localeCompare(b)),
            matchedFulfillmentDates: Array.from(customer.matchedFulfillmentDates).sort((a, b) => a.localeCompare(b)),
          });
        }

        results.sort((a, b) => a.customerName.localeCompare(b.customerName));
        resolve(results);
      });
  });
}

async function downloadCustomersCsv(fulfillmentDate, testing = false) {
  const fileName = `customers_${fulfillmentDate.end}.csv`;
  const outputPath = path.join('data', fileName);

  if (testing && fs.existsSync(outputPath)) {
    console.log(`📄 Using existing customers file (testing mode): ${outputPath}`);
    return outputPath;
  }

  const tokenResp = await utilities.getAccessToken();
  const accessToken = getAccessTokenOrThrow(tokenResp);
  return utilities.downloadBinaryData(CUSTOMERS_EXPORT_URL, outputPath, accessToken);
}

function writeReportPdf(results, fulfillmentDate) {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const fileName = `dairy_monitor_${fulfillmentDate.end}.pdf`;
  const reportPath = path.join(dataDir, fileName);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(reportPath);

    doc.pipe(stream);

    doc.fontSize(16).font('Helvetica-Bold').text('FFCSA Dairy Monitor Report');
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica').text(`Fulfillment dates: ${fulfillmentDate.start} to ${fulfillmentDate.end}`);
    doc.text(`Filter: customer-account tags contain "${TARGET_TAG}" AND vendor is "${TARGET_VENDOR_NAME}" (or Vendor ID ${TARGET_VENDOR_ID} when present).`);
    doc.text('Action note: Verify matched products are herdshare-required dairy. If raw dairy was ordered, contact the member. When herdshare signup is completed, remove the "CSA Only" tag.');
    doc.text(`Matched members: ${results.length}`);
    doc.moveDown(0.8);

    if (results.length === 0) {
      doc.fontSize(11).text('No matching members were found for this fulfillment window.');
    } else {
      results.forEach((row, index) => {
        doc.fontSize(12).font('Helvetica-Bold').text(`${index + 1}. ${row.customerName}`);
        doc.fontSize(10).font('Helvetica').text(`Email: ${row.email}`);
        doc.text(`Phone: ${row.phone || '(blank)'}`);
        doc.text(`Tags: ${row.tags.join(', ') || '(none)'}`);
        doc.text(`Matched Line Items: ${row.matchedRowCount}`);
        doc.text(`Matched Orders: ${row.matchedOrders.join(', ')}`);
        doc.text(`Matched Products: ${row.matchedProducts.join('; ')}`);
        doc.text(`Matched Fulfillment Dates: ${row.matchedFulfillmentDates.join(', ')}`);
        doc.moveDown(0.8);
      });
    }

    doc.end();

    stream.on('finish', () => resolve(reportPath));
    stream.on('error', reject);
  });
}

function buildEmailText(results, fulfillmentDate, ordersFilePath, customersFilePath, testing) {
  const lines = [];
  lines.push(`Dairy monitor results for fulfillment dates ${fulfillmentDate.start} to ${fulfillmentDate.end}.`);
  lines.push(`Orders source: ${ordersFilePath}`);
  lines.push(`Customer tags source: ${customersFilePath}`);
  lines.push(`Filter: customer-account tags contain "${TARGET_TAG}" AND vendor is "${TARGET_VENDOR_NAME}" (or Vendor ID ${TARGET_VENDOR_ID} when present).`);
  lines.push(`Matched members: ${results.length}`);
  lines.push('');

  if (results.length === 0) {
    lines.push('No matching members were found for this fulfillment window.');
  } else {
    for (const row of results) {
      lines.push(`Name: ${row.customerName}`);
      lines.push(`Email: ${row.email}`);
      lines.push(`Phone: ${row.phone || '(blank)'}`);
      lines.push(`Tags: ${row.tags.join(', ') || '(none)'}`);
      lines.push(`Matched Line Items: ${row.matchedRowCount}`);
      lines.push(`Matched Orders: ${row.matchedOrders.join(', ')}`);
      lines.push(`Matched Products: ${row.matchedProducts.join('; ')}`);
      lines.push(`Matched Fulfillment Dates: ${row.matchedFulfillmentDates.join(', ')}`);
      lines.push('');
    }
  }

  if (testing) {
    lines.push('TESTING MODE: production recipient is also jdeck88@gmail.com for this report.');
  }

  return lines.join('\n');
}

async function runDairyMonitor(fulfillmentDate, testing = false) {
  try {
    // In testing mode, reuse existing order export if already present.
    const overwriteExisting = !testing;
    const ordersFilePath = await utilities.downloadOrdersCsv(
      fulfillmentDate.start,
      fulfillmentDate.end,
      overwriteExisting
    );

    const customersFilePath = await downloadCustomersCsv(fulfillmentDate, testing);
    const customerTagMap = await buildCustomerTagMap(customersFilePath);
    const results = await collectDairyMembers(ordersFilePath, customerTagMap);
    const reportPath = await writeReportPdf(results, fulfillmentDate);
    const bodyText = buildEmailText(
      results,
      fulfillmentDate,
      ordersFilePath,
      customersFilePath,
      testing
    );

    const emailOptions = {
      from: 'jdeck88@gmail.com',
      to: testing ? TEST_TO_EMAIL : PROD_TO_EMAIL,
      cc: testing ? undefined : PROD_CC_EMAIL,
      subject: `${testing ? '[TEST] ' : ''}FFCSA Report: Dairy Monitor for ${fulfillmentDate.end}`,
      text: bodyText,
      attachments: [
        {
          filename: path.basename(reportPath),
          content: fs.readFileSync(reportPath),
        },
      ],
    };

    await utilities.sendEmail(emailOptions);
    console.log(`Dairy monitor complete. Matched members: ${results.length}`);
  } catch (error) {
    console.error('An error occurred in dairy_monitor:', error);
    utilities.sendErrorEmail(error);
  }
}

const fullfillmentDateObject = utilities.getNextFullfillmentDate();
// Set to true for testing behavior:
// - Subject includes [TEST]
// - Existing orders CSV is reused (no overwrite)
const TESTING = true;
runDairyMonitor(fullfillmentDateObject, TESTING);
