// Using the following get  the "access" property
var request = require('request');
const fs = require('fs');
const path = require('path');
const utilities = require('./utilities');
require('dotenv').config();
const PDFDocument = require('pdfkit-table');
const axios = require('axios');
const fastcsv = require('fast-csv');
const {
    BECOME_A_MEMBER_PRICE_LIST_ID,
    isBecomeAMemberSubscription,
} = require('./subscription_price_lists');


async function run(filename, lastDay) {
    return new Promise((resolve, reject) => {
        //const pdf_file = 'data/subscribers_' + lastDay + '.pdf';
        const customers = [];

        fs.createReadStream(filename)
            .pipe(fastcsv.parse({ headers: true }))
            .on('data', (row) => {
                if (!isBecomeAMemberSubscription(row)) return;
                customers.push({
                    customer: row['Customer'],
                    phone: row['Phone'],
                    email: row['Email'],
                    order_number: parseInt(row['Order']),
                    total: parseInt(row['Order Total']),
                    payment_status: row['Payment Status'],
                    order_status: row['Order Status'],
                    price_list: row['Price List']
                });
            })
            .on('end', () => {

                return_text = 'New Subscribers This Day (NEEDS_APPROVAL):\n'
                num_subscribers = 0;
                customers.forEach((item) => {
                    return_text += item['customer'] + " " + item['phone'] + "\n"
                    return_text += "    paid: $" + item['total'] + "\n"
                    return_text += "    email: " + item['email'] + "\n"
                    num_subscribers = num_subscribers + 1
                });

                // TODO: figure out appropriate aync methods to enable finishing PDF creation
                setTimeout(() => {
                    console.log("Success!")
                    resolve({ num_subscribers, return_text }); // Promise is resolved with "Success!"
                }, 1000);
            })
            .on('error', (error) => {
                reject(error);
            });
    });
}

// Build customer delivery orders (picklists)
async function new_subscribers(today) {
    try {
        console.log("running report on daily customers ")

        //url = 'https://localline.ca/api/backoffice/v2/order-subscriptions/export/'
        url= `https://localline.ca/api/backoffice/v2/orders/export/?file_type=orders_summary&send_to_email=false&destination_email=fullfarmcsa%40deckfamilyfarm.com&direct=true&status=NEEDS_APPROVAL&price_lists=${BECOME_A_MEMBER_PRICE_LIST_ID}`
        //url = 'https://localline.ca/api/backoffice/v2/orders/export/?file_type=orders_summary&send_to_email=false&destination_email=fullfarmcsa%40deckfamilyfarm.com&direct=true&status=CANCELLED'
        data = {}

        // Login
        data = await utilities.getAccessToken();
        const accessToken = JSON.parse(data).access;

        subscriber_data = await utilities.getRequestID(url, accessToken);
        const id = JSON.parse(subscriber_data).id;

        // Wait for report to finish
        const subscribers_url = await utilities.pollStatus(id, accessToken);

        // Call the function and wait for the response
        (async () => {
            try {
                console.log("fetching subscribers ...")

                // Download File
                if (url !== "") {
                    utilities.downloadData(subscribers_url, 'new_subscribers_' + today + ".csv", accessToken)
                        .then((customer_file_path) => {
                            console.log('Downloaded file path:', customer_file_path);
                            run(customer_file_path, today).then((text) => {
                                try {
                                    if (text.num_subscribers > 0) {
                                        responsetext = text.return_text
                                        const emailOptions = {
                                            from: "jdeck88@gmail.com",
                                            //to: "fullfarmcsa@deckfamilyfarm.com",
                                            to: "jdeck88@gmail.com",
                                            subject: 'FFCSA Reports: Daily New Members Report ' + today,
                                            text: responsetext
                                        };
                                        utilities.sendEmail(emailOptions)
                                    } else {
                                        responsetext = "no new members today"
                                        const emailOptions = {
                                            from: "jdeck88@gmail.com",
                                            //to: "fullfarmcsa@deckfamilyfarm.com",
                                            to: "jdeck88@gmail.com",
                                            subject: 'FFCSA Reports: Daily New Members Report ' + today,
                                            text: responsetext
                                        };
                                        utilities.sendEmail(emailOptions)
                                    }
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
new_subscribers(utilities.getToday());
