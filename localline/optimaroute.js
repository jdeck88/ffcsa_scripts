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

// Writes data to an XLSX file and returns a Promise
async function writeXLSX(rows, outputPath) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Sheet1');

    worksheet.addRow(['name/dropsite', 'Phone', 'Email', 'Address', 'Instructions', 'Tote', 'Frozen', 'Dairy']);
    rows.forEach(row => worksheet.addRow(row));

    return workbook.xlsx.writeFile(outputPath).then(() => {
        console.log(`XLSX file has been written to ${outputPath}`);
    });
}

// Main function to build the OptimaRoute file and email it
async function writeOptimarouteXLSX(dairyFilePath, frozenFilePath, deliveryOrderFilePath) {
    const xlsxFile = 'data/optimaroute.xlsx';
    const sortedData = [];

    const dairyIds = await readLocalExcelAndExtractColumnData(dairyFilePath);
    const frozenIds = await readLocalExcelAndExtractColumnData(frozenFilePath);

    return new Promise((resolve, reject) => {
        fs.createReadStream(deliveryOrderFilePath)
            .pipe(fastcsv.parse({ headers: true }))
            .on('data', row => sortedData.push(row))
            .on('end', async () => {
                try {
                    sortedData.sort((a, b) => a['Fulfillment Name'].localeCompare(b['Fulfillment Name']));
                    sortedData.forEach(item => item.disposition = "tote");

                    const updatedData = updateCategoryForProductID(sortedData, dairyIds, 'dairy');
                    updateCategoryForProductID(updatedData, frozenIds, 'frozen');

                    const customerGroups = groupOrdersByCustomer(updatedData);
                    const rows = flattenCustomerGroups(customerGroups);

                    await writeXLSX(rows, xlsxFile);
                    resolve(rows);
                } catch (error) {
                    reject(error);
                }
            });
    });
}

// Groups orders by customer name and address
function groupOrdersByCustomer(updatedData) {
    const customerGroups = {};
    updatedData.forEach(row => {
        //const customerName = row['Customer'].trim();
        const customerName = `${row['Last Name']?.trim() || ''}, ${row['First Name']?.trim() || ''}`;

        const deliveryAddress = row['Fulfillment Address'].trim();
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

        const quantity = Math.round(parseFloat(row['Quantity']));
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
        if (group.deliveryAddress.includes("25362 High Pass") || group.deliveryAddress.includes("ONLINE DELIVERY")) {
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
            group.dairy || ''
        ]);
    }
    return rows;
}

// Updates product categories based on product IDs
function updateCategoryForProductID(jsonData, productIDsToUpdate, value) {
    jsonData.forEach(item => {
        const productId = Math.floor(item['Product ID'].toString().trim());
        if (productIDsToUpdate.includes(productId.toString())) item.disposition = value;
    });
    return jsonData;
}

// Main function to initiate the process
async function optimaroute(fullfillmentDate) {
    console.log("Running optimaroute builder");

    const deliveryOrderPath = `data/orders_list_${fullfillmentDate}.csv`;
    const dairyFilePath = 'data/dairy.xlsx';
    const frozenFilePath = 'data/frozen.xlsx';

    try {
        const accessToken = JSON.parse(await utilities.getAccessToken()).access;
        fulfillment_json = await utilities.getJsonFromUrl('https://localline.ca/api/backoffice/v2/fulfillment-strategies/', accessToken);

        await Promise.all([
            utilities.downloadBinaryData('https://localline.ca/api/backoffice/v2/products/export/?internal_tags=2244&direct=true', dairyFilePath, accessToken),
            utilities.downloadBinaryData('https://localline.ca/api/backoffice/v2/products/export/?internal_tags=2245,2266&direct=true', frozenFilePath, accessToken)
        ]);

        await writeOptimarouteXLSX(dairyFilePath, frozenFilePath, deliveryOrderPath);
        sendEmail('data/optimaroute.xlsx', 'optimaroute.xlsx', `FFCSA Reports: OptimaRoute File ${fullfillmentDate}`);
    } catch (error) {
        utilities.sendErrorEmail(error);
    }
}

// Sends an email with a file attachment
function sendEmail(filePath, filename, subject) {
    const emailOptions = {
        from: "fullfarmcsa@deckfamilyfarm.com",
        to: "fullfarmcsa@deckfamilyfarm.com",
        cc: "jdeck88@gmail.com",
        subject,
        text: "Please see the attached file for OptimaRoute. This is a new file that contains individual orders for each dropsite.",
        attachments: [{ filename, content: fs.readFileSync(filePath) }]
    };
    utilities.sendEmail(emailOptions);
}

// Fetches instructions by fulfillment name
function getInstructionsByName(json, name) {
    const result = json.results.find(item => item.name === name);
    if (result && result.availability && result.availability.instructions) {
        return result.availability.instructions;
    }
    return null;
}

// Start the process
const nextDate = utilities.getNextFullfillmentDate().date;
console.log("Next Fulfillment Date:", nextDate);
optimaroute(nextDate);
