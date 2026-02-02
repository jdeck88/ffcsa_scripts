const request = require('request');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const fastcsv = require('fast-csv');
const utilities = require('./utilities');
const ExcelJS = require('exceljs');

/* =========================
 * Config / constants
 * ========================= */

// Shared manual dispositions map (from manual_dispositions.json)
let MANUAL_DISPOSITIONS = {};
let MANUAL_DISPOSITIONS_LOWER = new Map();
const manualDispositionsPath = path.join(__dirname, 'manual_dispositions.json');
try {
  if (fs.existsSync(manualDispositionsPath)) {
    MANUAL_DISPOSITIONS = JSON.parse(
      fs.readFileSync(manualDispositionsPath, 'utf8')
    );
    MANUAL_DISPOSITIONS_LOWER = buildLowercaseMap(MANUAL_DISPOSITIONS);
  }
} catch (err) {
  console.error('[optimaroute] Error reading manual_dispositions.json:', err);
}

// Global cache for fulfillment strategies JSON
let fulfillment_json = { results: [] };

/* =========================
 * Helpers
 * ========================= */

function buildLowercaseMap(manualDispositions) {
  const map = new Map();
  for (const [key, value] of Object.entries(manualDispositions || {})) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (normalizedKey) {
      map.set(normalizedKey, value);
    }
  }
  return map;
}

// Helper to format phone numbers
function formatPhoneNumber(phoneNumber) {
  if (!phoneNumber) return '';
  let digits = phoneNumber.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.substring(1);
  }
  if (digits.length !== 10) return phoneNumber; // fallback if weird
  return `(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6)}`;
}

// Writes data to an XLSX file and returns a Promise
async function writeXLSX(rows, outputPath) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sheet1');

  worksheet.addRow([
    'name/dropsite',
    'Phone',
    'Email',
    'Address',
    'Instructions',
    'Tote',
    'Frozen',
    'Dairy',
  ]);

  rows.forEach((row) => worksheet.addRow(row));

  await workbook.xlsx.writeFile(outputPath);
}

// Decide disposition for a single row based on manual_dispositions + Packing Tag
function computeDispositionForRow(row) {
  const productId = (row['Product ID'] || '').toString().trim();
  const productName = (row['Product'] || '').toString().trim();

  let manualRaw = MANUAL_DISPOSITIONS[productId];
  if (!manualRaw && productName) {
    manualRaw = MANUAL_DISPOSITIONS[productName];
  }
  if (!manualRaw && MANUAL_DISPOSITIONS_LOWER) {
    if (productId) {
      manualRaw = MANUAL_DISPOSITIONS_LOWER.get(productId.toLowerCase());
    }
    if (!manualRaw && productName) {
      manualRaw = MANUAL_DISPOSITIONS_LOWER.get(productName.toLowerCase());
    }
  }
  const manualLower = (manualRaw || '').toLowerCase();

  if (manualLower === 'dairy' || manualLower === 'frozen' || manualLower === 'tote') {
    return manualLower;
  }

  const tag = (row['Packing Tag'] || '').trim().toLowerCase();
  if (tag === 'dairy') return 'dairy';
  if (tag === 'frozen') return 'frozen';
  return 'tote';
}

/* =========================
 * Core XLSX builder
 * ========================= */

async function writeOptimarouteXLSX(deliveryOrderFilePath) {
  const xlsxFile = 'data/optimaroute.xlsx';
  const sortedData = [];

  return new Promise((resolve, reject) => {
    fs.createReadStream(deliveryOrderFilePath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => sortedData.push(row))
      .on('end', async () => {
        try {
          // Sort by Fulfillment Name for consistency
          sortedData.sort((a, b) =>
            (a['Fulfillment Name'] || '').localeCompare(b['Fulfillment Name'] || '')
          );

          // Compute disposition for each row
          sortedData.forEach((item) => {
            item.disposition = computeDispositionForRow(item);
          });

          const customerGroups = groupOrdersByCustomer(sortedData);
          const rows = flattenCustomerGroups(customerGroups);

          await writeXLSX(rows, xlsxFile);
          resolve(xlsxFile);
        } catch (error) {
          console.error('[writeOptimarouteXLSX] error building XLSX:', error);
          reject(error);
        }
      })
      .on('error', (err) => {
        console.error('[writeOptimarouteXLSX] CSV read error:', err);
        reject(err);
      });
  });
}

/* =========================
 * Grouping / flattening
 * ========================= */

// Groups orders by customer name and address
function groupOrdersByCustomer(updatedData) {
  const customerGroups = {};

  updatedData.forEach((row) => {
    const lastName = (row['Last Name'] || '').trim();
    const firstName = (row['First Name'] || '').trim();
    const customerName = `${lastName}, ${firstName}`;

    const deliveryAddress = (row['Fulfillment Address'] || '').trim();
    if (!deliveryAddress) return;

    const key = `${customerName} - ${deliveryAddress}`.toLowerCase();

    if (!customerGroups[key]) {
      const isPickup = row['Fulfillment Type'] === 'pickup';
      customerGroups[key] = {
        nameOrDropsite: isPickup
          ? `${row['Fulfillment Name']} Dropsite (${customerName})`
          : customerName,
        customerPhone: formatPhoneNumber(row['Phone']),
        customerEmail: row['Email'],
        deliveryAddress,
        instructions: isPickup
          ? getInstructionsByName(fulfillment_json, row['Fulfillment Name'])
          : row['About This Customer'],
        tote: 0,
        frozen: 0,
        dairy: 0,
      };
    }

    let quantity = Math.round(parseFloat(row['Quantity'] || '0')) || 0;
    const numItems = Math.round(parseFloat(row['# of Items'] || '0')) || 0;
    if (numItems > 1 && quantity === 1) {
      quantity = numItems;
    }

    if (row.disposition === 'tote') {
      customerGroups[key].tote = 1;
    }
    if (row.disposition === 'frozen') {
      customerGroups[key].frozen = 1;
    }
    if (row.disposition === 'dairy') {
      customerGroups[key].dairy += quantity;
    }
  });

  return customerGroups;
}

// Flattens customer groups for XLSX output
function flattenCustomerGroups(customerGroups) {
  const rows = [];
  for (const key in customerGroups) {
    const group = customerGroups[key];
    // Skip farm/online delivery addresses
    if (
      group.deliveryAddress.includes('25362 High Pass') ||
      group.deliveryAddress.includes('ONLINE DELIVERY')
    ) {
      continue;
    }
    rows.push([
      group.nameOrDropsite,
      group.customerPhone,
      group.customerEmail,
      group.deliveryAddress,
      group.instructions,
      group.tote ? 1 : '',
      group.frozen ? 1 : '',
      group.dairy || '',
    ]);
  }
  return rows;
}

/* =========================
 * Email helper (with TESTING)
 * ========================= */

function sendEmail(filePath, filename, subject, testing = false) {
  const emailOptions = {
    from: 'fullfarmcsa@deckfamilyfarm.com',
    subject,
    text:
      'Please see the attached file for OptimaRoute. This is a new file that contains individual orders for each dropsite.',
    attachments: [
      {
        filename,
        content: fs.readFileSync(filePath),
      },
    ],
  };

  if (testing) {
    emailOptions.to = 'jdeck88@gmail.com';
  } else {
    emailOptions.to = 'fullfarmcsa@deckfamilyfarm.com';
    emailOptions.cc = 'jdeck88@gmail.com';
  }

  utilities.sendEmail(emailOptions);
}

/* =========================
 * Fulfillment instructions helper
 * ========================= */

function getInstructionsByName(json, name) {
  if (!json || !json.results) return null;
  const result = json.results.find((item) => item.name === name);
  if (result && result.availability && result.availability.instructions) {
    return result.availability.instructions;
  }
  return null;
}

/* =========================
 * Main entry
 * ========================= */

async function optimaroute(fullfillmentDateObject, testing = false) {
  try {
    console.log(
      '[optimaroute] running for',
      fullfillmentDateObject.date,
      'testing =',
      testing
    );

    const overwriteExisting = false;

    // Use the shared helper to get orders CSV
    const deliveryOrderPath = await utilities.downloadOrdersCsv(
      fullfillmentDateObject.start,
      fullfillmentDateObject.end,
      overwriteExisting
    );

    if (!deliveryOrderPath || !fs.existsSync(deliveryOrderPath)) {
      console.error(
        '[optimaroute] orders CSV not found at path:',
        deliveryOrderPath
      );
      return;
    }

    // Login + fetch fulfillment strategies
    const accessToken = JSON.parse(await utilities.getAccessToken()).access;
    fulfillment_json = await utilities.getJsonFromUrl(
      'https://localline.ca/api/backoffice/v2/fulfillment-strategies/',
      accessToken
    );

    const xlsxFile = await writeOptimarouteXLSX(deliveryOrderPath);

    sendEmail(
      xlsxFile,
      'optimaroute.xlsx',
      `FFCSA Reports: OptimaRoute File ${fullfillmentDateObject.date}`,
      testing
    );
  } catch (error) {
    console.error('[optimaroute] error:', error);
    utilities.sendErrorEmail(error);
  }
}

/* =========================
 * Script runner
 * ========================= */

// Example manual_dispositions.json (in same dir):
// {
//   "1023667": "Frozen",
//   "1017942": "Frozen",
//   "1017951": "Frozen"
// }

const fullfillmentDateObject = utilities.getNextFullfillmentDate();

// 👉 flip this to false when ready to send to full recipients
const TESTING = false;

optimaroute(fullfillmentDateObject, TESTING);
