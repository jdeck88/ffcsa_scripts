// Using the following get  the "access" property
var request = require('request');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const fastcsv = require('fast-csv');
const ExcelJS = require('exceljs');
const utilities = require('./utilities');
const { createObjectCsvWriter } = require('csv-writer');

async function subscribers(filename) {
	return new Promise((resolve, reject) => {
		const sortedData = [];

		fs.createReadStream(filename)
			.pipe(fastcsv.parse({ headers: true }))
			.on('data', (row) => {
				sortedData.push(row);
			})
			.on('end', () => {
				let activeMembersCount = 0;
				let totalAmountForActiveMembers = 0;
				let skippedCount = 0;
				let feedAFriendCount = 0;

				sortedData.forEach(row => {
					if (row.Status === 'Active') {
						activeMembersCount++;

						const total = parseFloat(row.Total);
						if (!isNaN(total)) {
							totalAmountForActiveMembers += total;

							// Feed-a-Friend: Total = 100, 150, 250
							if ([100, 150, 250].includes(total)) {
								feedAFriendCount++;
							}
						}

						// Skipped: Next Fulfillment Status = skipped
						if (row['Next Fulfillment Status']?.toLowerCase() === 'skipped') {
							skippedCount++;
						}
					}
				});

				// Save results to global salesData
				salesData.totalActiveSubscribers = activeMembersCount;
				salesData.projectedMonthlySubscriptionRevenue = totalAmountForActiveMembers;
				salesData.skippedSubscribers = skippedCount;
				salesData.feedAFriendSubscribers = feedAFriendCount;

				resolve(); // <-- important to resolve the promise
			})
			.on('error', reject);
	});
}


async function orders(filename, start, end) {
	return new Promise((resolve, reject) => {
		// Initialize variables to group items by "Fulfillment Name"
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


				// Initialize variables to store total items and total order amount
				let totalItems = 0;
				let totalOrderAmount = 0;
				let overallAmountPaid = 0;

				const fulfillmentTotals = {};
				const fulfillmentOrderCounts = {};
				const vendorTotals = {};
				const categoryTotals = {};
				productTotals = {};
				const dropsiteTotals = {};


				// Count number of unique orders and calculate total items and total order amount
				const uniqueOrderIDs = new Set();
				sortedData.forEach(row => {
					const orderID = row.Order;
					const orderTotal = parseFloat(row['Order Total']);
					const productSubtotal = parseFloat(row['Product Subtotal']);
					const fulfillmentName = row['Fulfillment Name'];
					const vendor = row.Vendor;
					const category = row.Category;
					const product = row.Product;
					const dropsite = fulfillmentName;

					// Sum the order total by fulfillment name
					if (!fulfillmentTotals[fulfillmentName]) {
						fulfillmentTotals[fulfillmentName] = 0;
					}
					// Count unique orders by fulfillment name
					if (!fulfillmentOrderCounts[fulfillmentName]) {
						fulfillmentOrderCounts[fulfillmentName] = 0;
					}

					if (!uniqueOrderIDs.has(orderID)) {
						uniqueOrderIDs.add(orderID);
						totalOrderAmount += parseFloat(row['Order Total']); // Assuming 'Order Total' is the column containing order total
						fulfillmentTotals[fulfillmentName] += orderTotal;
						fulfillmentOrderCounts[fulfillmentName] += 1;
					}

					// vendor JSON
					if (!vendorTotals[vendor]) {
						vendorTotals[vendor] = 0;
					}
					vendorTotals[vendor] += productSubtotal;

					// category JSON
					if (!categoryTotals[category]) {
						categoryTotals[category] = 0;
					}
					categoryTotals[category] += productSubtotal;

					// dropsite JSON
					if (!dropsiteTotals[dropsite]) {
						dropsiteTotals[dropsite] = 0;
					}
					dropsiteTotals[dropsite] += productSubtotal;

					// product JSON
					if (!productTotals[product]) {
						productTotals[product] = 0;
					}
					productTotals[product] += productSubtotal;

					totalItems += 1
					overallAmountPaid += productSubtotal;

				});

				// Convert the object into an array of [key, value] pairs
				const entries = Object.entries(productTotals);

				// Sort the array by the values (sales) in descending order
				entries.sort((a, b) => b[1] - a[1]);

				// Extract the top 20 highest sellers
				const top20 = entries.slice(0, 20);

				// Convert the top 10 array back to an object (if needed)
				productTotals = Object.fromEntries(top20);

				const uniqueOrderCount = uniqueOrderIDs.size;
				const averageItemsPerOrder = totalItems / uniqueOrderCount;
				const averageOrderAmount = totalOrderAmount / uniqueOrderCount;

				// Count number of unique orders made by guests
				// Initialize a Set to store unique order IDs made by guests
				const uniqueGuestOrders = new Set();
				sortedData.forEach(row => {
					const orderID = row.Order;
					const priceList = row['Price List'];

					// Check if the price list contains 'Guest'
					if (priceList.includes('Guest')) {
						uniqueGuestOrders.add(orderID);
					}
				});

				// Get the count of unique orders made by guests
				const uniqueGuestOrderCount = uniqueGuestOrders.size;
				salesData.totalSales = overallAmountPaid.toFixed(2);
				salesData.numOrders = uniqueOrderCount;
				salesData.numGuestOrders =  uniqueGuestOrderCount;
				salesData.numSubscriberOrders = Math.round(uniqueOrderCount - uniqueGuestOrderCount);
				salesData.averageItemsPerOrder = Math.round(averageItemsPerOrder);
				salesData.averageOrderAmount = averageOrderAmount.toFixed(2);
				salesData.vendors = vendorTotals;
				salesData.category = categoryTotals;
				salesData.product = productTotals;
				salesData.dropsite = dropsiteTotals;

				// format the salesDataObject
				const salesDataObject = {
					dateRange: start + ' to ' + end,
					data: salesData 
				};
				salesResults = salesDataObject;

				formatNumbers(salesResults);

			});
	});
}


function formatNumbers(obj) {
  for (let key in obj) {
    if (typeof obj[key] === 'number') {
      obj[key] = parseFloat(obj[key].toFixed(2));
    } else if (typeof obj[key] === 'object') {
      formatNumbers(obj[key]);
    }
  }
}
// Build customer delivery orders (picklists)
async function run(start, end) {
	try {
		data = {}
		// Login
		data = await utilities.getAccessToken();
		const accessToken = JSON.parse(data).access;

		// Download and Process Order Data
		url = 'https://localline.ca/api/backoffice/v2/orders/export/?' +
			'file_type=orders_list_view&send_to_email=false&direct=true&' +
			`fulfillment_date_start=${start}&` +
			`fulfillment_date_end=${end}&` +
			'payment__status=PAID&price_lists=2966%2C2718%2C3124&status=OPEN'
		data = await utilities.getRequestID(url, accessToken);
		id = JSON.parse(data).id;
		results_url = await utilities.pollStatus(id, accessToken);
		orders_file_path = await utilities.downloadData(results_url, 'kpi_orders_list_' + end + ".csv")
		orders(orders_file_path, start,end).then(result => {
			console.log('orders finished');
		})
			.catch(error => {
				console.error(error);
			});

		// Download and Process Subscriber Data
		url = 'https://localline.ca/api/backoffice/v2/order-subscriptions/export/'
		file_path = await utilities.downloadBinaryData(url, 'data/subscribers_'+end+'.csv', accessToken)
		subscribers(file_path).then(result => {
			console.log('subscribers finished');
		})
			.catch(error => {
				console.error(error);
			});

		setTimeout(() => {
			subjectString =  'FFCSA Reports: Weekly KPIs for ' + start + " to " + end;
			console.log('appending to json');
			console.log('for ' + start + ' to '  + end);
			appendJSON(salesResults, 'data/weekly_kpi.json')
			//appendJSON(fulfillmentResults, 'data/fulfillment_kpi.json')
			//console.log(salesResults)
			//console.log(subjectString);
			const emailOptions = {
				from: "jdeck88@gmail.com",
				to: "fullfarmcsa@deckfamilyfarm.com",
				cc: "jdeck88@gmail.com",
				subject: subjectString,
				text: JSON.stringify(salesData, null, 4) + "\n\nRunning KPI stats viewable at:\nhttps://github.com/jdeck88/ffcsa_scripts/blob/main/localline/data/weekly_kpi.csv"
			};
			utilities.sendEmail(emailOptions)
		}, 3000);


	} catch (error) {
		console.error('An error occurred:', error);
		utilities.sendErrorEmail(error)
	}
}

// Append to output JSON file
function appendJSON(dataStructure, filename) {
	//console.log('Fulfillment Totals:', JSON.stringify(dataStructure, null, 2));

	// Read the existing file
	fs.readFile(filename, 'utf8', (err, fileData) => {
		let jsonData;

		if (err) {
			// If the file does not exist, initialize an empty structure
			if (err.code === 'ENOENT') {
				jsonData = { weeks: [] };
			} else {
				console.error('Error reading the file:', err);
				return;
			}
		} else {
			// Parse the existing file data
			try {
				jsonData = JSON.parse(fileData);
			} catch (parseErr) {
				console.error('Error parsing the file data:', parseErr);
				return;
			}
		}

		// Ensure jsonData has a weeks array
		if (!Array.isArray(jsonData.weeks)) {
			jsonData.weeks = [];
		}

		// Find the index of the existing entry with the same dateRange, if it exists
		const existingIndex = jsonData.weeks.findIndex(week => week.dateRange === dataStructure.dateRange);

		if (existingIndex >= 0) {
			// Replace the existing entry
			console.log("replacing")
			jsonData.weeks[existingIndex] = dataStructure;
		} else {
			// Append the new data structure
			console.log("appending")
			jsonData.weeks.push(dataStructure);
		}

		// Write the updated data back to the file
		fs.writeFile(filename, JSON.stringify(jsonData, null, 2), 'utf8', (writeErr) => {
			if (writeErr) {
				console.error('Error writing to the file:', writeErr);
			} else {
				console.log('File updated successfully: ' + filename);
			}
		});
	});
}

// Extract command line arguments
const commandLineArgs = process.argv.slice(2); // slice to remove first two default arguments

// Default to today's date if no command line argument provided
const dateArg = commandLineArgs.length > 0 ? commandLineArgs[0] : utilities.getToday();
const priorWeek = utilities.getPreviousWeek(dateArg); // Date is formatted as "YYYY-MM-DD"

// Create an array for the results
//nfulfillmentResults = {};
salesResults = {}
const salesData = {
	totalSales: 0,
	numOrders: 0,
	numSubscriberOrders: 0,
	numGuestOrders: 0,
	averageItemsPerOrder: 0,
	averageOrderAmount: 0,
	totalActiveSubscribers: 0,
	projectedMonthlySubscriptionRevenue: 0,
	vendors: {},
	category: {},
	product: {},
	dropsite: {}
};


// NOTE: to run this from the command line, give a day in the future, like:
// $node weekly_kpi.js 2024-07-10
// can build a shell script to back populate all data

console.log(priorWeek.start, priorWeek.end);
run(priorWeek.start, priorWeek.end);
//run('2025-07-21', '2025-07-27')
