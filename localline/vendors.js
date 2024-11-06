var request = require('request');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const utilities = require('./utilities');
const ExcelJS = require('exceljs');


async function writeVendorsPDF(products_file_path, vendors_file_path, filename) {
    return new Promise((resolve, reject) => {
        const pdf_file = 'data/vendors.pdf'

        // Create a new PDF document
        const doc = new PDFDocument();
        doc.pipe(fs.createWriteStream(pdf_file));

        // Initialize variables to group items by "Fulfillment Name"
        const vendors = {}; // Store customer data including attributes
        let currentVendorName = null;

        const sortedData = [];

        readVendorsCSVFile(vendors_file_path)
            .then((vendors_email) => {
                readVendorsExcel(products_file_path)
                    .then((products_data) => {
                        fs.createReadStream(filename)
                            .pipe(fastcsv.parse({ headers: true }))
                            .on('data', (row) => {
                                sortedData.push(row);
                            })
                            .on('end', () => {
                                // Sort the data by "Customer Name"
                                sortedData.sort((a, b) => a['Vendor'].localeCompare(b['Vendor']));

                                // Process the sorted data
                                sortedData.forEach((row) => {
                                    const productID = row['Product ID']
                                    const vendorName = row['Vendor']
                                    const product = row['Item Unit'] + ',' + row['Product'] + ' - ' + row['Package Name'];
                                    const packageName = row['Package Name'];
                                    quantity = Math.round(parseFloat(row['Quantity']));
                	            const numItems = Math.round(parseFloat(row['# of Items']));
                                    const price = (parseFloat(row['Product Subtotal']) / quantity).toFixed(2);
                                    const totalPrice = row['Product Subtotal']
                                    const category = row['Category']
                                    const fullfillmentDate = row['Fulfillment Date']
  				   // If # of Items is > 1 and quantity is 1, then update quantity to be numItems
                                   if (numItems > 1 && quantity == 1) {
                  			quantity = numItems
          			   }

                                    // If the customerName changes, start a new section
                                    if (vendorName !== currentVendorName) {
                                        currentVendorName = vendorName;
                                        vendors[vendorName] = {
                                            products: []
                                        };
                                    }

                                    //console.log(mergedObject)
                                    if (category !== 'Membership') {
                                        vendors[vendorName].products.push({ productID, product, quantity, price, totalPrice, fullfillmentDate, packageName, category });
                                    }
                                });

                                // Iterate through items and generate the PDF content
                                for (const vendorName in vendors) {
                                    const vendorData = vendors[vendorName];

                                    if (vendorData.products.length > 0) {
                                        const items = vendorData.products;

                                        // Sort the dataset by the 'product' property
                                        items.sort((a, b) => {
                                            if (a.product < b.product) {
                                                return -1; // a should come before b
                                            } else if (a.product > b.product) {
                                                return 1; // a should come after b
                                            }
                                            return 0; // a and b are equal in terms of 'vendor'
                                        });

                                        // Update price and total price based on vendor pricing
                                        for (const itemRow of items) {
                                            productID = parseInt(itemRow.productID, 10);
                                            product = itemRow.product;
                                            quantity = itemRow.quantity;
                                            fullfillmentDate = itemRow.fullfillmentDate;
                                            packageName = itemRow.packageName;
                                            category = itemRow.category;

                                            itemRow.price = lookupPackagePrice(productID, packageName, products_data);
                                            itemRow.totalPrice = quantity * itemRow.price;
                                        }

                                        fullfillmentDate = utilities.formatDate(fullfillmentDate)
                                        doc.fontSize(16).text(fullfillmentDate, { align: 'right' });
                                        doc.fontSize(16).text(vendorName, { bold: true });

                                        // Set the table column widths
                                        const itemsAsData = items.map(item => [item.product, item.quantity, item.price, item.totalPrice, item.category]);

                                        // Create an object to store the summary
                                        const summary = {};
                                        sumTotal = 0;
                                        // Iterate through the data and update the summary
                                        itemsAsData.forEach((row) => {
                                            const key = row[0];
                                            const quantity = parseInt(row[1], 10);
                                            const price = parseFloat(row[2])
                                            const totalPrice = parseFloat(row[3]);
                                            const category = row[4];

                                            if (!summary[key]) {
                                                summary[key] = { quantity: 0, price: 0, totalPrice: 0 };
                                            }

                                            summary[key].quantity += quantity;
                                            summary[key].price = price;
                                            summary[key].totalPrice += totalPrice;
                                            summary[key].category = category;

                                            sumTotal += totalPrice
                                        });

                                        // Convert the summary object to an array of arrays
                                        const grouped = Object.entries(summary).map(([key, values]) => [values.category, key, values.quantity, values.price, values.totalPrice.toFixed(2)]);
                                        // Function to calculate the subtotal for a category
                                        const calculateSubtotal = (categoryItems) => {
                                            return categoryItems.reduce((total, item) => total + parseFloat(item[4]), 0);
                                        };

                                        // Extract unique categories from the data
                                        const uniqueCategories = [...new Set(grouped.map(item => item[0]))];

                                        // Create a new array to store the rows with subtotals
                                        const tableWithSubtotals = [];

                                        // Iterate through each unique category
                                        uniqueCategories.forEach(category => {
                                            // Filter items belonging to the current category
                                            const categoryItems = grouped.filter(item => item[0] === category);

                                            // Calculate subtotal for the category
                                            const subtotal = calculateSubtotal(categoryItems);

                                            // Add items and subtotal row to the new array
                                            tableWithSubtotals.push(...categoryItems, ['', '', '', 'Subtotal ' + category, subtotal.toFixed(2)]);
                                        });


                                        // Function to remove the first column from each row
                                        function removeFirstColumn(rows) {
                                            return rows.map(row => row.slice(1));
                                        }

                                        // Modified table data structure with the first column removed
                                        let modifiedTableData = removeFirstColumn(tableWithSubtotals);


                                        // Now 'tableWithSubtotals' contains rows sorted by category with subtotals
                                        // You can use this new array in your PDF generation code

                                        // Additional code for handling total price, new pages, and vendorDoc if needed

                                        const pageWidth = 600

                                        const table = {
                                            title: '',
                                            widths: [ 300, 300, 300, 300],
                                            headers: ['Product', 'Quantity', 'Price', 'Total Price'],
                                            rows: modifiedTableData, 
                                        };
                                        doc.table(table);
                                        doc.text('Total Price ' + sumTotal.toFixed(2), { align: 'right', bold: true })
                                        doc.addPage();

                                        // Handle sending vendors their own email
                                        const email = vendors_email[vendorName]
                                        if (email !== null && email !== '' && email !== undefined) {
                                            console.log(vendors_email[vendorName])
                                            // Create a PDF document to send to the vendor
                                            // TODO: only mail this if the Vendor has an email in the system 
                                            vendorDoc = new PDFDocument();
                                            vendorDoc.fontSize(16).text('Fulfillment Sheet for Full Farm CSA, LLC', { align: 'right' });
                                            vendorDoc.fontSize(16).text(utilities.getToday(), { align: 'right' });
                                            vendorDoc.fontSize(16).text(vendorName, { bold: true });
                                            vendorDoc.table(table)
                                            vendorDoc.text('Total Price ' + sumTotal.toFixed(2), { align: 'right', bold: true })

                                            const mailOptions = {
                                                from: 'fullfarmcsa@deckfamilyfarm.com', // sender address
                                                to: email,                                            
                                                cc: 'fullfarmcsa@deckfamilyfarm.com',
                                                bcc: 'jdeck88@gmail.com',
                                                subject: "FFCSA Reports: Vendor Fulfillments for " + vendorName + " - " + utilities.getToday(), // Subject line
                                                text: "The attached PDF file contains the Full Farm CSA Order for the next fulfillment Cycle.  " +
                                                    "Respond to this email (including both cc:ed addresses) with questions!"
                                            }
                                            // JBD
                                            utilities.mailADocument(vendorDoc, mailOptions, 'vendor_fulfillment.pdf');
                                            setTimeout(() => {
                                                console.log("waiting for emails to process")
                                            }, 500);
                                        }

                                    }
                                }

                                doc.end();
                                // Wait for the stream to finish and then resolve with the file path
                                doc.on('finish', () => {
                                    console.log('PDF created successfully.');
                                    //console.log(pdf_file);
                                });

                                doc.on('error', (error) => {
                                    console.error('PDF creation error:', error);
                                    throw new Error("PDF creation error")
                                    reject(error);
                                });

                                // TODO: figure out appropriate aync methods to enable finishing PDF creation
                                setTimeout(() => {
                                    console.log("Success!")
                                    resolve(pdf_file); // Promise is resolved with "Success!"
                                }, 1000);
                            });
                    });
            });
    })
}

function lookupPackagePrice(productID, packageName, productsData) {
    const product = productsData.find((product) =>
        product['Local Line Product ID'] === productID && product['Package Name'] === packageName
    );
    if (product) {
        return product['Package Price'];
    }

    return null; // Return null if no matching product is found
}

async function readVendorsCSVFile(filePath) {
    try {
        const dataObject = {};

        // Read the CSV file
        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(filePath);

            // Parse the CSV data
            fastcsv.parseStream(stream, { headers: true })
                .on('data', (row) => {
                    const vendorName = row['Vendor'];
                    const email = row['Email'];

                    if (vendorName && email) {
                        dataObject[vendorName] = email; // Use vendorName as the key
                    }
                })
                .on('end', () => {
                    resolve();
                })
                .on('error', (error) => {
                    reject(error);
                });
        });

        return dataObject;
    } catch (error) {
        throw new Error(error);
    }
}
async function readVendorsExcel(filePath) {
    try {
        const workbook = new ExcelJS.Workbook();
        //console.log('read ' + filePath)
        const dataArray = [];

        await workbook.xlsx.readFile(filePath)
        // Assuming the data is in the second sheet
        const worksheet = workbook.getWorksheet(2);

        // Get the attribute names from the first row (header)
        const attributeNames = worksheet.getRow(1).values;

        // Create an array of objects with attribute names as keys
        for (let rowNumber = 2; rowNumber <= worksheet.actualRowCount; rowNumber++) {
            const row = worksheet.getRow(rowNumber).values;
            const obj = {};
            for (let i = 1; i < attributeNames.length; i++) {
                obj[attributeNames[i]] = row[i];
            }
            dataArray.push(obj);
        }

        //console.log('dataArray')
        //console.log(dataArray);
        return dataArray

    } catch (error) {
        throw new Error(error)
    }

}

// Build all check-lists
async function vendors(fullfillmentDate) {
    try {
        console.log("running checklist builder")
        delivery_order_file_path = 'data/orders_list_' + fullfillmentDate + ".csv"

        vendor_file_path = ''

        data = await utilities.getAccessToken();
        const accessToken = JSON.parse(data).access;

        products_url = 'https://localline.ca/api/backoffice/v2/products/export/?direct=true'
        products_file = 'data/products.xlsx'



        vendors_url = 'https://localline.ca/api/backoffice/v2/vendors/export/?direct=true'
        vendors_file = 'data/vendors.csv'
        utilities.downloadBinaryData(vendors_url, vendors_file, accessToken)
            .then((vendors_file) => {
                utilities.downloadBinaryData(products_url, products_file, accessToken)
                    .then((products_file) => {
                        writeVendorsPDF(products_file, vendors_file, delivery_order_file_path)
                            .then((vendors_pdf) => {

                                // Email information
                                const emailOptions = {
                                    from: "jdeck88@gmail.com",                                    
                                    to: "fullfarmcsa@deckfamilyfarm.com",
                                    cc: "jdeck88@gmail.com, summer.m.spell@gmail.com, shantideck22@gmail.com",
                                    subject: 'FFCSA Reports: All Vendor Data for ' + fullfillmentDate,
                                    text: "Please see the attached file.  Reports are generated twice per week in advance of fullfillment dates.",
                                };

                                // Attach the file to the email
                                emailOptions.attachments = [
                                    {
                                        filename: "vendors.pdf",
                                        content: fs.readFileSync(vendors_pdf),
                                    }]
                                utilities.sendEmail(emailOptions)

                            }).catch((error) => {
                                console.error("Error in writeChecklistPDF:", error);
                            });
                    })
                    .catch((error) => {
                        console.log('error fetching products file ....');
                        utilities.sendErrorEmail(error)
                    })
            })
            .catch((error) => {
                console.log('error fetching vendors file ....');
                utilities.sendErrorEmail(error)
            })
    } catch (error) {
        console.error('A general occurred:', error);
    }
}

// Run the checklist script
//fullfillmentDate = '2023-10-31'
fullfillmentDateObject = utilities.getNextFullfillmentDate()
vendors(fullfillmentDateObject.date);
