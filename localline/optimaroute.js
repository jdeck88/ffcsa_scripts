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
    let digits = phoneNumber.replace(/\D/g, '');

    // If the first digit is 1, remove it
    if (digits.startsWith('1')) {
        digits = digits.substring(1);
    }

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

async function writeOptimarouteXLSX(dairy_file_path, frozen_file_path, delivery_order_file_path) {
	return new Promise((resolve, reject) => {
		//const pdf_file = 'data/dropsite_checklist.pdf'
		const xlsx_file = 'data/optimaroute.xlsx'
		// Create a new PDF document
		//const doc = new PDFDocument();
		//doc.pipe(fs.createWriteStream(pdf_file))

		// Initialize variables to group items by "Fulfillment Name"
		const addresses = {};
		let currentFulfillmentAddress = null;
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
									type = row['Fulfillment Type']
									fulfillmentAddress = row['Fulfillment Address']
									disposition = row['disposition']
									customerName = row['Customer']
									customerPhone = formatPhoneNumber(row['Phone'])
									companyName = row['Company']
									fullfillmentDate = utilities.formatDate(row['Fulfillment Date'])
									category = row['Membership']
									quantity = Math.round(parseFloat(row['Quantity']));
									//product = row['Product'];
									product = row['Product'] + ' - ' + row['Package Name'];

									itemUnit = row['Item Unit']
									vendor = row['Vendor']
									if (type === 'pickup') {
										customerName = "Dropsite: " + dropsiteName
										customerPhone = ''
										instructions = getInstructionsByName(fulfillment_json,dropsiteName)
									} else {
                    // we replace instructions with the Company Name in the case of delivery, as
                    // the Company field stores home delivery instructions per customer
										instructions = companyName
										dropsiteName = ''
									}

									if (fulfillmentAddress !== currentFulfillmentAddress) {
										currentFulfillmentAddress = fulfillmentAddress;
										addresses[fulfillmentAddress] = {
											dropsiteName: dropsiteName,
											name: customerName,
											phone: customerPhone,
											companyName: companyName,
											type: type,
											instructions: instructions,
											products: []
										};
									}
									addresses[currentFulfillmentAddress].products.push({
										quantity: quantity,
										product: product,
										itemUnit: itemUnit,
										disposition: disposition
									});

								});
								//console.log(JSON.stringify(addresses, null, 2));

								const rows = [];

								for (const address in addresses) {
									if (addresses.hasOwnProperty(address)) {
										const addressData = addresses[address];
										const { dropsiteName, name, phone, type, instructions, products } = addressData;

										let tote = '';
										let frozen = '';
										let dairy = 0;

										products.forEach(product => {

											if (product.disposition === 'tote') {
												if (type != 'pickup') {
													tote = 1;
												} else { tote = 'n' }
											} else if (product.disposition === 'frozen') {
												if (type != 'pickup') {
													frozen = 1;
												} else { frozen = 'n'}

											} else if (product.disposition === 'dairy') {
												dairy += product.quantity;
											}
										});
										if (dairy === 0) {
											dairy = ''
										}

										// Add a row for the current address
										rows.push([name, phone, address, instructions, tote, frozen, dairy]);
									}
								}

								// TODO: figure out appropriate aync methods to enable finishing PDF creation
								setTimeout(() => {
									console.log("Success!")
									resolve(rows); // Promise is resolved with "Success!"
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

// Function to create and write XLSX file using ExcelJS
function writeXLSX(rows, outputPath) {
	return new Promise((resolve, reject) => {
		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet('Sheet1');

		// Define the headers
		const headers = ['name/dropsite', 'phone', 'address', 'instructions', 'tote', 'frozen', 'dairy'];
		worksheet.addRow(headers);

		// Add the data rows
		rows.forEach(row => {
			worksheet.addRow(row);
		});

		// Write the workbook to a file
		workbook.xlsx.writeFile(outputPath)
			.then(() => {
				console.log(`XLSX file has been written to ${outputPath}`);
				resolve();
			})
			.catch((error) => {
				reject(error);
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
		cc: "jdeck88@gmail.com",
		subject: subject,
		text: "Please see the attached file.  This is the Excel file to load to optimaroute. Rebecca, please try and use this file for loading to optimaroute, it contains data for all current orders for this day.",
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

function getInstructionsByName(json, name) {
    const result = json.results.find(item => item.name === name);
    if (result && result.availability && result.availability.instructions) {
        return result.availability.instructions;
    }
    return null;
}

// Build all check-lists
async function optimaroute(fullfillmentDate) {
	try {
		console.log("running optimaroutebuilder")
		delivery_order_file_path = 'data/orders_list_' + fullfillmentDate + ".csv"
    console.log(delivery_order_file_path)

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
		fulfillment_url = 'https://localline.ca/api/backoffice/v2/fulfillment-strategies/'

		dairy_file = 'data/dairy.xlsx'
		frozen_file = 'data/frozen.xlsx'
		fulfillment_json = 'data/fulfilsment.json'

		// Download File
		utilities.getJsonFromUrl(fulfillment_url, accessToken)
			.then((json) => {
				fulfillment_json = json
				//console.log(JSON.stringify(fulfillment_json, null, 2));
				utilities.downloadBinaryData(dairy_url, dairy_file, accessToken)
					.then((dairy_file) => {
						utilities.downloadBinaryData(frozen_url, frozen_file, accessToken)
							.then((frozen_file) => {
								writeOptimarouteXLSX(dairy_file, frozen_file, delivery_order_file_path)
									.then((rows) => {
										const optimaroute_xlsx = 'data/optimaroute.xlsx'

										// Write the XLSX file
										writeXLSX(rows, optimaroute_xlsx)
											.then(() => {
												console.log('XLSX file creation complete.');
												sendEmail(optimaroute_xlsx, 'optimaroute.xlsx', 'FFCSA Reports: OptimaRoute File ' + fullfillmentDate)
											})
											.catch((error) => {
												console.error("Error Creating OptimaRoute XLSX:", error);
											});

									}).catch((error) => {
										console.error("Error in OptimaRoute XLSX:", error);
										utilities.sendErrorEmail(error)
									});
							})
							.catch((error) => {
								console.log('error fetching frozen products list, continuing to run checklist process using local copy as this file often halts....');
								writeOptimarouteXLSX(dairy_file, frozen_file, delivery_order_file_path)
									.then((optimaroute_xlsx) => {
										console.log('TODO write catch!')
										sendEmail(optimaroute_xlsx, 'optimaroute.csv', 'FFCSA Reports: Optimaaroute for ' + fullfillmentDate)
									}).catch((error) => {
										console.error("Error in writeOptimarouteXLSX:", error);
										utilities.sendErrorEmail(error)
									});
							});
					})
					.catch((error) => {
						console.error('error fetching dairy products list');
						utilities.sendErrorEmail(error)
					})
					})
				.catch((error) => {
					console.error('error fetching fulfillmentJSON');
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

	optimaroute(fullfillmentDateObject.date);
