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


// Function to format the JSON object into a plain text list
function formatCustomersList(customers) {
    // Initialize an empty string to store the formatted list
    let formattedList = '';

    // Iterate through each customer in the JSON array
    customers.forEach(customer => {
        // Append the customer's details in the specified format
        formattedList += `Customer: ${customer.customer}\n`;
        formattedList += `Email: ${customer.email}\n`;
        formattedList += `Sum of Fees to Credit: $${customer.sumOfFees}\n\n`;
    });

    // Return the formatted list
    return formattedList;
}

async function subscribers(filename, fees) {
    return new Promise((resolve, reject) => {
        const sortedData = [];
        const matchingCustomers = [];

        // Create a map from the fees array using emails as keys
        const emailToFeeMap = new Map();
        fees.forEach(feeEntry => {
            const email = feeEntry.email;
            const fee = feeEntry.fee;
            if (emailToFeeMap.has(email)) {
                // Sum the fees for each email
                const existingFee = emailToFeeMap.get(email);
                emailToFeeMap.set(email, existingFee + fee);
            } else {
                emailToFeeMap.set(email, fee);
            }
        });

        // Read the CSV file and collect rows
        fs.createReadStream(filename)
            .pipe(fastcsv.parse({ headers: true }))
            .on('data', (row) => {
                sortedData.push(row);
            })
            .on('end', () => {
                // Process the sortedData array to find matches
                sortedData.forEach(row => {
                    // Check if the row has a 'Total' of 500
                    if (parseFloat(row.Total) === 500 && row.Status === "Active") {
                        // Look for a matching email in the emailToFeeMap
                        const email = row.Email;
                        if (emailToFeeMap.has(email)) {
                            // Add the customer, email, and summed fees to the matchingCustomers array
                            const summedFee = emailToFeeMap.get(email);
                            matchingCustomers.push({
                                customer: row.Customer,
                                email: row.Email,
                                sumOfFees: summedFee
                            });
                        }
                    }
                });
                // Resolve the promise with the matchingCustomers array
                resolve(matchingCustomers);
            })
            .on('error', (err) => {
                // Reject the promise if an error occurs
                reject(err);
            });
    });
}


async function fees(filename, start, end) {
    return new Promise((resolve, reject) => {
        // Initialize variables to group items by "Fulfillment Name"
        const customers = {}; // Store customer data including attributes
        const sortedData = [];
        const resultArray = []; // Array to store the filtered data

        // Read the CSV file and sort by "Customer Name" before processing
        fs.createReadStream(filename)
            .pipe(fastcsv.parse({ headers: true }))
            .on('data', (row) => {
                sortedData.push(row);
            })
            .on('end', () => {
                // Count number of unique orders and calculate total items and total order amount
                const uniqueOrderIDs = new Set();
                sortedData.forEach(row => {
                    const orderID = row.Order;
                    if (!uniqueOrderIDs.has(orderID)) {
                        uniqueOrderIDs.add(orderID);
                        const fulfillmentFee = parseFloat(row['Fulfillment Fee']);
                        if (fulfillmentFee > 0) {
                            // Create an object with the desired properties and add it to resultArray
							//console.log(row.Customer,fulfillmentFee)
                            resultArray.push({
                                order: row.Order,
                                customer: row.Customer,
                                email: row.Email,
								fee: fulfillmentFee
                            });
                        }
                    }
                });

                // Resolve the promise with the resultArray
                resolve(resultArray);
            })
            .on('error', (err) => {
                // Reject the promise if an error occurs
                reject(err);
            });
    });
}

//
async function run(start, end) {
    try {
        // Initialize data variable
        data = {};

        // Login
        data = await utilities.getAccessToken();
        const accessToken = JSON.parse(data).access;

        // Download and Process Order Data
        let url = 'https://localline.ca/api/backoffice/v2/orders/export/?' +
            'file_type=orders_list_view&send_to_email=false&direct=true&' +
            `fulfillment_date_start=${start}&` +
            `fulfillment_date_end=${end}&` +
            'payment__status=PAID&price_lists=2966%2C2718%2C3124&status=OPEN';

        data = await utilities.getRequestID(url, accessToken);
        let id = JSON.parse(data).id;
        let results_url = await utilities.pollStatus(id, accessToken);
        let orders_file_path = await utilities.downloadData(results_url, 'benefits_orders_list_' + end + ".csv");

        // Execute the fees function
        const result = await fees(orders_file_path, start, end);

        // Download and Process Subscriber Data
        url = 'https://localline.ca/api/backoffice/v2/order-subscriptions/export/';
        let file_path = await utilities.downloadBinaryData(url, 'data/subscribers_' + end + '.csv', accessToken);

        // Execute the subscribers function and log the result
        const subscribersResult = await subscribers(file_path, result);

		subjectString = "FFCSA Report: Weekly Benefit Accounting for Fulfmillment Dates " + start + " to " + end;
        setTimeout(() => {
            const emailOptions = {
                from: "jdeck88@gmail.com",
                to: "fullfarmcsa@deckfamilyfarm.com",
                cc: "jdeck88@gmail.com",
                subject: subjectString,
                text: "The following report lists Harvester ($500) level members requiring \n"+
		      "reimbursement of delivery fees. This report only returns Harvest-level\n" + 
		      "members ordering less than the normal $125 minimum for free delivery.\n" +
					"Fulfillment Dates spanning " + start + " to " +end +": \n\n" + 
					formatCustomersList(subscribersResult)
            };
            utilities.sendEmail(emailOptions)
        }, 3000);

        console.log(subscribersResult);

        // Optional: Continue with any further processing after both functions complete

    } catch (error) {
        // Handle any errors that occur in the try block
        console.error('An error occurred:', error);
        utilities.sendErrorEmail(error);
    }
}

// Extract command line arguments
const commandLineArgs = process.argv.slice(2); // slice to remove first two default arguments

// Default to today's date if no command line argument provided
const dateArg = commandLineArgs.length > 0 ? commandLineArgs[0] : utilities.getToday();
const priorWeek = utilities.getPreviousWeek(dateArg); // Date is formatted as "YYYY-MM-DD"

console.log(priorWeek.start)
console.log(priorWeek.end)
run(priorWeek.start, priorWeek.end);
