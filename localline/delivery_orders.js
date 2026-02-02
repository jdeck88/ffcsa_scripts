var request = require('request');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const ExcelJS = require('exceljs');
const utilities = require('./utilities');
const contentLeft = 54; // 0.75"
const contentRight = 54;

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
  console.error('[delivery_orders] Error reading manual_dispositions.json:', err);
}

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

function computeDispositionForRow(row, manualDispositions, manualDispositionsLower) {
  const productId = String(row['Product ID'] || '').trim();
  const productName = String(row['Product'] || '').trim();

  let manualRaw = manualDispositions[productId];
  if (!manualRaw && productName) {
    manualRaw = manualDispositions[productName];
  }
  if (!manualRaw && manualDispositionsLower) {
    if (productId) {
      manualRaw = manualDispositionsLower.get(productId.toLowerCase());
    }
    if (!manualRaw && productName) {
      manualRaw = manualDispositionsLower.get(productName.toLowerCase());
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


// Load or initialize drop site colors
function loadDropSiteColors(filePath) {
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath));
  }
  return {};
}

// Save updated drop site colors
function saveDropSiteColors(filePath, colors) {
  fs.writeFileSync(filePath, JSON.stringify(colors, null, 2));
}

// Generate random pastel color
function generateRandomPastelColor() {
  const r = Math.floor((Math.random() * 127) + 127);
  const g = Math.floor((Math.random() * 127) + 127);
  const b = Math.floor((Math.random() * 127) + 127);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

async function writeLabelPDF(csvFilePath) {
  return new Promise((resolve, reject) => {
    console.log("Starting writeLabelPDF...");

    const labelSet = new Map();
    const dropSiteColorsPath = path.join(__dirname, 'drop_site_colors.json');
    let dropSiteColors = {};

    // 1️⃣ Load existing drop site colors
    if (fs.existsSync(dropSiteColorsPath)) {
      try {
        dropSiteColors = JSON.parse(fs.readFileSync(dropSiteColorsPath, 'utf8'));
      } catch (err) {
        console.error("Error reading drop_site_colors.json:", err);
        dropSiteColors = {};
      }
    }

    // 2️⃣ Read CSV and group labels
    fs.createReadStream(csvFilePath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => {
        const firstName = row['First Name']?.trim();
        const lastName = row['Last Name']?.trim();
        const dropSiteRaw = row['Fulfillment Name']?.trim();

        if (firstName && lastName && dropSiteRaw && dropSiteRaw !== 'Membership Purchase - Fulfilled Electronically every 30 days!') {
          const normalizedDropSite = dropSiteRaw.toLowerCase();

          // Unique key per customer + drop site
          const key = `${firstName.toLowerCase()}|${lastName.toLowerCase()}|${normalizedDropSite}`;

          if (!labelSet.has(key)) {
            labelSet.set(key, {
              firstName,
              lastName,
              dropSite: normalizedDropSite
            });

            // Assign color if needed
            if (!dropSiteColors[normalizedDropSite]) {
              dropSiteColors[normalizedDropSite] = generateRandomPastelColor();
            }
          }
        }
      })
      .on('end', () => {
        const labels = Array.from(labelSet.values());
        console.log(`Parsed ${labels.length} unique labels`);

        // 3️⃣ Sort by Last Name, First Name
        labels.sort((a, b) => {
          const dropSiteCompare = a.dropSite.localeCompare(b.dropSite);
          if (dropSiteCompare !== 0) return dropSiteCompare;

          const lastNameCompare = a.lastName.localeCompare(b.lastName);
          if (lastNameCompare !== 0) return lastNameCompare;

          return a.firstName.localeCompare(b.firstName);
        });


        // 4️⃣ Generate PDF
        console.log("generating PDF")
        const doc = new PDFDocument({ margin: 0 });
        const outputPath = path.join('data', 'labels.pdf');
        const writeStream = fs.createWriteStream(outputPath);

        doc.pipe(writeStream);

        const labelWidth = 180;
        const labelHeight = 72;
        const marginLeft = 18;
        const marginTop = 36;
        const horizontalGap = 12;

        labels.forEach((label, index) => {
          // Temporary don't print label for home delivery.
          // We need to pass these into optimaroute first
          //if (label.dropSite === 'home delivery - eugene/springfield/junction city') {
          // return;  // 🚫 Skip this label
          //}
          const row = Math.floor(index / 3) % 10;
          const col = index % 3;

          const x = marginLeft + col * (labelWidth + horizontalGap);
          const y = marginTop + row * labelHeight;

          if (index > 0 && index % 30 === 0) doc.addPage();

          const footerHeight = labelHeight * 0.5;  // Bottom half for Drop Site

          //console.log(`${label.lastName}, ${label.firstName}`)
          // 1️⃣ Print Customer Name (Top Half)
          doc.font('Helvetica-Bold')
            .fillColor('black')
            .fontSize(12)
            .text(`${label.lastName}, ${label.firstName}`, x, y + 15, {
              width: labelWidth,
              align: 'center'
            });

          // 2️⃣ Draw background for Drop Site (Bottom Half)
          doc.fillColor(dropSiteColors[label.dropSite])
            .rect(x, y + footerHeight, labelWidth, footerHeight)
            .fill();

          // 3️⃣ Print Drop Site name over pastel
          dropsiteColor = 'black'
          // lcfm defaults to dark color so make text white just for this one
          if (label.dropSite.trim().toLowerCase() === 'lcfm') {
            dropsiteColor = 'white';
          }
          doc.fillColor(dropsiteColor)
            .font('Helvetica-Bold')
            .fontSize(10)
            .text(label.dropSite, x, y + footerHeight + (footerHeight / 2) - 5, {
              width: labelWidth,
              align: 'center'
            });
        });


        writeStream.on('finish', () => {
          console.log("Labels PDF generated:", outputPath);

          fs.writeFileSync(dropSiteColorsPath, JSON.stringify(dropSiteColors, null, 2), 'utf8');
          console.log("drop_site_colors.json updated.");

          resolve(outputPath);
        });

        writeStream.on('error', (err) => {
          console.error("PDF generation error:", err);
          reject(err);
        });

        // Now finalize PDF
        console.log("Ending PDF generation...");
        doc.end();

      });
  });
}

// Function to read CSV and return a promise with the ordered vendor list
// Function to read a list of vendors from a file and return a promise with the ordered vendor list
function readVendorOrder(filePath) {
  return new Promise((resolve, reject) => {
    const vendorOrder = [];

    fs.createReadStream(filePath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => {
        if (row.vendor) {
          vendorOrder.push(row);
        }
      })
      .on('end', () => {
        //console.log('Vendor order loaded:', vendorOrder);
        resolve(vendorOrder);
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

function sortItemsByLocationVendorAndProduct(items, vendorOrder, vendorLocations = {}) {
  // Create a map for quick lookup of vendor order
  const vendorOrderMap = {};
  vendorOrder.forEach((vendorObj, index) => {
    vendorOrderMap[vendorObj.vendor] = index;
  });

  const defaultOrderValue = vendorOrder.length;

  // Sort items based on location (if available), vendor order, and product name
  return items.sort((a, b) => {
    // Get the location for each vendor, default to empty string if not available
    const locationA = vendorLocations[a.vendor] || '';
    const locationB = vendorLocations[b.vendor] || '';

    // Sort by location first if vendorLocations is provided
    if (Object.keys(vendorLocations).length > 0) {
      if (locationA < locationB) {
        return -1; // a should come before b
      } else if (locationA > locationB) {
        return 1; // a should come after b
      }
    }

    // If locations are the same or if vendorLocations is not provided, sort by vendor order
    const vendorOrderA = vendorOrderMap.hasOwnProperty(a.vendor) ? vendorOrderMap[a.vendor] : defaultOrderValue;
    const vendorOrderB = vendorOrderMap.hasOwnProperty(b.vendor) ? vendorOrderMap[b.vendor] : defaultOrderValue;

    if (vendorOrderA < vendorOrderB) {
      return -1; // a should come before b
    } else if (vendorOrderA > vendorOrderB) {
      return 1; // a should come after b
    }

    // If vendors are the same, sort by product name
    if (a.product < b.product) {
      return -1; // a should come before b
    } else if (a.product > b.product) {
      return 1; // a should come after b
    }

    return 0; // a and b are equal in terms of location, vendor, and product
  });
}

async function writeCustomerNotePDF(filename, fullfillmentDateEnd) {
  const vendorOrder = await readVendorOrder('vendor_order.csv');
  return new Promise((resolve, reject) => {
    const pdf_file = 'data/customer_notes.pdf';

    // Create a new PDF document
    const doc = new PDFDocument({ bufferPages: true });
    doc.pipe(fs.createWriteStream(pdf_file));
    const pageNumbering = new Map();

    const currentPageIndex = () => {
      const range = doc.bufferedPageRange();
      return range.start + range.count - 1;
    };

    // Initialize variables to group items by "Customer Name"
    const customers = {}; // Store customer data including attributes
    let currentCustomerName = null;

    const sortedData = [];

    // Read the CSV file and sort by "Customer Name" before processing
    fs.createReadStream(filename)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => {
        sortedData.push(row);
      })
      .on('end', () => {
        // Sort the data by "Customer Name"
        //sortedData.sort((a, b) => a['Customer'].localeCompare(b['Customer']));
        sortedData.sort((a, b) => { return a['Last Name'].localeCompare(b['Last Name']); });


        // Process the sorted data
        sortedData.forEach((row) => {
          //const customerName = row['Customer'];
          const customerName = `${row['Last Name']}, ${row['First Name']}`;
          const customerNote = row['Customer Note'];
          const priceList = row['Price List'];

          // Only include customers with non-blank customer notes
          if (customerNote && customerNote.trim() !== '') {
            if (customerName !== currentCustomerName) {
              currentCustomerName = customerName;
              customers[customerName] = {
                customerNote: customerNote,
                priceList: priceList
              };
            }
          }
        });

        // Add the fulfillment date at the top, only once
        doc.font('Helvetica-Bold')
          .fontSize(16)
          .text(`Customer Notes for Fulfillment Date: ${fullfillmentDateEnd}`, { align: 'center', underline: true });
        doc.moveDown(1.5);

        // Iterate through customers and generate the PDF content
        for (const customerName in customers) {
          const customerData = customers[customerName];

          if (customerData.customerNote) {
            // Customer Name
            doc.font('Helvetica-Bold')
              .fontSize(14)
              .text(`Customer Name: ${customerName}`, { underline: true });
            doc.moveDown(0.5);

            // Customer Notes
            doc.font('Helvetica')
              .fontSize(12)
              .text(`Customer Notes: ${customerData.customerNote}`);
            doc.moveDown(1.5);

            doc.font('Helvetica')
              .fontSize(12)
              .text(`Note taken on pricelist =  ${customerData.priceList}`);
            doc.moveDown(1.5);

            // Add a line after each customer
            doc.moveTo(doc.page.margins.left, doc.y)
              .lineTo(doc.page.width - doc.page.margins.right, doc.y)
              .stroke();
            doc.moveDown(0.5);
          }
        }

        doc.end();

        // Wait for the stream to finish and then resolve with the file path
        doc.on('finish', () => {
          console.log('PDF with customer notes created successfully.');
          resolve(pdf_file);
        });

        doc.on('error', (error) => {
          console.error('PDF creation error:', error);
          reject(error);
        });

        // Temporary async method for finishing PDF creation
        setTimeout(() => {
          resolve(pdf_file); // Promise is resolved with the generated file path
        }, 1000);
      });
  });
}




async function writeSetupPDF(filename, fullfillmentDateEnd) {
  const vendorOrder = await readVendorOrder('vendor_order.csv');
  return new Promise((resolve, reject) => {
    const pdf_file = 'data/setup.pdf'

    // Create a new PDF document
    // Create a new PDF document with custom margins
    const doc = new PDFDocument({
      margin: 30 
    });
    doc.pipe(fs.createWriteStream(pdf_file));
    const vendors = {}; // Store customer data including attributes
    let currentVendor = null;
    const sortedData = [];

    // Read the CSV file and sort by "Customer Name" before processing
    fs.createReadStream(filename)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => {
        sortedData.push(row);
      })
      .on('end', () => {
        sortedData.sort((a, b) => a['Vendor'].localeCompare(b['Vendor']));
        sortedData.forEach((row) => {
          const product = row['Product'] + ' - ' + row['Package Name'];
          quantity = Math.round(parseFloat(row['Quantity']));
          const numItems = Math.round(parseFloat(row['# of Items']));
          const itemUnit = row['Item Unit']
          const vendor = row['Vendor']
          const category = row['Category']
          // account for two different methods of counting items
          if (numItems > 1 && quantity == 1) {
            quantity = numItems
          }
          if (vendor !== currentVendor) {
            currentVendor = vendor;
            vendors[vendor] = {
              products: [],
              //		quantity: quantity,
              //		category: category,
              //		vendor: vendor
            };
          }
          if (category !== 'Membership') {
            vendors[vendor].products.push({ product, quantity, category, vendor });
          }
        });


        const aggregatedData = {};
        const vendorLocations = {};

        // Create a map for vendor locations
        vendorOrder.forEach(entry => {
          vendorLocations[entry.vendor] = entry.location;
        });

        // this is a map accourding to vendorOrder
        const vendorOrderMap = {};
        vendorOrder.forEach((vendorObj, index) => {
          vendorOrderMap[vendorObj.vendor] = index;
        });


        // Aggregate data by vendor and product
        for (const vendor in vendors) {
          const data = vendors[vendor];
          if (!aggregatedData[vendor]) {
            aggregatedData[vendor] = {};
          }
          data.products.forEach(product => {
            const productName = product.product;
            const category = product.category;
            const quantity = product.quantity;
            if (!aggregatedData[vendor][productName]) {
              aggregatedData[vendor][productName] = { category, total_quantity: 0 };
            }
            aggregatedData[vendor][productName].total_quantity += quantity;
          });
        }

        // Group vendors by location and sort products within each vendor
        const sortedDataByLocation = {};

        // Initialize the buckets for each location
        Object.values(vendorLocations).forEach(location => {
          sortedDataByLocation[location] = {};
        });

        // Populate the buckets with vendors and their sorted products
        for (const vendor in aggregatedData) {
          const location = vendorLocations[vendor];
          if (location) {
            sortedDataByLocation[location][vendor] = aggregatedData[vendor];

            // Sort the products within each vendor
            const sortedProducts = {};
            Object.keys(aggregatedData[vendor]).sort().forEach(productName => {
              sortedProducts[productName] = aggregatedData[vendor][productName];
            });

            sortedDataByLocation[location][vendor] = sortedProducts;
          }
        }

        // Create PDF document
        doc.pipe(fs.createWriteStream('report.pdf'));

        doc.fontSize(18).font('Helvetica-Bold').text('Setup Instructions for ' + fullfillmentDateEnd + ' Packout', { align: 'center', underline: true });
        doc.moveDown(0.5);

        for (const location in sortedDataByLocation) {
          // Print the location name
          // Draw the line across the page
          doc.moveTo(doc.page.margins.left, doc.y)
            .lineTo(doc.page.width - doc.page.margins.right, doc.y)
            .stroke();
          doc.moveDown(0.20);

          doc.fontSize(14).font('Helvetica-Bold').fillColor('#000000').text(location, { align: 'center' });

          // Draw the line across the page
          doc.moveTo(doc.page.margins.left, doc.y)
            .lineTo(doc.page.width - doc.page.margins.right, doc.y)
            .stroke();
          doc.moveDown(0.35);

          // Sort vendors based on vendor order
          const vendors = Object.keys(sortedDataByLocation[location]);
          vendors.sort((a, b) => {
            const orderA = vendorOrderMap.hasOwnProperty(a) ? vendorOrderMap[a] : vendorOrder.length;
            const orderB = vendorOrderMap.hasOwnProperty(b) ? vendorOrderMap[b] : vendorOrder.length;
            return orderA - orderB;
          });

          // Loop through each vendor within the current location
          for (const vendor of vendors) {
            // Print the vendor name
            doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text(vendor);
            doc.moveDown(0.2);

            const products = sortedDataByLocation[location][vendor];
            const productNames = Object.keys(products);
            const productQuantities = productNames.map(productName => products[productName].total_quantity);
            const productCategories = productNames.map(productName => products[productName].category);

            // Print the table rows without headers using a thinner font
            for (let i = 0; i < productNames.length; i++) {
              const formattedQuantity = `${productQuantities[i]}`.padStart(3, ' ');
              doc.fontSize(12).font('Helvetica').fillColor('#333333').text(formattedQuantity, { continued: true }).text('  ', { continued: true }).text(`${productNames[i]}`);
            }
            doc.moveDown(0.35);
          }
          doc.moveDown(0.35); // Add extra space after each location
        }


        doc.end();


        // Wait for the stream to finish and then resolve with the file path
        doc.on('finish', () => {
          console.log('PDF created successfully.');
          console.log(pdf_file);
        });

        doc.on('error', (error) => {
          console.error('PDF creation error:', error);
          reject(error);
        });

        // TODO: figure out appropriate aync methods to enable finishing PDF creation
        setTimeout(() => {
          console.log("Success!")
          resolve(pdf_file); // Promise is resolved with "Success!"
        }, 1000);
      })
  });
}

async function writeDeliveryOrderPDF(filename, fullfillmentDateEnd) {
  const vendorOrder = await readVendorOrder('vendor_order.csv');
  return new Promise((resolve, reject) => {
    const pdf_file = 'data/delivery_order.pdf';

    // Create a new PDF document
    const doc = new PDFDocument({ bufferPages: true });
    doc.pipe(fs.createWriteStream(pdf_file));
    const pageNumbering = new Map();

    const currentPageIndex = () => {
      const range = doc.bufferedPageRange();
      return range.start + range.count - 1;
    };

    // Initialize variables to group items by "Fulfillment Name"
    const customers = {}; // Store customer data including attributes

    const sortedData = [];

    // Read the CSV file and sort by "Customer Name" before processing
    let rowCount = 0;
    fs.createReadStream(filename)
      .pipe(fastcsv.parse({ headers: true, ignoreEmpty: true }))
      .on('error', error => console.error('🚨 Stream Error:', error))
      .on('data-invalid', (row, rowNumber) => {
        console.warn(`⚠️ Invalid row at ${rowNumber}:`, row);
      })
      .on('data', (row) => {
        rowCount++;
        sortedData.push(row);
      })
      .on('end', async () => {
        console.log(`Finished parsing. ${rowCount} total rows processed.`);
        sortedData.sort((a, b) =>
          a['Last Name'].localeCompare(b['Last Name']) ||
          a['First Name'].localeCompare(b['First Name']) ||
          a['Email'].localeCompare(b['Email'])
        );

        // Prepare vendorOrderMap for sorting items inside sections
        const vendorOrderMap = {};
        vendorOrder.forEach((vendorObj, index) => {
          vendorOrderMap[vendorObj.vendor] = index;
        });
        const defaultOrderValue = vendorOrder.length;

        // Process the sorted data
        sortedData.forEach((row) => {
          const customerName = `${row['Last Name']}, ${row['First Name']}`;
          const email = `${row['Email']}`;
          const product = row['Product'] + ' - ' + row['Package Name'];
          let quantity = Math.round(parseFloat(row['Quantity']));
          const numItems = Math.round(parseFloat(row['# of Items']));
          const itemUnit = row['Item Unit'];
          const vendor = row['Vendor'];
          const category = row['Category'];
          const customerPhone = row['Phone'];
          const company = row['About This Customer'];
          const fullfillmentName = row['Fulfillment Name'];
          const fullfillmentAddress = row['Fulfillment Address'];
          const fullfillmentDate = utilities.formatDate(row['Fulfillment Date']);
          const customerNote = row['Customer Note'];
          const startTime = row['Fulfillment - Pickup Start Time'];
          const endTime = row['Fulfillment - Pickup End Time'];

          const disposition = computeDispositionForRow(
            row,
            MANUAL_DISPOSITIONS,
            MANUAL_DISPOSITIONS_LOWER
          );

          let timeRange = '';
          if (startTime && endTime) {
            timeRange = startTime + ' to ' + endTime;
          }

          // If # of Items is > 1 and quantity is 1, update quantity to be numItems
          if (numItems > 1 && quantity == 1) {
            quantity = numItems;
          }

          // Initialize customer bucket
          if (!customers[email]) {
            customers[email] = {
              products: [],
              customerName: customerName,
              phone: customerPhone,
              company: company,
              fullfillmentName: fullfillmentName,
              fullfillmentAddress: fullfillmentAddress,
              fullfillmentDate: fullfillmentDate,
              timeRange: timeRange,
              customerNote: customerNote,
            };
          }

          if (category !== 'Membership') {
            customers[email].products.push({
              product,
              quantity,
              itemUnit,
              vendor,
              disposition,
            });
          }
        });

        // Iterate through items and generate the PDF content
        for (const email of Object.keys(customers)) {
          const customerData = customers[email];

          if (customerData.products.length > 0) {
            const orderStartPage = currentPageIndex();
            // Logo + header
            const image = 'logo.png';
            const leftMargin = contentLeft;
            const rightMargin = contentRight;
            const x = leftMargin; // X-coordinate (left)
            const y = 0; // Y-coordinate (top)
            const width = 60; // Image width in pixels
            const height = 60; // Image height in pixels
            const lineSpacing = 15;

            doc.image(image, x, 10, { width, height });

            let textX = x + width + 10;
            let textY = 0;
            const logoBottom = y + height + 10;
            const headerRightWidth = doc.page.width - rightMargin - textX;
            const fullWidth = doc.page.width - leftMargin - rightMargin;

            doc.font('Helvetica');

            const splitTextByHeight = (text, width, maxHeight) => {
              if (maxHeight <= 0) return ['', text];
              const words = text.split(/\s+/);
              let low = 1;
              let high = words.length;
              let best = 0;
              while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const candidate = words.slice(0, mid).join(' ');
                const height = doc.heightOfString(candidate, { width });
                if (height <= maxHeight) {
                  best = mid;
                  low = mid + 1;
                } else {
                  high = mid - 1;
                }
              }
              if (best === 0) return ['', text];
              const first = words.slice(0, best).join(' ');
              const rest = words.slice(best).join(' ');
              return [first, rest];
            };

            const drawWrappedBlock = (label, value) => {
              const blockText = `${label}       ${value}`;
              if (textY < logoBottom) {
                const availableHeight = logoBottom - textY;
                const blockHeight = doc.heightOfString(blockText, { width: headerRightWidth });
                if (blockHeight <= availableHeight) {
                  doc.fontSize(12).text(blockText, textX, textY, { width: headerRightWidth });
                  textY += blockHeight + lineSpacing;
                  return;
                }
                const [first, rest] = splitTextByHeight(blockText, headerRightWidth, availableHeight);
                if (first) {
                  const firstHeight = doc.heightOfString(first, { width: headerRightWidth });
                  doc.fontSize(12).text(first, textX, textY, { width: headerRightWidth });
                  textY += firstHeight + lineSpacing;
                }
                textY = Math.max(textY, logoBottom + lineSpacing);
                if (rest) {
                  const restHeight = doc.heightOfString(rest, { width: fullWidth });
                  doc.fontSize(12).text(rest, leftMargin, textY, { width: fullWidth });
                  textY += restHeight + lineSpacing;
                }
                return;
              }
              const fullHeight = doc.heightOfString(blockText, { width: fullWidth });
              doc.fontSize(12).text(blockText, leftMargin, textY, { width: fullWidth });
              textY += fullHeight + lineSpacing;
            };

            // Fulfillment date is rendered with page numbering later for consistent alignment.
            textY += lineSpacing;

            // Customer details
            doc.fontSize(12).text(`Name:        ${customerData.customerName}`, textX, textY, { width: headerRightWidth });
            textY += lineSpacing;
            doc.fontSize(12).text(`Phone:       ${customerData.phone}`, textX, textY, { width: headerRightWidth });
            textY += lineSpacing;

            // Drop site and time range
            let timeRangeText = customerData.timeRange ? ` (${customerData.timeRange})` : '';
            const fullText = `Drop Site:   ${customerData.fullfillmentName}${timeRangeText}`;
            doc.fontSize(12).text(fullText, textX, textY, { width: headerRightWidth });
            textY += lineSpacing;

            // Address (keep aligned under Name/Phone/Drop Site)
            let text = `Address:       ${customerData.fullfillmentAddress}`;
            let textHeight = doc.heightOfString(text, { width: headerRightWidth });
            doc.fontSize(12).text(text, textX, textY, { width: headerRightWidth });
            textY += textHeight + lineSpacing;

            // Directions (if available)
            if (customerData.company !== '') {
              drawWrappedBlock('Directions:', customerData.company);
            }

            // Customer Notes (if available)
            if (customerData.customerNote !== '') {
              drawWrappedBlock('Customer Notes:', customerData.customerNote);
            }

            const headerBottom = Math.max(textY, y + height + 10);
            doc.x = leftMargin;
            doc.y = headerBottom + 10;

            // 🔹 Sort products by vendor order then product name (no location)
            const items = customerData.products.slice().sort((a, b) => {
              const orderA = vendorOrderMap.hasOwnProperty(a.vendor)
                ? vendorOrderMap[a.vendor]
                : defaultOrderValue;
              const orderB = vendorOrderMap.hasOwnProperty(b.vendor)
                ? vendorOrderMap[b.vendor]
                : defaultOrderValue;

              if (orderA !== orderB) return orderA - orderB;

              if (a.product < b.product) return -1;
              if (a.product > b.product) return 1;
              return 0;
            });

            // 🔹 Group items by disposition → Frozen/Dairy/Tote
            const groupedItems = {
              'Frozen Items': [],
              'Dairy Items': [],
              'Tote Items': [],
            };

            items.forEach(item => {
              const tag = (item.disposition || '').toLowerCase();
              let section;
              if (tag === 'frozen') {
                section = 'Frozen Items';
              } else if (tag === 'dairy') {
                section = 'Dairy Items';
              } else {
                // null/blank or anything else
                section = 'Tote Items';
              }
              groupedItems[section].push(item);
            });

            const sectionOrder = ['Frozen Items', 'Dairy Items', 'Tote Items'];

            // 🔹 Render sections in the desired order
            const pageBottom = doc.page.height - doc.page.margins.bottom;
            const tableWidth = doc.page.width - leftMargin - rightMargin;

            for (const section of sectionOrder) {
              const sectionItems = groupedItems[section];

              if (sectionItems.length > 0) {
                const sectionHeaderHeight = doc.fontSize(14).heightOfString(section, {
                  width: tableWidth,
                });
                const tableHeaderHeight = doc.fontSize(8).heightOfString('Product', {
                  width: tableWidth,
                }) + 8;
                const sampleRowHeight = doc.fontSize(8).heightOfString('A', {
                  width: tableWidth,
                }) + 6;
                const minSectionHeight = sectionHeaderHeight + tableHeaderHeight + sampleRowHeight + 36;
                if (doc.y + minSectionHeight > pageBottom) {
                  doc.addPage();
                }

                doc.moveDown(0.2);
                doc.fontSize(14).text(section, { bold: true });
                textY += lineSpacing + 14;

                const itemsAsData = sectionItems.map(item => [
                  item.product,
                  item.quantity,
                  item.itemUnit,
                  item.vendor,
                  '' // Packed column
                ]);

                const table = {
                  title: '',
                  headers: ['Product', 'Quantity', 'Unit', 'Vendor', 'Packed'],
                  rows: itemsAsData
                };

                const tableStartX = leftMargin;
                const tableStartY = doc.y;
                const productWidth = Math.floor(tableWidth * 0.45);
                const vendorWidth = Math.floor(tableWidth * 0.25);
                const smallWidth = Math.floor((tableWidth - productWidth - vendorWidth) / 3);
                const columnsSize = [
                  productWidth,
                  smallWidth,
                  smallWidth,
                  vendorWidth,
                  tableWidth - productWidth - vendorWidth - (smallWidth * 2),
                ];

                await doc.table(table, {
                  x: tableStartX,
                  y: tableStartY,
                  absolutePosition: true,
                  columnsSize,
                  columnSpacing: 2,
                  padding: 2,
                });
              }
            }

            doc.moveDown();

            // Footer note
            doc.fontSize(12).font('Helvetica-Oblique').text("Please check your tote and the meat/dairy coolers for all listed items, and email fullfarmcsa@deckfamilyfarm.com if anything is missing so we can issue you a credit.", doc.x, doc.y);

            const orderEndPage = currentPageIndex();
            const totalOrderPages = orderEndPage - orderStartPage + 1;
            for (let i = 0; i < totalOrderPages; i++) {
              pageNumbering.set(orderStartPage + i, {
                page: i + 1,
                total: totalOrderPages,
                date: fullfillmentDateEnd,
                name: customerData.customerName,
              });
            }

            doc.addPage();
          }
        }

        const pageRange = doc.bufferedPageRange();
        for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
          const info = pageNumbering.get(i);
          if (!info) continue;
          doc.switchToPage(i);
          const pageLabel = `Page ${info.page} of ${info.total} | ${info.date}`;
          if (info.page > 1) {
            doc.fontSize(10)
              .fillColor('black')
              .text(`Name: ${info.name}`, contentLeft, 10, {
                width: (doc.page.width - contentLeft - contentRight) / 2,
                align: 'left',
              });
          }
          doc.fontSize(9)
            .fillColor('gray')
            .text(pageLabel, contentLeft, 10, {
              width: doc.page.width - contentLeft - contentRight,
              align: 'right',
            });
        }

        doc.end();

        // Wait for the stream to finish and then resolve with the file path
        doc.on('finish', () => {
          console.log('PDF created successfully.');
          resolve(pdf_file);
        });

        doc.on('error', (error) => {
          console.error('PDF creation error:', error);
          reject(error);
        });

        // Temporary async method for finishing PDF creation
        setTimeout(() => {
          resolve(pdf_file); // Promise is resolved with "Success!"
        }, 1000);
      });
  });
}

// Build customer delivery orders (picklists)
async function delivery_order(fullfillmentDateStart, fullfillmentDateEnd, testing = false) {
  try {
    console.log("running delivery_order builder");

    // 🔹 Download (or reuse) the orders CSV via utilities helper
    let overwriteExisting = true; // change to false if you ever want to reuse existing file

    // when i test i don't want to the overwrite feature
    if (testing) overwriteExisting = false;

    const orders_file_path = await utilities.downloadOrdersCsv(
      fullfillmentDateStart,
      fullfillmentDateEnd,
      overwriteExisting
    );

    console.log('Downloaded file path:', orders_file_path);

    // ---------- Customer Notes PDF ----------
    try {
      const customer_note_pdf = await writeCustomerNotePDF(orders_file_path, fullfillmentDateEnd);

      const emailOptions = {
        from: "jdeck88@gmail.com",
        to: "fullfarmcsa@deckfamilyfarm.com",
        cc: "jdeck88@gmail.com, deckfamilyfarm@gmail.com",
        subject: 'FFCSA Reports: Customer Notes for ' + fullfillmentDateEnd,
        text: "Please see the attached file with customer notes.",
        attachments: [
          {
            filename: 'customer_notes.pdf',
            content: fs.readFileSync(customer_note_pdf),
          },
        ],
      };

      // 🔹 Testing mode: send ONLY to John
      if (testing) {
        emailOptions.to = "jdeck88@gmail.com";
        delete emailOptions.cc;
      }

      utilities.sendEmail(emailOptions);
    } catch (error) {
      console.error("Error in writeCustomerNotePDF:", error);
      utilities.sendErrorEmail(error);
    }

    // ---------- Delivery Orders PDF ----------
    try {
      const delivery_order_pdf = await writeDeliveryOrderPDF(orders_file_path, fullfillmentDateEnd);

      const emailOptions = {
        from: "jdeck88@gmail.com",
        to: "fullfarmcsa@deckfamilyfarm.com",
        cc: "jdeck88@gmail.com",
        subject: 'FFCSA Reports: Delivery Orders for ' + fullfillmentDateEnd,
        text: "Please see the attached file.  Reports are generated twice per week in advance of fullfillment dates.",
        attachments: [
          {
            filename: 'delivery_orders.pdf',
            content: fs.readFileSync(delivery_order_pdf),
          },
        ],
      };

      if (testing) {
        emailOptions.to = "jdeck88@gmail.com";
        delete emailOptions.cc;
      }

      utilities.sendEmail(emailOptions);
    } catch (error) {
      console.error("Error in writeDeliveryOrderPDF:", error);
      utilities.sendErrorEmail(error);
    }

    // ---------- Setup PDF ----------
    try {
      const setup_pdf = await writeSetupPDF(orders_file_path, fullfillmentDateEnd);

      const emailOptions = {
        from: "jdeck88@gmail.com",
        to: "fullfarmcsa@deckfamilyfarm.com",
        cc: "jdeck88@gmail.com",
        subject: 'FFCSA Reports: Setup Instructions for ' + fullfillmentDateEnd,
        text: "Please see the attached file.  Reports are generated twice per week in advance of fullfillment dates.",
        attachments: [
          {
            filename: 'setup.pdf',
            content: fs.readFileSync(setup_pdf),
          },
        ],
      };

      if (testing) {
        emailOptions.to = "jdeck88@gmail.com";
        delete emailOptions.cc;
      }

      utilities.sendEmail(emailOptions);
    } catch (error) {
      console.error("Error in writeSetupPDF:", error);
      utilities.sendErrorEmail(error);
    }

    // ---------- Labels PDF ----------
    try {
      console.log("starting writeLabelPDF");
      const labelPdfPath = await writeLabelPDF(orders_file_path);

      const emailOptions = {
        from: "jdeck88@gmail.com",
        to: "fullfarmcsa@deckfamilyfarm.com",
        cc: "jdeck88@gmail.com",
        subject: 'FFCSA Reports: Labels for ' + fullfillmentDateEnd,
        text: "Attached are the delivery labels.",
        attachments: [
          {
            filename: 'labels.pdf',
            content: fs.readFileSync(labelPdfPath),
          },
        ],
      };

      if (testing) {
        emailOptions.to = "jdeck88@gmail.com";
        delete emailOptions.cc;
      }

      utilities.sendEmail(emailOptions);
    } catch (error) {
      console.error("Error in writeLabelPDF:", error);
      utilities.sendErrorEmail(error);
    }

  } catch (error) {
    console.error('An error occurred in delivery_order:', error);
    utilities.sendErrorEmail(error);
  }
}
   
/*
// Run the delivery_order script
const fullfillmentDateObject = {
  start: '2026-01-31',
  end: '2026-01-31',
  date: '2026-01-31'
};
*/

fullfillmentDateObject = utilities.getNextFullfillmentDate()
const TESTING = false;
delivery_order(fullfillmentDateObject.start, fullfillmentDateObject.end, TESTING);
