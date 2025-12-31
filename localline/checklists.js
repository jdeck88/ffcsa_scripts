// Using the following get the "access" property
var request = require('request');
const fs = require('fs');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const utilities = require('./utilities');
const path = require('path');

// Global testing flag (set near bottom before calling checklist)
let TESTING = false;

// Shared manual dispositions map (from manual_dispositions.json)
let MANUAL_DISPOSITIONS = {};
const manualDispositionsPath = path.join(__dirname, 'manual_dispositions.json');
try {
  if (fs.existsSync(manualDispositionsPath)) {
    MANUAL_DISPOSITIONS = JSON.parse(
      fs.readFileSync(manualDispositionsPath, 'utf8')
    );
  }
} catch (err) {
  console.error('[optimaroute] Error reading manual_dispositions.json:', err);
}

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

/**
 * Build the main manifests PDF (dropsite manifests + master manifest)
 * Writes to data/dropsite_checklist.pdf
 */
async function writeChecklistPDF(delivery_order_file_path, manualDispositions = {}) {
  return new Promise((resolve, reject) => {
    debugLog('[writeChecklistPDF] starting with file:', delivery_order_file_path);

    const pdf_file = 'data/dropsite_checklist.pdf';

    // Create stream + DOC and wire events BEFORE writing
    const writeStream = fs.createWriteStream(pdf_file);
    const doc = new PDFDocument({ bufferPages: true });
    doc.pipe(writeStream);
    const pageNumbering = new Map();

    const currentPageIndex = () => {
      const range = doc.bufferedPageRange();
      return range.start + range.count - 1;
    };

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

            if (manualLower === 'dairy' || manualLower === 'frozen' || manualLower === 'tote') {
              item.disposition = manualLower;
              console.log('manually setting frozen for ' + productId);
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
          //doc.addPage();

          // ✅ No longer write product-specific packlists into this PDF.
          // Those are now generated separately in packlists.pdf.
          debugLog('[writeChecklistPDF] calling doc.end() (manifests only)');
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

/**
 * Build a separate PDF for frozen + dairy packlists only.
 * Writes to data/packlists.pdf
 */
async function writePacklistsPDF(delivery_order_file_path, manualDispositions = {}) {
  return new Promise((resolve, reject) => {
    debugLog('[writePacklistsPDF] starting with file:', delivery_order_file_path);

    const pdf_file = 'data/packlists.pdf';

    const writeStream = fs.createWriteStream(pdf_file);
    const doc = new PDFDocument({ bufferPages: true });
    doc.pipe(writeStream);
    const pageNumbering = new Map();

    const currentPageIndex = () => {
      const range = doc.bufferedPageRange();
      return range.start + range.count - 1;
    };

    writeStream.on('finish', () => {
      debugLog('[writePacklistsPDF] PDF created successfully at', pdf_file);
      resolve(pdf_file);
    });

    writeStream.on('error', (err) => {
      console.error('[writePacklistsPDF] writeStream error:', err);
      reject(err);
    });

    doc.on('error', (err) => {
      console.error('[writePacklistsPDF] doc error:', err);
      reject(err);
    });

    const dropsitesAll = {};
    const sortedData = [];

    fs.createReadStream(delivery_order_file_path)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => {
        sortedData.push(row);
      })
      .on('end', () => {
        debugLog('[writePacklistsPDF] CSV rows loaded:', sortedData.length);

        try {
          // Sort by Fulfillment Name, then Last Name
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
            const productId = String(item['Product ID'] || '').trim();
            const manual = manualDispositions[productId];
            const manualLower = (manual || '').toLowerCase();

            if (manualLower === 'dairy' || manualLower === 'frozen' || manualLower === 'tote') {
              item.disposition = manualLower;
              console.log('manually setting frozen for ' + productId);
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

          // Build dropsitesAll -> customers -> items (used for packlists)
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
              dropsitesAll[dropsiteName] = { customers: {} };
            }

            if (customerName !== currentCustomerName) {
              currentCustomerName = customerName;
              dropsitesAll[dropsiteName].customers[customerName] = [];
            }

            dropsitesAll[dropsiteName].customers[customerName].push({
              name: customerName,
              phone: customerPhone,
              quantity,
              product,
              itemUnit,
              disposition,
            });
          });

          // Product-specific packlists into this separate PDF
          productSpecificPackList(doc, dropsitesAll, 'frozen', pageNumbering, currentPageIndex);
          doc.addPage();
          productSpecificPackList(doc, dropsitesAll, 'dairy', pageNumbering, currentPageIndex);

          const pageRange = doc.bufferedPageRange();
          for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
            const info = pageNumbering.get(i);
            if (!info) continue;
            doc.switchToPage(i);
            doc.font('Helvetica').fontSize(11)
              .text(
                `Page ${info.page} of ${info.total}  ${info.date}`,
                doc.page.margins.left,
                8,
                {
                  width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
                  align: 'right',
                }
              );
          }

          debugLog('[writePacklistsPDF] calling doc.end()');
          doc.end();
        } catch (err) {
          console.error('[writePacklistsPDF] synchronous error while building packlists PDF:', err);
          reject(err);
        }
      })
      .on('error', (error) => {
        console.error('[writePacklistsPDF] Error reading delivery orders CSV:', error);
        reject(error);
      });
  });
}

function productSpecificPackList(doc, dropsitesAll, disposition, pageNumbering, currentPageIndex) {
  // 0️⃣ Build a list of dropsites *that actually have* this disposition
  const dropsiteNames = Object.keys(dropsitesAll).filter((dropsiteName) => {
    const customers = dropsitesAll[dropsiteName]?.customers || {};
    for (const customerName in customers) {
      const customerData = customers[customerName];
      if (customerData.some((item) => item.disposition === disposition)) {
        return true;
      }
    }
    return false;
  });

  const drawHeader = (dropsiteName, orderCount) => {
    doc.y = Math.max(doc.y, doc.page.margins.top + 6);
    const headerY = doc.y;
    const lineWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const title = `${disposition.toUpperCase()} ${dropsiteName}`;
    const titleHeight = doc.font('Helvetica-Bold').fontSize(16)
      .heightOfString(title, { width: lineWidth });

    doc.font('Helvetica-Bold').fontSize(16)
      .text(title, doc.page.margins.left, headerY, { width: lineWidth, align: 'left' });

    doc.y = headerY + titleHeight + 6;
    doc.font('Helvetica').fontSize(11);
    const headerLineY = doc.y;
    if (disposition === 'frozen') {
      doc.text('# of bags in cooler:', doc.page.margins.left, headerLineY, { align: 'left' });
      doc.text(`# of orders: ${orderCount}`, doc.page.margins.left, headerLineY, { align: 'right' });
    } else {
      doc.text(`# of orders: ${orderCount}`, doc.page.margins.left, headerLineY, { align: 'left' });
    }
    doc.moveDown(0.2);
    doc.text('Packed By:');
    doc.moveDown(0.6);
  };

  const leftMargin = doc.page.margins.left;
  const rightMargin = doc.page.margins.right;
  const lineWidth = doc.page.width - leftMargin - rightMargin;
  const indent = 20;

  // 1️⃣ Loop with index so we know if we're on the last one
  dropsiteNames.forEach((dropsiteName, idx) => {
    const selectedCustomers = {};

    // Filter customers with the specified disposition
    const customers = dropsitesAll[dropsiteName]?.customers || {};
    for (const customerName in customers) {
      const customerData = customers[customerName];
      const filteredProducts = customerData.filter(
        (item) => item.disposition === disposition
      );
      if (filteredProducts.length > 0) {
        selectedCustomers[customerName] = filteredProducts;
      }
    }

    const sortedCustomerNames = Object.keys(selectedCustomers).sort((a, b) =>
      a.localeCompare(b)
    );

    // If somehow no customers, skip this dropsite (shouldn't usually happen due to filter above)
    if (sortedCustomerNames.length === 0) return;

    // 👉 Page break *between* dropsites, but not before the first
    if (idx > 0) {
      doc.addPage();
    }

    const dropsiteStartPage = currentPageIndex();
    drawHeader(dropsiteName, sortedCustomerNames.length);

    const pageBottom = doc.page.height - doc.page.margins.bottom;

    sortedCustomerNames.forEach((customerName, customerIdx) => {
      const customerData = selectedCustomers[customerName];
      const [nameLine, phoneLine = ''] = customerName.split('\n');
      const titleLine = phoneLine
        ? `${nameLine}  ${phoneLine}`
        : nameLine;

      doc.font('Helvetica-Bold').fontSize(12);
      const nameHeight = doc.heightOfString(titleLine, { width: lineWidth });

      const productWidth = Math.floor(lineWidth * 0.7);
      const qtyWidth = Math.floor(lineWidth * 0.15);
      const packedWidth = lineWidth - productWidth - qtyWidth;
      const rowHeight = doc.font('Helvetica').fontSize(10)
        .heightOfString('A', { width: productWidth }) + 6;
      const tableHeaderHeight = doc.font('Helvetica-Bold').fontSize(10)
        .heightOfString('Product', { width: productWidth }) + 8;
      const productsHeight = (customerData.length * rowHeight) + tableHeaderHeight;

      const blockHeight = nameHeight + productsHeight + 8;
      if (doc.y + blockHeight > pageBottom) {
        doc.addPage();
        drawHeader(dropsiteName, sortedCustomerNames.length);
      }

      const productIndent = '   ';
      const tableRows = customerData.map((item) => [
        `${productIndent}${item.product}`,
        item.quantity,
        '',
      ]);

      const tableOptions = {
        headers: [titleLine, 'Qty', 'Packed'],
        rows: tableRows,
      };

      doc.table(tableOptions, {
        x: leftMargin,
        y: doc.y,
        absolutePosition: true,
        columnsSize: [productWidth, qtyWidth, packedWidth],
        columnSpacing: 4,
        padding: 2,
        prepareHeader: () => doc.font('Helvetica-Bold').fontSize(10),
        prepareRow: () => doc.font('Helvetica').fontSize(10),
      });
      doc.x = leftMargin;

      if (customerIdx < sortedCustomerNames.length - 1) {
        doc.moveDown(0.2);
      }
    });

    const dropsiteEndPage = currentPageIndex();
    const totalPages = dropsiteEndPage - dropsiteStartPage + 1;
    for (let i = 0; i < totalPages; i++) {
      pageNumbering.set(dropsiteStartPage + i, {
        page: i + 1,
        total: totalPages,
        date: fullfillmentDateObject.date,
      });
    }
  });
}

// Helper to capitalize disposition
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Email helper with TESTING support + [TEST] prefix in subject
function sendEmail(file_location, filename, subject, testing = false) {
  debugLog('[sendEmail] called with args:', {
    file_location,
    filename,
    subject,
    testing,
  });

  const finalSubject = testing ? `[TEST] ${subject}` : subject;

  const emailOptions = {
    from: 'jdeck88@gmail.com',
    subject: finalSubject,
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

// Build all check-lists + packlists, and email them
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

    const packlists_pdf = await writePacklistsPDF(
      delivery_order_file_path,
      manualDispositions
    );
    debugLog('[checklist] Packlists PDF ready at:', packlists_pdf);

    debugLog('[checklist] about to call sendEmail for manifests');
    sendEmail(
      checklist_pdf,
      'manifests.pdf',
      'FFCSA Reports: Delivery Manifests for ' + fullfillmentDate.date,
      testing
    );

    debugLog('[checklist] about to call sendEmail for packlists');
    sendEmail(
      packlists_pdf,
      'packlists.pdf',
      'FFCSA Reports: Frozen and Dairy Packlists for ' + fullfillmentDate.date,
      testing
    );

    debugLog('[checklist] sendEmail() calls returned');
  } catch (error) {
    console.error('[checklist] A general error occurred in checklist:', error);
    utilities.sendErrorEmail(error);
  }
}

// ----- CONFIG CONSTANTS (easy to tweak) -----


/*
const fullfillmentDateObject = {
  start: '2025-12-30',
  end: '2025-12-30',
  date: '2025-12-30'
};
*/

let fullfillmentDateObject = utilities.getNextFullfillmentDate();

// 👉 flip this to false when ready to send to full recipients
TESTING = false;

checklist(fullfillmentDateObject, TESTING, MANUAL_DISPOSITIONS);
