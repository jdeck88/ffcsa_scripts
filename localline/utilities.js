var request = require('request');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require("nodemailer");

function getJsonFromUrl(url, accessToken) {
    return new Promise((resolve, reject) => {
        var options = {
            'method': 'GET',
            'url': url,
            'headers': {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            }
        };

        request(options, (error, response, body) => {
            if (error) {
                reject(error);
            } else {
                try {
                    const json = JSON.parse(body);
                    resolve(json);
                } catch (e) {
                    reject(e);
                }
            }
        });
    });
}

// Utilitiy functions for date formatting
function formatDate(inputDate) {
    // format date doesn't really work all that well and i'll just go with input date
    return inputDate;
  /*
    const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Parse the input date string (e.g., "28-Oct-23" or coming in with spaces "28 Oct 23")
    const parts = inputDate.split(/[-\s]+/);
    const day = parseInt(parts[0], 10);
    const monthIndex = months.indexOf(parts[1]);
    const year = 2000 + parseInt(parts[2], 10); // Assuming the year is in 2-digit format

    const date = new Date(year, monthIndex, day);

    // Get the day of the week, month, and day with ordinal suffix
    const dayOfWeek = daysOfWeek[date.getDay()];
    const month = months[date.getMonth()];
    const dayWithSuffix = day + (day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th');

    // Format the date as "Saturday, Oct 28th"
    const formattedDate = `${dayOfWeek}, ${month} ${dayWithSuffix}`;

    return formattedDate;
    */
}

// This is our login
function getAccessToken() {
    return new Promise((resolve, reject) => {

        var options = {
            'method': 'POST',
            'url': 'https://localline.ca/api/backoffice/v2/token',
            'headers': {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "username": process.env.USERNAME,
                "password": process.env.PASSWORD
            })

        };

        request(options, (error, response, body) => {
            if (error) {
                reject(error);
            } else {
                resolve(body);
            }
        });
    });
}

// obtain "id" value and save
function getRequestID(urlRequest, accessToken) {
    return new Promise((resolve, reject) => {

        // submit download request -- supply returned "access" 
        var options = {
            'method': 'GET',
            'url': `${urlRequest}`,
            'headers': {
                'Authorization': `Bearer ${accessToken}`
            }
        };

        request(options, (error, response, body) => {
            if (error) {
                reject(error);
            } else {
                resolve(body);
            }
        });
    });
}

function checkRequestId(id, accessToken) {
    return new Promise((resolve, reject) => {

        var options = {
            'method': 'GET',
            'url': `https://localline.ca/api/backoffice/v2/export/${id}/`,
            'headers': {
                'Authorization': `Bearer ${accessToken}`
            }
        };
        request(options, (error, response, body) => {
            if (error) {
                reject(error);
            } else {
                resolve(body);
            }
        });

    });
}

async function pollStatus(id, accessToken) {
    let status = null;
    let pollingStartTime = Date.now();

    const pollInterval = 5000; // 5 seconds
    const maxPollingTime = 90000; // 1.5 minutes

    while (status !== "COMPLETE") {
        const data = await checkRequestId(id, accessToken);
        status = JSON.parse(data).status;
        console.log(status);

        if (status === "COMPLETE") {
            return JSON.parse(data).file_path
            //return status; // Return the status if it's "COMPLETE"
        }

        if (Date.now() - pollingStartTime >= maxPollingTime) {
            console.error("Status not COMPLETE after 1 minute. Stopping polling.");
            throw new Error("Status not COMPLETE after 1 minute. Stopping polling.")
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return ""; // Return an empty string
}

async function downloadData(file_path, filename) {
    return new Promise((resolve, reject) => {
        const options = {
            method: 'GET',
            url: `${file_path}`,
        };

        const downloadDirectory = 'data'; // Define the subdirectory
        let filePath = '';

        request(options, (error, response, body) => {
            if (error) {
                console.error('Error downloading the file:', error);
                reject(error);
            } else {
                // Create the 'data' directory if it doesn't exist
                if (!fs.existsSync(downloadDirectory)) {
                    fs.mkdirSync(downloadDirectory);
                }

                // Extract the filename from the URL
                const urlParts = options.url.split('/');
                //const filename = urlParts[urlParts.length - 1];

                // Determine the file path for the downloaded CSV file
                filePath = path.join(downloadDirectory, filename);

                // Save the CSV content to the specified file
                fs.writeFileSync(filePath, body);
                console.log(`File saved at ${filePath}`);
                resolve(filePath);
            }
        });
    });
}

async function downloadBinaryData(url, fileName, accessToken) {
    try {
        const headers = {
            'Authorization': `Bearer ${accessToken}`
        };
        const response = await axios.get(url, { responseType: 'arraybuffer', headers });
        // Write the binary data to a file
        fs.writeFileSync(fileName, response.data);

        return fileName; // Return the path to the downloaded file
    } catch (error) {
        throw new Error(error)
    }
}
/*
async function sendSubscribersEmail(results, filename, subject) {
    console.log('function here to email the file ' + filename)
    // Create a Nodemailer transporter
    const transporter = nodemailer.createTransport({
        service: "Gmail", // e.g., "Gmail" or use your SMTP settings
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_ACCESS,
        },
    });

    bodytext = "Please see the attached file.  Subscribers report is run daily."
    if (parseInt(results.count) < 1) {
        bodytext = "No new subscribers this day. No file to attach"
    }

    // Email information
    const emailOptions = {
        from: "jdeck88@gmail.com",
        to: "jdeck88@gmail.com",
        subject: subject,
        text: bodytext,
    };

    if (results.count > 0) {
        const filePath = results.pdf_file;
        const fileBuffer = fs.readFileSync(results.pdf_file);
        emailOptions.attachments = [
            {
                filename: filename, // Change the filename as needed
                content: fileBuffer, // Attach the file buffer
            },
        ];
    }

    // Send the email with the attachment
    transporter.sendMail(emailOptions, (error, info) => {
        if (error) {
            console.error("Error sending email:", error);
        } else {
            console.log("Email sent:", info.response);
        }
    });
}*/


async function sendErrorEmail(error) {
    const callerScript = path.basename(require.main.filename);

    console.log(`[${callerScript}] Error occurred: ${error}`);

    const transporter = nodemailer.createTransport({
        service: "Gmail",
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_ACCESS,
        },
    });

    const emailOptions = {
        from: "jdeck88@gmail.com",
        to: "jdeck88@gmail.com",
        subject: `FFCSA Reports: Error in ${callerScript}`,
        text: `Script: ${callerScript}\n\nError Message:\n${error}`,
    };

    transporter.sendMail(emailOptions, (error, info) => {
        if (error) {
            console.error("Error sending email:", error);
        } else {
            console.log("Email sent:", info.response);
        }
    });
}

/*
sendEmail passes in emailOptions as argument
*/
async function sendEmail(emailOptions) {
    // Create a Nodemailer transporter
    const transporter = nodemailer.createTransport({
        service: "Gmail", // e.g., "Gmail" or use your SMTP settings
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_ACCESS,
        },
    });

    // Send the email with the attachment
    transporter.sendMail(emailOptions, (error, info) => {
        if (error) {
            console.error("Error sending email:", error);
        } else {
            console.log("Email sent:", info.response);
        }
    });
}

/*
// SENDGRID TRANSPORT
async function sendEmail(emailOptions) {
    const transporter = require('nodemailer').createTransport({
        host: 'smtp.sendgrid.net',
        port: 2525,
        secure: false, // 2525 is typically non-TLS
        auth: {
            user: 'apikey', // This literal string is required by SendGrid
            pass: process.env.SENDGRID_API_KEY, // Make sure this is set
        },
    });
	console.log(process.env.SENDGRID_API_KEY)

    // Ensure from and replyTo are set if not provided
    const mailData = {
        from: 'Full Farm CSA <fullfarmcsa@m.deckfamilyfarm.com>',
        replyTo: 'fullfarmcsa@deckfamilyfarm.com',
        ...emailOptions,
    };

    try {
        const info = await transporter.sendMail(mailData);
        console.log('Email sent:', info.response);
    } catch (error) {
        console.error('Error sending email:', error);
    }
}
*/


function getNextTuesdayOrSaturday() {
    const today = new Date();

    // Calculate the days until the next Tuesday and Saturday.
    const daysUntilNextTuesday = (2 - today.getDay() + 7) % 7;
    const daysUntilNextSaturday = (6 - today.getDay() + 7) % 7;

    // Calculate the date for the next Tuesday and Saturday.
    const nextTuesday = new Date(today);
    nextTuesday.setDate(today.getDate() + daysUntilNextTuesday);
    const nextSaturday = new Date(today);
    nextSaturday.setDate(today.getDate() + daysUntilNextSaturday);

    // Determine which is closer to the current date.
    return nextTuesday < nextSaturday ? nextTuesday : nextSaturday;
}

function getPreviousWeek(dateString) {
    const givenDate = new Date(dateString);
    const dayOfWeek = givenDate.getDay();

    // Calculate the difference in days from the given date to the previous Monday
    const daysUntilPreviousMonday = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
    
    // Calculate the date for the previous Monday
    const previousMonday = new Date(givenDate);
    previousMonday.setDate(givenDate.getDate() - daysUntilPreviousMonday);

    // Ensure the week starts on a Monday
    previousMonday.setDate(previousMonday.getDate() - 7);

    const previousPreviousSunday = new Date(previousMonday);
    previousPreviousSunday.setDate(previousMonday.getDate() -  1);

    // Calculate the date for the previous Sunday
    const previousSunday = new Date(previousMonday);
    previousSunday.setDate(previousMonday.getDate() + 6);

    return { start: formatDateToYYYYMMDD(previousMonday), end: formatDateToYYYYMMDD(previousSunday), sundaystart: formatDateToYYYYMMDD(previousPreviousSunday) };
}

function formatDate(date) {
    const months = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
    };

    // Split the string by space
    const parts = date.split(' ');

    // Extract day, month, and year
    const day = parseInt(parts[0], 10);
    const month = months[parts[1]];
    const year = parseInt(parts[2], 10);

    //const year = date.getFullYear();
    //const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    //const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function formatDateToYYYYMMDD(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}


// Get the next fullfillmentDate to query, which is either Tuesday or Friday/Saturday
function getNextFullfillmentDate() {
    const nextTuesdayOrSaturday = getNextTuesdayOrSaturday();
    const end = nextTuesdayOrSaturday;
    start = new Date(nextTuesdayOrSaturday);

    // if date is a saturday, then include Friday as start date
    if (end.getDay() === 6) {
        start.setDate(nextTuesdayOrSaturday.getDate() - 1);
        // otherwise, set this date to same as end date
    } else {
        start.setDate(nextTuesdayOrSaturday.getDate());
    }

    const formattedDate = {}
    formattedDate.start = formatDateToYYYYMMDD(start);
    formattedDate.end = formatDateToYYYYMMDD(end);
    formattedDate.date = formatDateToYYYYMMDD(end);

    return formattedDate;
}
function getLastMonth() {
    const today = new Date();
    const lastMonth = new Date(today);

    // Set the date to the first day of the current month
    lastMonth.setDate(1);

    // Subtract one day to get the last day of the previous month
    lastMonth.setDate(0);

    const year = lastMonth.getFullYear();
    const month = String(lastMonth.getMonth() + 1).padStart(2, '0');

    const firstDate = `${year}-${month}-01`;
    const lastDate = `${year}-${month}-${String(lastMonth.getDate()).padStart(2, '0')}`;

    return {
        first: firstDate,
        last: lastDate,
    };
}
// Return date range for DUFB reporting: 26th of prior month 25th of current month
function getDUFBRange() {
    const today = new Date();
    const currentDay = today.getDate();

    let start, end;

    if (currentDay < 26) {
        // Example: May 19 → Mar 26 to Apr 25
        start = new Date(today.getFullYear(), today.getMonth() - 2, 26);
        end = new Date(today.getFullYear(), today.getMonth() - 1, 25);
    } else {
        // Example: May 26 → Apr 26 to May 25
        start = new Date(today.getFullYear(), today.getMonth() - 1, 26);
        end = new Date(today.getFullYear(), today.getMonth(), 25);
    }

    const format = (date) => date.toISOString().split('T')[0];

    return {
        first: format(start),
        last: format(end),
    };
}

// * Order day is one day previous
function getOrderDay() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const year = yesterday.getFullYear();
    const month = String(yesterday.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(yesterday.getDate()).padStart(2, '0');

    const yesterdayFormatted = `${year}-${month}-${day}`;
    return yesterdayFormatted;
}
function getOrderDayMinusSeven() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 7);

    const year = yesterday.getFullYear();
    const month = String(yesterday.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(yesterday.getDate()).padStart(2, '0');

    const yesterdayFormatted = `${year}-${month}-${day}`;
    return yesterdayFormatted;
}
function getOrderDayMinusFourteen() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 14);

    const year = yesterday.getFullYear();
    const month = String(yesterday.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(yesterday.getDate()).padStart(2, '0');

    const yesterdayFormatted = `${year}-${month}-${day}`;
    return yesterdayFormatted;
}
function getOrderDayMinusTwentyOne() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 21);

    const year = yesterday.getFullYear();
    const month = String(yesterday.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(yesterday.getDate()).padStart(2, '0');

    const yesterdayFormatted = `${year}-${month}-${day}`;
    return yesterdayFormatted;
}

function getYesterday() {
    const today = new Date();
    today.setDate(today.getDate() - 1); // Subtract one day

    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(today.getDate()).padStart(2, '0');

    const yesterdayFormatted = `${year}-${month}-${day}`;
    return yesterdayFormatted;
}

function getToday() {
    const today = new Date();

    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(today.getDate()).padStart(2, '0');

    const todayFormatted = `${year}-${month}-${day}`;
    return todayFormatted;
}

function getTomorrow() {
    const tomorrow = new Date(new Date());
    const today = new Date();

    tomorrow.setDate(today.getDate() +1);

    const year = tomorrow.getFullYear();
    const month = String(tomorrow.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(tomorrow.getDate()).padStart(2, '0');

    const tomorrowFormatted = `${year}-${month}-${day}`;
    return tomorrowFormatted;
}

function mailADocument(doc, mailOptions, fileName) {
    // Create a buffer to store the PDF in-memory
    let pdfBuffer = Buffer.from([]);
    doc.on('data', chunk => {
      pdfBuffer = Buffer.concat([pdfBuffer, chunk]);
    });
  
    // Event handler for when the PDF document is finished
    doc.on('end', () => {
      // Add the PDF attachment to mailOptions
      mailOptions.attachments = [
        {
          filename: fileName,
          content: pdfBuffer,
          encoding: 'base64'
        }
      ];
  
      // Send the email with the attached PDF
      sendEmail(mailOptions);
    });
  
    // Close the PDF document
    doc.end();
  }

module.exports = {
    formatDate,
    getAccessToken,
    getRequestID,
    checkRequestId,
    pollStatus,
    downloadData,
    downloadBinaryData,
    sendEmail,
    sendErrorEmail,
    getNextFullfillmentDate,
    getPreviousWeek,
    getOrderDay,
    getOrderDayMinusSeven,
    getOrderDayMinusFourteen,
    getOrderDayMinusTwentyOne,
    getLastMonth,
    getToday,
    getTomorrow,
    getYesterday,
    mailADocument,
    getJsonFromUrl
};
