// Using the following get  the "access" property
var request = require('request');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const utilities = require('./utilities');
const ExcelJS = require('exceljs');

function formatPhoneNumber(phoneNumber) {
    // Remove all non-digit characters
    const digits = phoneNumber.replace(/\D/g, '');

    // Format into (XXX) XXX-XXXX
    return `(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6)}`;
}

async function readLocalExcelAndExtractColumnData(filePath) {
  try {
      // Load the Excel workbook from the local file
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);

      // Get the first worksheet
      const worksheet = workbook.worksheets[0]; // Assuming the first worksheet

      // Find the column index for "Local Line Product ID"
      const headerRow = worksheet.getRow(1);
      let columnIndex = -1;
      headerRow.eachCell((cell, colNumber) => {
          if (cell.value === 'Local Line Product ID') {
              columnIndex = colNumber;
          }
      });

      if (columnIndex === -1) {
          throw new Error('Column "Local Line Product ID" not found');
      }

      // Populate an array with the values in the "Local Line Product ID" column
      const localLineProductIDs = [];
      for (let i = 2; i <= worksheet.rowCount; i++) {
          const cell = worksheet.getCell(i, columnIndex);
          localLineProductIDs.push(cell.value.toString());
      }

      return localLineProductIDs;
  } catch (error) {
      throw new Error(error)
  }
}

async function writeChecklistPDF(dairy_file_path, frozen_file_path, delivery_order_file_path) {
  return new Promise((resolve, reject) => {
    const pdf_file = 'data/dropsite_checklist.pdf'
    // Create a new PDF document
    const doc = new PDFDocument();
    doc.pipe(fs.createWriteStream(pdf_file))

    // Initialize variables to group items by "Fulfillment Name"
    const dropsites = {};
    const dropsitesAll = {};

    const masterdropsites = {};
    const customers = {}
    let currentDropsiteName = null;
    let currentCustomerName = null;
    fullfillmentDate = ''

    const sortedData = [];

    readLocalExcelAndExtractColumnData(dairy_file_path)
      .then((dairy_ids) => {
        readLocalExcelAndExtractColumnData(frozen_file_path)
          .then((frozen_ids) => {
            // read the delivery orders 
            fs.createReadStream(delivery_order_file_path)
              .pipe(fastcsv.parse({ headers: true }))
              .on('data', (row) => {
                sortedData.push(row);
              })
              .on('end', () => {
                // Sort the data by "Fullfillment Name"
                sortedData.sort((a, b) => a['Fulfillment Name'].localeCompare(b['Fulfillment Name']));

                // update the disposition field
                sortedData.forEach((item) => {
                  item.disposition = "tote";
                });
                updatedData = updateCategoryForProductID(sortedData, dairy_ids, 'dairy');
                updatedData = updateCategoryForProductID(updatedData, frozen_ids, 'frozen');

                //updatedData.sort((a, b) => a['Fulfillment Name'].localeCompare(b['Fulfillment Name']));

                updatedData.sort((a, b) => {
                  const nameComparison = a['Fulfillment Name'].localeCompare(b['Fulfillment Name']);
                  if (nameComparison === 0) {
                    // If the 'Fulfillment Name' is the same, sort by 'Customer' column
                    return a['Customer'].localeCompare(b['Customer']);
                  }
                  return nameComparison;
                });
//console.log(updatedData)
                // We want to create an array of dropsites that contains an array of customers (the dropsite)
                // contains just the dropsite name and the customers contain the Customer, Phone
                updatedData.forEach((row) => {
                  dropsiteName = row['Fulfillment Name']
                  disposition = row['disposition']
                  customerName = row['Customer'] + "\n" + formatPhoneNumber(row['Phone'])
                  fullfillmentDate = utilities.formatDate(row['Fulfillment Date'])
                  customerPhone = row['Phone']
                  category = row['Membership']
                  quantity = Math.round(parseFloat(row['Quantity']));
                  //product = row['Product'];
                  product = row['Product'] + ' - ' + row['Package Name'];

                  itemUnit = row['Item Unit']
                  vendor = row['Vendor']

                  if (dropsiteName !== currentDropsiteName) {
                    currentDropsiteName = dropsiteName;
                    dropsites[dropsiteName] = {
                      customers: []
                    };
                    masterdropsites[dropsiteName] = []
                    dropsitesAll[dropsiteName] = {
                      customers: []
                    };
                  }

                  if (customerName !== currentCustomerName) {
                    currentCustomerName = customerName
                    dropsites[dropsiteName].customers[customerName] = []
                    dropsitesAll[dropsiteName].customers[customerName] = []

                  }

                  dropsites[dropsiteName].customers[customerName].push({
                    name: customerName,
                    phone: customerPhone,
                    quantity: quantity,
                    product: product,
                    itemUnit: itemUnit,
                    disposition: disposition
                  });
                  dropsitesAll[dropsiteName].customers[customerName].push({
                    name: customerName,
                    phone: customerPhone,
                    quantity: quantity,
                    product: product,
                    itemUnit: itemUnit,
                    disposition: disposition
                  });
                });
                dispositionCounts = {}

                // Iterate through items and generate the PDF content
                for (const dropsiteName in dropsites) {
                  const dropsiteData = dropsites[dropsiteName];

                  // Group and sum the "disposition" values
                  for (const customerName in dropsites[dropsiteName].customers) {
                    customerData = dropsites[dropsiteName].customers[customerName]
                    quantity = customerData[0].quantity
                    dispositionCounts = customerData.reduce((accumulator, item) => {
                      const disposition = item.disposition;

                      if (disposition === 'dairy') {
                        accumulator[disposition] = (accumulator[disposition] || 0) + item.quantity;
                      } else if (disposition === 'tote' || disposition === 'frozen') {
                        accumulator[disposition] = 1
                      }
                      return accumulator;
                    }, {});


                    dropsites[dropsiteName].customers[customerName] = { ...customerData.customers, ...dispositionCounts }
                    //console.log(quantity + "=" + JSON.stringify(dropsites[dropsiteName].customers[customerName]))
                  }
                }

                count = 0
                for (const dropsiteName in dropsites) {
                  if (count > 0) {
                    doc.addPage();
                  }
                  count++
                  doc.fontSize(12).text(fullfillmentDate, { align: 'right' });

                  doc.fontSize(16).text(dropsiteName + " Manifest", { bold: true });

                  // Convert the data into the desired format
                  const tableData = Object.entries(dropsites[dropsiteName].customers).map(([name, values]) => ({
                    name,
                    tote: values.tote || '',
                    dairy: values.dairy || '',
                    frozen: values.frozen || ''
                  }));
                  masterdropsites[dropsiteName] = (tableData)
                  const tableOptions = {
                    headers: ['Name', 'Tote', 'Dairy', 'Frozen'],
                    rows: tableData.map((row) => [row.name, row.tote, row.dairy, row.frozen]),
                  };

                  doc.table(tableOptions);
                }


                // Master Checklist Table
                for (const dropsiteName in masterdropsites) {
                  dropsiteData = masterdropsites[dropsiteName]
                  const sums = dropsiteData.reduce(
                    (accumulator, current) => {
                      accumulator.tote += current.tote || 0;
                      accumulator.dairy += current.dairy || 0;
                      accumulator.frozen += current.frozen || 0;
                      return accumulator;
                    },
                    { tote: 0, dairy: 0, frozen: 0 }
                  );

                  masterdropsites[dropsiteName] = sums
                }
                doc.addPage();
                doc.fontSize(16).text("Master Manifest", { bold: true });
                const tableData = [
                  ...Object.entries(masterdropsites).map(([dropsite, values]) => [dropsite, values.tote, values.dairy, values.frozen]),
                ];
                // Define the table options
                const tableOptions = {
                  headers: ['Dropsite', 'Tote', 'Dairy', 'Frozen'],
                  rows: tableData
                };
                doc.table(tableOptions);
                doc.addPage();

                // Product specific Packlist
                productSpecificPackList(doc, dropsitesAll, 'frozen')
                doc.addPage();
                productSpecificPackList(doc, dropsitesAll, 'dairy')

                doc.end();
                // Wait for the stream to finish and then resolve with the file path
                doc.on('finish', () => {
                  console.log('PDF created successfully.');
                  resolve(pdf_file)
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

              })

          })

          .catch((error) => {
            console.error('Error:', error);
            throw new Error(error)
          });

      })
      .catch((error) => {
        console.error('Error:', error);
        throw new Error(error)
      });

  });

}

function productSpecificPackList(doc, dropsitesAll, disposition) {

  count = 0;
  for (const dropsiteName in dropsitesAll) {
    const selectedCustomers = {};
    for (const customerName in dropsitesAll[dropsiteName].customers) {
      const customerData = dropsitesAll[dropsiteName].customers[customerName];
      const frozenProducts = customerData.filter((product) => product.disposition === disposition);

      if (frozenProducts.length > 0) {
        selectedCustomers[customerName] = frozenProducts;
      }      
    }

    // only print dropsites that have desired product
    if (Object.keys(selectedCustomers).length > 0) {
      if (count > 0) {
        doc.addPage();
      }
      doc.fontSize(14).text(dropsiteName + " " + disposition.charAt(0).toUpperCase() + disposition.slice(1) + " Product Packlist", { bold: true });
      doc.moveDown();

      allCustomersTable = []
      for (const customerName in selectedCustomers) {
        customerData = selectedCustomers[customerName]

        const tableData = [
          ...Object.entries(customerData).map(([dropsite, values]) => [
            customerName,
            values.product,
            values.itemUnit,
            values.quantity,
          ]),
        ];
        allCustomersTable.push(...tableData);        
      }
      const tableOptions = {
        headers: ['Name', 'Product', 'Unit', 'Quantity'],
        rows: allCustomersTable
      };
      doc.table(tableOptions)
      count++
    }
  }
}


// Function to add a new page if the remaining space is less than the table height
function addPageIfNecessary(dropsiteName, data, doc) {
  //threshold = 100
  const cellHeight = 80; // Set your desired cell height
  const totalRowsHeight = data.length * cellHeight;
  const headerHeight = cellHeight; // Assuming header height is the same as cell height
  const tableHeight = totalRowsHeight + headerHeight;

  remainingHeight = doc.page.height - doc.y

  if (tableHeight > remainingHeight) {
    doc.addPage();
    doc.text(dropsiteName + " (next page...)")
  }
}

function updateCategoryForProductID(jsonData, productIDsToUpdate, value) {
  jsonData.forEach((item) => {
    product_id_string = Math.floor(item['Product ID'].toString().trim()).toString();
    if (productIDsToUpdate.includes(product_id_string)) {
      //console.log('adding ' + item.disposition)
      item.disposition = value;
    } 
  });
  return jsonData;
}


function sendEmail(file_location, filename, subject) {
  // Email information
  const emailOptions = {
    from: "jdeck88@gmail.com",
    to: "fullfarmcsa@deckfamilyfarm.com",
    cc: "jdeck88@gmail.com, info@deckfamilyfarm.com",
    subject: subject,
    text: "Please see the attached file.  Reports are generated twice per week in advance of fullfillment dates.",
  };

  // Attach the file to the email
  emailOptions.attachments = [
    {
      filename: filename, // Change the filename as needed
      content: fs.readFileSync(file_location), // Attach the file buffer
    },
  ];


  utilities.sendEmail(emailOptions)
}
// Build all check-lists
async function checklist(fullfillmentDate) {
  try {
    console.log("running checklist builder")
    delivery_order_file_path = 'data/orders_list_' + fullfillmentDate + ".csv"

    dairy_data = {}
    frozen_data = {}
    dairy_file_path = ''
    frozen_file_path = ''

    // Login
    data = await utilities.getAccessToken();
    const accessToken = JSON.parse(data).access;

    //dairy tags
    dairy_url = 'https://localline.ca/api/backoffice/v2/products/export/?internal_tags=2244&direct=true'
    // frozen and turkey
    frozen_url = 'https://localline.ca/api/backoffice/v2/products/export/?internal_tags=2245,2266&direct=true'

    dairy_file = 'data/dairy.xlsx'
    frozen_file = 'data/frozen.xlsx'
    // Download File
    utilities.downloadBinaryData(dairy_url, dairy_file, accessToken)
      .then((dairy_file) => {
        utilities.downloadBinaryData(frozen_url, frozen_file, accessToken)
          .then((frozen_file) => {
            writeChecklistPDF(dairy_file, frozen_file, delivery_order_file_path)
              .then((checklist_pdf) => {
                sendEmail(checklist_pdf, 'manifests.pdf', 'FFCSA Reports: Manifests for ' + fullfillmentDate)


              }).catch((error) => {
                console.error("Error in writeChecklistPDF:", error);
                utilities.sendErrorEmail(error)
              });
          })
          .catch((error) => {
            console.log('error fetching frozen products list, continuing to run checklist process using local copy as this file often halts....');
            writeChecklistPDF(dairy_file, frozen_file, delivery_order_file_path)
              .then((checklist_pdf) => {
                console.log('TODO write catch!')
                sendEmail(checklist_pdf, 'manifests.pdf', 'FFCSA Reports: Manifests for ' + fullfillmentDate)
              }).catch((error) => {
                console.error("Error in writeChecklistPDF:", error);
                utilities.sendErrorEmail(error)
              });
          });
      })
      .catch((error) => {
        console.error('error fetching dairy products list');
        utilities.sendErrorEmail(error)
      });

  } catch (error) {
    console.error('A general occurred:', error);
    utilities.sendErrorEmail(error)
  }
}

// Run the checklist script
///fullfillmentDate = '2023-10-31'
fullfillmentDateObject = utilities.getNextFullfillmentDate()

checklist(fullfillmentDateObject.date);
