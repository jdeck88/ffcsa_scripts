// Using the following get  the "access" property
var request = require('request');
const fs = require('fs');
const path = require('path');
const fastcsv = require('fast-csv');
const PDFDocument = require('pdfkit-table');
const axios = require('axios');
const utilities = require('./utilities');

require('dotenv').config();

function readExistingEntries(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const uniqueIds = new Set(); // Use a Set to store unique IDs
    const entries = fileContent.split('\n').map(line => {
      const [id, amount, email, subscription_date] = line.split(',').map(item => item.trim()); // Assuming CSV format
      if (id) {
        uniqueIds.add(id);
      }
    });

    // Convert Set to an array and return
    return [...uniqueIds];
  } catch (error) {
    // If the file doesn't exist or an error occurs, return an empty array
    return [];
  }
}

// Function to write a new entry to the CSV file
function writeEntryToCSV(filePath, newEntry) {
  try {
    const entryString = `${newEntry.order},${newEntry.amount},${newEntry.email},${newEntry.subscription_date}\n`;
    fs.appendFileSync(filePath, entryString, 'utf-8');
  } catch (error) {
    console.error('Error writing entry to file:', error);
  }
}

async function run(filename, customerData, orderDayFormatted, lastWeekFormatted, accessToken) {
  return new Promise((resolve, reject) => {
    const pdf_file = 'data/subscriptions_' + orderDayFormatted + '.pdf';
    const order_data_success_file = 'data/order_data_' + process.env.ENVIRONMENT + '_success.csv'
    const order_data_fail_file = 'data/order_data_' + process.env.ENVIRONMENT + '_fail.csv'

    const doc = new PDFDocument();

    doc.on('finish', () => {
      console.log('PDF created successfully.');
    });

    doc.on('error', (error) => {
      console.error('PDF creation error:', error);
      reject(error);
    });

    doc.pipe(fs.createWriteStream(pdf_file));
    const subscribers = [];
    const subscribers_issues = [];

    fs.createReadStream(filename)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', (row) => {
        const productSubtotal = parseFloat(row['Product Subtotal']);

        // payment__status=PAID&payment__status=AUTHORIZED&' +
        if ([200.00, 300.00, 500.00, 86.00, 100.00, 150.00, 250.00].includes(productSubtotal)) {
          if (row['Payment Status'] === "PAID" || row['Payment Status'] === "AUTHORIZED") {
            let statusString = row['Payment Status']
            successString = 'SUCCESS';
            if (row['Payment Method'] == 'SNAP') {
              successString = 'PENDING';
              statusString = 'SNAP';
            }
            subscribers.push({
              Success: successString,
              Status: statusString,
              Date: row['Date'],
              Customer: row['Customer'],
              email: row['Email'],
              'Product': row['Product'],
              'Product Subtotal': row['Product Subtotal'],
              'Order': row['Order']
            });
          } else {
            let statusString = row['Payment Status']
            successString = 'FAIL';
            if (row['Payment Method'] == 'SNAP') {
              statusString = 'SNAP';
              successString = 'PENDING';
            }
            subscribers_issues.push({
              Success: successString,
              Status: statusString,
              Date: row['Date'],
              Customer: row['Customer'],
              email: row['Email'],
              'Product': row['Product'],
              'Product Subtotal': row['Product Subtotal'],
              'Order': row['Order']
            });
          }
        }
      })
      .on('end', () => {
        subscribers.sort((a, b) => a['Product'].localeCompare(b['Product']));
        subscribers_issues.sort((a, b) => a['Product'].localeCompare(b['Product']));

        // Combine the two arrays based on the "email" field and add "id" to the subscribers array
        //console.log(customerData)
        const combinedData = subscribers.map(subscriber => {
          const customer = customerData.find(cust => cust.email === subscriber.email);
          return {
            success: subscriber.Success,
            status: subscriber.Status,
            id: customer ? customer.id : '',
            customer: subscriber.Customer,
            email: subscriber.email,
            subscription_date: subscriber.Date,
            level: subscriber['Product'],
            amount: subscriber['Product Subtotal'],
            order: subscriber['Order']
          };
        });

        // Combine the two arrays based on the "email" field and add "id" to the subscribers array
        const combinedDataIssues = subscribers_issues.map(subscriber => {
          const customer = customerData.find(cust => cust.email === subscriber.email);
          return {
            success: subscriber.Success,
            status: subscriber.Status,
            id: customer ? customer.id : '',
            customer: subscriber.Customer,
            email: subscriber.email,
            subscription_date: subscriber.Date,
            level: subscriber['Product'],
            amount: subscriber['Product Subtotal'],
            order: subscriber['Order']
          };
        });


        // TODO: In this loop pull out id and call IP to increment by set amount
        num_subscriptions = 0;
        const orderDataSuccessFile = readExistingEntries(order_data_success_file);
        const orderDataFailFile = readExistingEntries(order_data_fail_file);

        for (const entry of combinedData) {
          // Track transactions by Order Number in PRODUCTION environment
          if (process.env.ENVIRONMENT === 'PRODUCTION') {
            if (orderDataSuccessFile.includes(entry.order.toString())) {
              entry.success = 'ENTERED';
              console.log(`${entry.order} EXISTS, DO NOTHING (PRODUCTION ENVIRONMENT)`)
            } else {
              // storeCredit Function -- this is the part that Credits a customer
              amount = entry.amount
              // account for Feed-a-Friend -- doubles the contribution
              //if (entry.amount == 86.00) {
              if (entry.amount == 86.00 || entry.amount == 100.00 || entry.amount == 150.00 || entry.amount == 250.00) {
                amount = entry.amount * 2
              }
              amount = amount.toString()
              entry.amount = amount

              console.log(`${entry.order} CREDIT ACCOUNT! (PRODUCTION ENVIRONMENT)`)
              storeCredit( entry.id, amount, accessToken);
              writeEntryToCSV(order_data_success_file, entry);
              num_subscriptions = num_subscriptions + 1
            }
          } else {
            if (orderDataSuccessFile.includes(entry.order.toString())) {
              amount = entry.amount
              if (entry.amount == 86.00 || entry.amount == 100.00 || entry.amount == 150.00 || entry.amount == 250.00) {
                //if (entry.amount == 86.00) {
                amount = entry.amount * 2
              }
              amount = amount.toString()
              entry.amount = amount
              entry.success = 'ENTERED';
              console.log(`${entry.order} EXISTS, DO NOTHING (DEVELOPMENT ENVIRONMENT) = `+ amount)                         
            } else {
              amount = entry.amount
              if (entry.amount == 86.00 || entry.amount == 100.00 || entry.amount == 150.00 || entry.amount == 250.00) {
                //if (entry.amount == 86.00) {
                amount = entry.amount * 2
              }
              amount = amount.toString()
              entry.amount = amount
              console.log(`${entry.order} DOES NOT EXIST -- (DEVELOPMENT ENVIRONMENT) amount to credit = ` + amount)
              writeEntryToCSV(order_data_success_file, entry);
              num_subscriptions = num_subscriptions + 1
            }
          }
        }
        for (const entry of combinedDataIssues) {                
          if (orderDataFailFile.includes(entry.order.toString())) {
            //if (orderDataFailFile.some(existingEntry => existingEntry.id === entry.id)) {
            console.log(`${entry.order} EXISTS FAIL FILE, DO NOTHING`)
          } else {
            console.log(`${entry.order} DOES NOT EXIST FAIL FILE, ADD...`)
            writeEntryToCSV(order_data_fail_file, entry);
          }
          num_subscriptions = num_subscriptions + 1
        }
        console.log(num_subscriptions + " subscriptions made, including ones with issues")


        let allCombinedData = combinedData.concat(combinedDataIssues);

        allCombinedData = allCombinedData.filter(entry => entry.success !== "ENTERED");

        // Filter the data for the first table (excluding SNAP)
        const nonSnapData = allCombinedData.filter(item => item.status !== 'SNAP');

        // Define the first table
        const nonSnapTable = {
          title: 'Subscriptions',
          headers: ['Credit Balance', 'Status', 'CustomerID', 'OrderID', 'Customer', 'Email', 'Subscription Date', 'Level', 'Total'],
          rows: nonSnapData.map(item => [item.success, item.status, item.id, item.order, item.customer, item.email, item.subscription_date, item.level, item.amount]),
        };

        // Filter the data for the second table (only SNAP)
        const snapData = allCombinedData.filter(item => item.status === 'SNAP');

        // Define the second table
        const snapTable = {
          title: 'SNAP Subscriptions',
          headers: ['Credit Balance', 'Status', 'CustomerID', 'OrderID', 'Customer', 'Email', 'Subscription Date', 'Level', 'Total'],
          rows: snapData.map(item => [item.success, item.status, item.id, item.order, item.customer, item.email, item.subscription_date, item.level, item.amount]),
        };


        try {
          doc.font('Times-Bold');
          doc.fontSize(14);  
          doc.text('Subscription Results from ' + lastWeekFormatted + " to " + orderDayFormatted, {
            align: 'center',  
          });

          doc.moveDown(1);

          doc.fontSize(12);  
          doc.font('Times-Roman');

          doc.table(nonSnapTable);

          doc.moveDown(2);

          doc.table(snapTable);

        } catch (error) {
          console.error('Error creating table:', error);
          throw new Error(error);
        }

        doc.end();

        const results = {
          count: num_subscriptions,
          pdf_file: pdf_file
        };

        // TODO: figure out appropriate aync methods to enable finishing PDF creation
        setTimeout(() => {
          console.log("Success!")
          resolve(results);
        }, 1000);


      })
      .on('error', (error) => {
        reject(error);
      });
  });
}


async function populateCustomers(accessToken) {
  // NOTE, i reported a bug in paging responses where certain results returned duplicate customers
  // for now i set page_size to 1000 to work around
  apiUrl = 'https://localline.ca/api/backoffice/v2/customers/?page=1&page_size=1000'; // Initial API URL

  let allCustomers = []; // Array to store customer data

  while (apiUrl) {
    try {
      const headers = {
        'Authorization': `Bearer ${accessToken}`
      };

      const response = await axios.get(apiUrl, {
        headers: headers
      });

      const { results, next } = response.data;

      // Extract and push "id" and "email" of each customer to the array
      results.forEach(customer => {
        allCustomers.push({ id: customer.id, email: customer.email });
      });

      // Check if there is a next page
      apiUrl = next ? next : null;
    } catch (error) {
      console.error('Error fetching data:', error);
      throw new Error(error)
    }
  }

  // Now, allCustomers array contains the "id" and "email" of all customers
  return allCustomers; // Return the array when done

}

async function subscriptions(yesterday,lastweek) {
  try {
    console.log("running subscriptions updater")

    url = 'https://localline.ca/api/backoffice/v2/orders/export/?' +
      'file_type=orders_list_view&' +
      'send_to_email=false&destination_email=fullfarmcsa%40deckfamilyfarm.com&direct=true&' +
      `start_date=${lastweek}&` +
      `end_date=${yesterday}&` +
      //'payment__status=PAID&payment__status=AUTHORIZED&' +
      'vendors=3148&price_lists=2719,2895&status=OPEN'

    data = {}

    // Login
    data = await utilities.getAccessToken();
    const accessToken = JSON.parse(data).access;


    // Call the function and wait for the response
    (async () => {
      try {
        console.log("fetching customers ...")
        const customerData = await populateCustomers(accessToken);
        // console.log('Customer data:', customerData);

        // TODO: validate customerData makes sense
        data = await utilities.getRequestID(url, accessToken);
        const id = JSON.parse(data).id;

        // Wait for report to finish
        const subscription_result_url = await utilities.pollStatus(id, accessToken);

        // Download File
        if (subscription_result_url !== "") {
          utilities.downloadData(subscription_result_url, 'subscriptions_' + yesterday + ".csv", accessToken)
            .then((subscription_file_path) => {
              console.log('Downloaded file path:', subscription_file_path);
              run(subscription_file_path, customerData, yesterday, lastweek, accessToken)
                .then((results) => {
                  try {

                    bodytext = "Please see the attached file.  Subscribers report is run daily."
                    if (parseInt(results.count) < 1) {
                      bodytext = "No new subscribers this day. No file to attach"
                    }

                    // Email information
                    const emailOptions = {
                      from: "jdeck88@gmail.com",
                      to: "jdeck88@gmail.com",
                      cc: "fullfarmcsa@deckfamilyfarm.com",
                      subject: 'Subscriptions made on ... ' + lastweek + ' to ' + yesterday,
                      text: bodytext,
                    };

                    if (results.count > 0) {
                      emailOptions.attachments = [
                        {
                          filename: 'subscriptions_' + yesterday + '.pdf',
                          content: fs.readFileSync(results.pdf_file),
                        },
                      ];
                    }
                    //utilities.sendSubscribersEmail(results, 'subscriptions_' + yesterday + '.pdf', 'Subscriptions made on ... ' + yesterday)
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

let isProcessing = false;

async function storeCredit(customerID, amount, accessToken) {
  // If already processing, wait for the completion before proceeding
  while (isProcessing) {
    await new Promise(resolve => setTimeout(resolve, 100)); // Add a delay to avoid busy-waiting
  }

  try {
    isProcessing = true;

    customerID = Number(customerID);
    amount = Number(amount);

    // Validate customerID and amount
    if (typeof customerID !== 'number' || isNaN(customerID) || customerID <= 0) {
      throw new Error('Invalid customerID. It must be a positive number.');
    }

    if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
      throw new Error('Invalid amount. It must be a positive number.');
    }

    // Convert customerID and amount to proper formats
    customerID = String(customerID); // Convert to string
    amount = parseFloat(amount.toFixed(2)); // Convert to float with 2 decimal places

    var options = {
      'method': 'POST',
      'url': `https://localline.ca/api/backoffice/v2/customers/${customerID}/store-credit-transaction/`,
      'headers': {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        "amount": amount
      })
    };

    await new Promise((resolve, reject) => {
      request(options, function (error, response) {
        if (error) {
          reject(error);
        } else {
          console.log(response.body);
          resolve();
        }
      });
    });
  } catch (error) {
    // Handle errors as needed
    console.error('Error in storeCredit:', error);
  } finally {
    isProcessing = false;
  }
}

// Run the delivery_order script
//orderDayFormatted = '2023-10-31'

//subscriptions('2024-03-01','2024-02-26');
//subscriptions('2024-09-25','2024-09-24');
subscriptions(utilities.getOrderDay(),utilities.getOrderDayMinusTwentyOne());
