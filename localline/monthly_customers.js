// Using the following get  the "access" property
var request = require('request');
const fs = require('fs');
const path = require('path');
const utilities = require('./utilities');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const axios = require('axios');
const fastcsv = require('fast-csv');

pdf_file_name = '';
pdf_file = '';


async function run(filename, lastDay, yesterday) {
    return new Promise((resolve, reject) => {

        // Create a new PDF document
        pdf_file_name = 'customers_' + yesterday + '.pdf';
        pdf_file = 'data/' + pdf_file_name

        const doc = new PDFDocument();
        doc.pipe(fs.createWriteStream(pdf_file));

        const customers = [];

        fs.createReadStream(filename)
            .pipe(fastcsv.parse({ headers: true }))
            .on('data', (row) => {
                customers.push({
                    name: row['Customer'], // Assuming 'Customer Name' is a column in your CSV
                    amount: parseFloat(row['Store Credit'])
                });
            })
            .on('end', () => {

                all_customer_sales = 0
                let customerData = [];

                customers.sort((a, b) => b.amount - a.amount);

                customers.forEach((item) => {
                    const { amount } = item;
                    all_customer_sales = all_customer_sales + parseFloat(amount)
                    customerData.push([item.name, item.amount.toFixed(2)])
                });

                formattedBalance = all_customer_sales.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

				doc.text('Total member balances = ' + formattedBalance + ' as of ' + yesterday + ' 11:59pm')

   				table = {
                            title: 'Customer Balances',
                            widths: [600], // Set the width to the page width
                            headers: ['customer', 'balance'],
                            rows: customerData,
                };

                doc.table(table);

                doc.end();


                // TODO: figure out appropriate aync methods to enable finishing PDF creation
                setTimeout(() => {
                    console.log("Success!")
                    resolve(formattedBalance); // Promise is resolved with "Success!"
                }, 1000);
            })
            .on('error', (error) => {
                reject(error);
            });
    });
}

// Build customer delivery orders (picklists)
async function customers(today, yesterday) {
    try {
        console.log("running monthly customer balance report")

        url = 'https://localline.ca/api/backoffice/v2/customers/export/?direct=true'
        console.log(url)
        data = {}

        // Login
        data = await utilities.getAccessToken();
        const accessToken = JSON.parse(data).access;

        // Call the function and wait for the response
        (async () => {
            try {
                console.log("fetching customers ...")

                // Download File
                if (url !== "") {
                    utilities.downloadBinaryData(url, 'data/customers_' + today + '.csv', accessToken)
                        .then((customer_file_path) => {
                            console.log('Downloaded file path:', customer_file_path);
                            run(customer_file_path, today, yesterday).then((balance) => {
                                try {
                                    const emailOptions = {
                                        from: "jdeck88@gmail.com",
                                        //to: "fullfarmcsa@deckfamilyfarm.com",
                                        to: "jdeck88@gmail.com",
										cc: "mhobart@bworcpas.com",
                                        subject: 'FFCSA Reports: Monthly Customer Balance Report for ' + yesterday,
                                        text: "Total Member Balance as of " + yesterday+ " = " + balance,
                                    };
                                   
                            		emailOptions.attachments = [
                                	{
                                    	filename: pdf_file_name, // Change the filename as needed
                                    	content: fs.readFileSync(pdf_file) // Attach the file buffer
                            		}];
                                    utilities.sendEmail(emailOptions)

                                } catch (error) {
                                    console.error('Error:', error);
                                    utilities.sendErrorEmail(error)
                                }
                            }).catch((error) => {
                                console.error('Error:', error);
                                utilities.sendErrorEmail(error)
                            })
                        })
                        .catch((error) => {
                            console.error('Error:', error);
                            utilities.sendErrorEmail(error)
                        });
                } else {
                    console.error('file generation not completed in 1 minute')
                    utilities.sendErrorEmail("file generation not completed in 1 minute")
                }
            } catch (error) {
                console.error('Error in the main function:', error);
                utilities.sendErrorEmail(error)
            }
        })();
    } catch (error) {
        console.error('An error occurred:', error);
        utilities.sendErrorEmail(error)
    }
}

//today = '2023-10-31'
customers(utilities.getToday(), utilities.getYesterday());
