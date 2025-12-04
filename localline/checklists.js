// Using the following get the "access" property
var request = require('request');
const fs = require('fs');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const utilities = require('./utilities');

// Global testing flag (set near bottom before calling checklist)
let TESTING = false;

// Helper to only log when TESTING is true
function debugLog(...args) {
  if (TESTING) {
    console.log(...args);
  }
}

function formatPhoneNumber(phoneNumber) {
  if (!phoneNumber) return '';
  // Remove all non-digit characters
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length < 10) return phoneNumber; // fallback if weird

  // Format into (XXX) XXX-XXXX
  return `(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6)}`;
}

async function writeChecklistPDF(delivery_order_file_path, manualDispositions = {}) {
  return new Promise((resolve, reject) => {
    debugLog('[writeChecklistPDF] starting with file:', delivery_order_file_path);

    const pdf_file = 'data/dropsite_checklist.pdf';

    // Create stream + DOC and wire events BEFORE writing
    const writeStream = fs.createWriteStream(pdf_file);
    const doc = new PDFDocument();
    doc.pipe(writeStream);

    writeStream.on('finish', () => {
      debugLog('[writeChecklistPDF] PDF created successfully at', pdf_file);
      resolve(pdf_file);
    });

    writeStream.on('error', (err) => {
      console.error('[writeChecklistPDF] writeStream error:', err);
      reject(err);
    });

    doc.on('error', (err) => {
      console.error('[writeChecklistPDF] doc error:', err);
      reject(err);
    });

    // Initialize variables to group items by "Fulfillment Name"
    const dropsites = {};
    const dropsitesAll = {};

    const masterdropsites = {};
    const sortedData = [];

    fs.createReadStream(delivery_order_file_path)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => {
        sortedData.push(row);
      })
      .on('end', () => {
        debugLog('[writeChecklistPDF] CSV rows loaded:', sortedData.length);

        try {
          // Sort the data by Fulfillment Name, then Last Name
          sortedData.sort((a, b) => {
            const siteCompare = (a['Fulfillment Name'] || '').localeCompare(
              b['Fulfillment Name'] || ''
            );
            if (siteCompare !== 0) return siteCompare;

            const lastA = a['Last Name'] || '';
            const lastB = b['Last Name'] || '';
            return lastA.localeCompare(lastB);
          });

          // Set disposition based on MANUAL_DISPOSITIONS or Packing Tag
          sortedData.forEach((item) => {
            const productId = String(item['Product ID'] || '').trim(); // <-- important
            const manual = manualDispositions[productId];
			const manualLower = (manual || '').toLowerCase();

            //if (manual === 'Dairy' || manual === 'Frozen' || manual === 'Tote') {
			if (manualLower === 'dairy' || manualLower === 'frozen' || manualLower === 'tote') {
              item.disposition = manualLower;
			  console.log('manually setting frozen for ' + productId)
            } else {
              const tag = (item['Packing Tag'] || '').trim().toLowerCase();
              if (tag === 'dairy') {
                item.disposition = 'dairy';
              } else if (tag === 'frozen') {
                item.disposition = 'frozen';
              } else {
                item.disposition = 'tote';
              }
            }
          });

          let currentDropsiteName = null;
          let currentCustomerName = null;

          // Build dropsites -> customers -> items
          sortedData.forEach((row) => {
            const dropsiteName = row['Fulfillment Name'];
            if (!dropsiteName) return;

            const disposition = row.disposition || 'tote';

            const lastName = row['Last Name']?.trim() || '';
            const firstName = row['First Name']?.trim() || '';
            const formattedName = `${lastName}, ${firstName}`;
            const phone = row['Phone'] || '';

            const customerName = `${formattedName}\n${formatPhoneNumber(phone)}`;

            let quantity = Math.round(parseFloat(row['Quantity'] || '0')) || 0;
            const numItems = Math.round(parseFloat(row['# of Items'] || '0')) || 0;
            if (numItems > 1 && quantity === 1) {
              quantity = numItems;
            }

            const product = `${row['Product']} - ${row['Package Name']}`;
            const itemUnit = row['Item Unit'];
            const customerPhone = row['Phone'];

            if (dropsiteName !== currentDropsiteName) {
              currentDropsiteName = dropsiteName;
              dropsites[dropsiteName] = {
                customers: {},
              };
              masterdropsites[dropsiteName] = [];
              dropsitesAll[dropsiteName] = {
                customers: {},
              };
            }

            if (customerName !== currentCustomerName) {
              currentCustomerName = customerName;
              dropsites[dropsiteName].customers[customerName] = [];
              dropsitesAll[dropsiteName].customers[customerName] = [];
            }

            dropsites[dropsiteName].customers[customerName].push({
              name: customerName,
              phone: customerPhone,
              quantity,
              product,
              itemUnit,
              disposition,
            });

            dropsitesAll[dropsiteName].customers[customerName].push({
              name: customerName,
              phone: customerPhone,
              quantity,
              product,
              itemUnit,
              disposition,
            });
          });

          // Aggregate per-customer disposition counts per dropsite
          for (const dropsiteName in dropsites) {
            for (const customerName in dropsites[dropsiteName].customers) {
              const customerData = dropsites[dropsiteName].customers[customerName];

              const dispositionCounts = customerData.reduce((accumulator, item) => {
                const disp = item.disposition;
                if (disp === 'dairy') {
                  accumulator[disp] = (accumulator[disp] || 0) + item.quantity;
                } else if (disp === 'tote' || disp === 'frozen') {
                  // count presence as 1
                  accumulator[disp] = 1;
                }
                return accumulator;
              }, {});

              dropsites[dropsiteName].customers[customerName] = {
                ...dispositionCounts,
              };
            }
          }

          // Per-dropsite manifests
          for (const dropsiteName in dropsites) {
            const tableData = Object.entries(dropsites[dropsiteName].customers).map(
              ([name, values]) => ({
                name,
                tote: values.tote || '',
                dairy: values.dairy || '',
                frozen: values.frozen || '',
              })
            );

            masterdropsites[dropsiteName] = tableData;

            // Pagination per dropsite
            const rowsPerPage = 22;
            const totalPages = Math.ceil(tableData.length / rowsPerPage);

            let page = 1;
            for (let i = 0; i < tableData.length; i += rowsPerPage) {
              if (dropsiteName.toLowerCase().includes('membership purchase')) {
                continue; // Skip this dropsite
              }

              // Header: fulfillment date
              doc.fontSize(12).text(fullfillmentDateObject.date, { align: 'right' });

              // Title
              const title = `${dropsiteName} Manifest - Page ${page} of ${totalPages}`;
              doc.fontSize(16).text(title, { bold: true });

              const tableOptions = {
                headers: ['Name', 'Tote', 'Dairy', 'Frozen'],
                rows: tableData
                  .slice(i, i + rowsPerPage)
                  .map((row) => [row.name, row.tote, row.dairy, row.frozen]),
              };

              doc.table(tableOptions);
              doc.addPage();
              page++;
            }
          }

          // Master Checklist Table (overall totals per dropsite)
          for (const dropsiteName in masterdropsites) {
            const dropsiteData = masterdropsites[dropsiteName];
            const sums = dropsiteData.reduce(
              (accumulator, current) => {
                accumulator.tote += current.tote || 0;
                accumulator.dairy += current.dairy || 0;
                accumulator.frozen += current.frozen || 0;
                return accumulator;
              },
              { tote: 0, dairy: 0, frozen: 0 }
            );

            masterdropsites[dropsiteName] = sums;
          }

          doc.fontSize(12).text(fullfillmentDateObject.date, { align: 'right' });
          doc.fontSize(16).text('Master Manifest', { bold: true });

          const masterTableData = [
            ...Object.entries(masterdropsites).map(([dropsite, values]) => [
              dropsite,
              values.tote,
              values.dairy,
              values.frozen,
            ]),
          ];

          const masterTableOptions = {
            headers: ['Dropsite', 'Tote', 'Dairy', 'Frozen'],
            rows: masterTableData,
          };
          doc.table(masterTableOptions);
          doc.addPage();

          // Product-specific packlists
          productSpecificPackList(doc, dropsitesAll, 'frozen');
          doc.addPage();
          productSpecificPackList(doc, dropsitesAll, 'dairy');

          debugLog('[writeChecklistPDF] calling doc.end()');
          doc.end();
        } catch (err) {
          console.error('[writeChecklistPDF] synchronous error while building PDF:', err);
          reject(err);
        }
      })
      .on('error', (error) => {
        console.error('[writeChecklistPDF] Error reading delivery orders CSV:', error);
        reject(error);
      });
  });
}

function productSpecificPackList(doc, dropsitesAll, disposition) {
  for (const dropsiteName in dropsitesAll) {
    const selectedCustomers = {};

    // 1️⃣ Filter customers with the specified disposition
    for (const customerName in dropsitesAll[dropsiteName].customers) {
      const customerData = dropsitesAll[dropsiteName].customers[customerName];
      const filteredProducts = customerData.filter(
        (item) => item.disposition === disposition
      );

      if (filteredProducts.length > 0) {
        selectedCustomers[customerName] = filteredProducts;
      }
    }

    // 2️⃣ Skip dropsites without matching products
    if (Object.keys(selectedCustomers).length === 0) continue;

    // 3️⃣ Build full table with dividers
    let allCustomersTable = [];
    for (const customerName in selectedCustomers) {
      const customerData = selectedCustomers[customerName];

      const customerRows = customerData.map((item) => [
        customerName,
        item.product,
        item.itemUnit,
        item.quantity,
      ]);

      if (allCustomersTable.length > 0) {
        allCustomersTable.push([' ', '', '', '']); // blank row between customers
      }

      allCustomersTable.push(...customerRows);
    }

    // 4️⃣ Pagination logic
    const rowsPerPage = 22;
    const totalPages = Math.ceil(allCustomersTable.length / rowsPerPage);

    let page = 1;
    for (let i = 0; i < allCustomersTable.length; i += rowsPerPage) {
      if (i > 0) doc.addPage(); // Add page after first

      // Header Info
      doc.fontSize(12).text(fullfillmentDateObject.date, { align: 'right' });

      const title = `${dropsiteName} ${capitalize(
        disposition
      )} Product Packlist, Page ${page} of ${totalPages}`;
      doc.fontSize(14).text(title, { bold: true });

      // Table
      const tableOptions = {
        headers: ['Name', 'Product', 'Unit', 'Quantity'],
        rows: allCustomersTable.slice(i, i + rowsPerPage),
      };

      doc.table(tableOptions);

      page++;
    }

    // 5️⃣ Add a page break AFTER finishing each dropsite packlist
    doc.addPage();
  }
}

// Helper to capitalize disposition
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Email helper with TESTING support + detailed logging (gated)
function sendEmail(file_location, filename, subject, testing = false) {
  debugLog('[sendEmail] called with args:', {
    file_location,
    filename,
    subject,
    testing,
  });

  const emailOptions = {
    from: 'jdeck88@gmail.com',
    subject,
    text: 'Please see the attached file.  Reports are generated twice per week in advance of fullfillment dates.',
    attachments: [
      {
        filename,
        content: fs.readFileSync(file_location),
      },
    ],
  };

  if (testing) {
    // TESTING: only send to John
    emailOptions.to = 'jdeck88@gmail.com';
  } else {
    emailOptions.to = 'fullfarmcsa@deckfamilyfarm.com';
    emailOptions.cc = 'jdeck88@gmail.com, deckfamilyfarm@gmail.com';
  }

  debugLog('[sendEmail] emailOptions:', emailOptions);

  try {
    const maybePromise = utilities.sendEmail(emailOptions);
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise
        .then(() => debugLog('[sendEmail] utilities.sendEmail resolved'))
        .catch((err) =>
          console.error('[sendEmail] utilities.sendEmail rejected:', err)
        );
    } else {
      debugLog('[sendEmail] utilities.sendEmail called (non-promise)');
    }
  } catch (err) {
    console.error('[sendEmail] synchronous error:', err);
  }
}

// Build all check-lists
async function checklist(fullfillmentDate, testing = false, manualDispositions = {}) {
  try {
    debugLog(
      '[checklist] running checklist builder for date:',
      fullfillmentDate,
      'testing =',
      testing
    );

    const overwriteExisting = false;

    // Use the same helper as delivery_orders to get the orders CSV
    const delivery_order_file_path = await utilities.downloadOrdersCsv(
      fullfillmentDate.start,
      fullfillmentDate.end,
      overwriteExisting
    );

    debugLog('[checklist] Using orders CSV:', delivery_order_file_path);

    if (!delivery_order_file_path || !fs.existsSync(delivery_order_file_path)) {
      console.error(
        '[checklist] orders CSV does not exist:',
        delivery_order_file_path
      );
      return;
    }

    const checklist_pdf = await writeChecklistPDF(
      delivery_order_file_path,
      manualDispositions
    );
    debugLog('[checklist] Checklist PDF ready at:', checklist_pdf);

    debugLog('[checklist] about to call sendEmail');
    sendEmail(
      checklist_pdf,
      'manifests.pdf',
      'FFCSA Reports: Delivery Manifests for ' + fullfillmentDate.date,
      testing
    );
    debugLog('[checklist] sendEmail() call returned');
  } catch (error) {
    console.error('[checklist] A general error occurred in checklist:', error);
    utilities.sendErrorEmail(error);
  }
}

// ----- CONFIG CONSTANTS (easy to tweak) -----

// Product IDs that should be forced to a disposition, regardless of Packing Tag
// (add more as needed; values must be 'frozen', 'dairy', or 'tote')
// Bundles DO NOT have Package Tags yet so here we add them in manually
const MANUAL_DISPOSITIONS = {
  '1023667': 'Frozen',
  '1017942': 'Frozen', 
  '1017951': 'Frozen', 
  // add more here, e.g.:
  // '1234567': 'dairy',
};

// Run the checklist script
/*
const fullfillmentDateObject = {
  start: '2025-12-02',
  end: '2025-12-02',
  date: '2025-12-02'
};
*/
let fullfillmentDateObject = utilities.getNextFullfillmentDate();

// 👉 flip this to false when ready to send to full recipients
TESTING = false;

checklist(fullfillmentDateObject, TESTING, MANUAL_DISPOSITIONS);

