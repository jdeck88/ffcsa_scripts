const request = require('request');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const utilities = require('./utilities');
const ExcelJS = require('exceljs');

// Helper to format phone numbers
function formatPhoneNumber(phoneNumber) {
    let digits = phoneNumber.replace(/\D/g, '');
    if (digits.startsWith('1')) digits = digits.substring(1);
    return `(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6)}`;
}

// Reads a specific column from an Excel file
async function readLocalExcelAndExtractColumnData(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0];

    const headerRow = worksheet.getRow(1);
    const columnIndex = headerRow.values.indexOf('Local Line Product ID');

    if (columnIndex === -1) throw new Error('Column "Local Line Product ID" not found');

    return worksheet.getColumn(columnIndex).values.slice(2).map(value => value.toString());
}


async function writeOptimarouteXLSX(dairyFilePath, frozenFilePath, deliveryOrderFilePath) {
    const xlsxFile = 'data/optimaroute.xlsx';
    const sortedData = [];

    const dairyIds = await readLocalExcelAndExtractColumnData(dairyFilePath);
    const frozenIds = await readLocalExcelAndExtractColumnData(frozenFilePath);

    fs.createReadStream(deliveryOrderFilePath)
        .pipe(fastcsv.parse({ headers: true }))
        .on('data', row => sortedData.push(row))
        .on('end', () => {
            sortedData.sort((a, b) => a['Fulfillment Name'].localeCompare(b['Fulfillment Name']));
  					// update the disposition field
            sortedData.forEach((item) => {
                  item.disposition = "tote";
            });
            const updatedData = updateCategoryForProductID(sortedData, dairyIds, 'dairy');
            updateCategoryForProductID(updatedData, frozenIds, 'frozen');

            // Group orders by customerName + deliveryAddress
            const customerGroups = {};
            updatedData.forEach(row => {
                const customerName = row['Customer'].trim();
                const deliveryAddress = row['Fulfillment Address'].trim();
                const key = `${customerName} - ${deliveryAddress}`.toLowerCase(); // Use a normalized key

                // Initialize customer group if it doesn't exist
                if (!customerGroups[key]) {
                    const isPickup = row['Fulfillment Type'] === 'pickup';
                    customerGroups[key] = {
                        nameOrDropsite: isPickup
                            ? `${row['Fulfillment Name']} Dropsite (${customerName})`
                            : customerName,
                        customerPhone: formatPhoneNumber(row['Phone']),
                        deliveryAddress,
                        instructions: isPickup
                            ? getInstructionsByName(fulfillment_json,row['Fulfillment Name'])
                            : row['Company'],
                        tote: 0,
                        frozen: 0,
                        dairy: 0,
                    };
                }

                // Debugging: Log disposition
                //console.log(`Disposition for ${customerName}: ${row.disposition}`);

                // Update counts for Tote, Frozen, and Dairy
                const quantity = Math.round(parseFloat(row['Quantity']));
                if (row.disposition === 'tote') {
                    //console.log(`Setting tote to 1 for ${customerName} at ${deliveryAddress}`);
                    customerGroups[key].tote = 1; // Set tote to 1 if any tote item exists
                }
                if (row.disposition === 'frozen') {
                    //console.log(`Setting frozen to 1 for ${customerName} at ${deliveryAddress}`);
                    customerGroups[key].frozen = 1; // Set frozen to 1 if any frozen item exists
                }
                if (row.disposition === 'dairy') {
                    customerGroups[key].dairy += quantity; // Sum up dairy quantities
                }
            });

            // Flatten grouped data for output
// Flatten grouped data for output
const rows = [];
for (const key in customerGroups) {
    const group = customerGroups[key];

    // Exclude specific addresses at the output stage
    if (group.deliveryAddress.includes("25362 High Pass") || group.deliveryAddress.includes("ONLINE DELIVERY")) {
        continue; // Skip this entry if the address matches exclusion criteria
    }

    rows.push([
        group.nameOrDropsite,
        group.customerPhone,
        group.deliveryAddress,
        group.instructions,
        group.tote ? 1 : '', // Ensure tote shows 1 if any item exists
        group.frozen ? 1 : '', // Ensure frozen shows 1 if any item exists
        group.dairy || ''
    ]);
}

            // Write to XLSX
            writeXLSX(rows, xlsxFile);
        });
}

// Creates and writes to an XLSX file
function writeXLSX(rows, outputPath) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Sheet1');

    // Updated headers with merged "name/dropsite" column
    worksheet.addRow(['name/dropsite', 'Phone', 'Address', 'Instructions', 'Tote', 'Frozen', 'Dairy']);
    rows.forEach(row => worksheet.addRow(row));

    workbook.xlsx.writeFile(outputPath).then(() => {
        console.log(`XLSX file has been written to ${outputPath}`);
    });
}

// Updates product categories based on product IDs
function updateCategoryForProductID(jsonData, productIDsToUpdate, value) {
    if (!jsonData || !Array.isArray(jsonData)) {
        console.error("updateCategoryForProductID: jsonData is not an array or is undefined.");
        return [];
    }
    jsonData.forEach((item) => {
        const productId = Math.floor(item['Product ID'].toString().trim());
        if (productIDsToUpdate.includes(productId.toString())) item.disposition = value;
    });
    return jsonData;
}

// Main function to build the OptimaRoute file and email it
async function optimaroute(fullfillmentDate) {
    console.log("Running optimaroute builder");

    const deliveryOrderPath = `data/orders_list_${fullfillmentDate}.csv`;
    const dairyFilePath = 'data/dairy.xlsx';
    const frozenFilePath = 'data/frozen.xlsx';

    const accessToken = JSON.parse(await utilities.getAccessToken()).access;
		fulfillment_json = ''

    utilities.getJsonFromUrl('https://localline.ca/api/backoffice/v2/fulfillment-strategies/', accessToken)
        .then(async json => {
        		fulfillment_json = json
            await Promise.all([
                utilities.downloadBinaryData('https://localline.ca/api/backoffice/v2/products/export/?internal_tags=2244&direct=true', dairyFilePath, accessToken),
                utilities.downloadBinaryData('https://localline.ca/api/backoffice/v2/products/export/?internal_tags=2245,2266&direct=true', frozenFilePath, accessToken)
            ]);

            const rows = await writeOptimarouteXLSX(dairyFilePath, frozenFilePath, deliveryOrderPath);
            sendEmail('data/optimaroute.xlsx', 'optimaroute.xlsx', `FFCSA Reports: OptimaRoute File ${fullfillmentDate}`);
        })
        .catch(error => utilities.sendErrorEmail(error));
}

// Sends an email with a file attachment
function sendEmail(filePath, filename, subject) {
    const emailOptions = {
        from: "fullfarmcsa@deckfamilyfarm.com",
        to: "jdeck88@gmail.com",
        cc: "jdeck88@gmail.com",
        subject,
        text: "Please see the attached file for OptimaRoute. This is a new file that contains individual orders for each dropsite.",
        attachments: [{ filename, content: fs.readFileSync(filePath) }]
    };
    utilities.sendEmail(emailOptions);
}

function getInstructionsByName(json, name) {
    const result = json.results.find(item => item.name === name);
    if (result && result.availability && result.availability.instructions) {
        return result.availability.instructions;
    }
    return null;
}

// Start the process
optimaroute(utilities.getNextFullfillmentDate().date);
//optimaroute('2024-10-29');

