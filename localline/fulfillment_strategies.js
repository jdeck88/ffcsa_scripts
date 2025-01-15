const request = require('request');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const utilities = require('./utilities');

async function run() {
    try {
        // Initialize data variable
        let data = {};

        // Login and get access token
        data = await utilities.getAccessToken();
        const accessToken = JSON.parse(data).access;

        // Download and process order data
        let url = 'https://localline.ca/api/backoffice/v2/fulfillment-strategies/';
        let response = await utilities.getRequestID(url, accessToken);
        let results = JSON.parse(response).results;

        // Filter and format the data
        let formattedData = results
            .filter(location => location.active === true && location.address && location.address.latitude !== null)
            .map(location => {
                const { name, address, availability } = location;

                // Format the delivery days
                const deliveryDays = [];
                if (availability.repeat_on_monday) deliveryDays.push("Monday");
                if (availability.repeat_on_tuesday) deliveryDays.push("Tuesday");
                if (availability.repeat_on_wednesday) deliveryDays.push("Wednesday");
                if (availability.repeat_on_thursday) deliveryDays.push("Thursday");
                if (availability.repeat_on_friday) deliveryDays.push("Friday");
                if (availability.repeat_on_saturday) deliveryDays.push("Saturday");
                if (availability.repeat_on_sunday) deliveryDays.push("Sunday");

                return {
                    name,
                    days: deliveryDays,
                    address: address.formatted_address || "Address not available",
                    time: availability.time_slots.length > 0 ? availability.time_slots.map(slot => `${slot.start} - ${slot.end}`).join(", ") : "No time slots",
                    latitude: address.latitude,
                    longitude: address.longitude
                };
            });

        if (formattedData.length === 0) {
            console.log("No valid records to write.");
            return;
        }

        // Exclude entries containing "Membership Purchase" or "Herdshare Purchase"
        const filteredData = formattedData.filter(row => !row.name.includes("Membership Purchase") && !row.name.includes("Herdshare Purchase"));

        // Group data by delivery day
        const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
        let tableSections = daysOfWeek.map(day => {
            const dayRows = filteredData.filter(row => row.days.includes(day)).map(row => `
                <tr>
                    <td>${row.name}</td>
                    <td>${row.time}</td>
                    <td>${row.address}</td>
                </tr>
            `).join("");

            return dayRows ? `
                <h2 style="margin-top: 20px;">${day} Dropsites</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Time of Day</th>
                            <th>Address</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${dayRows}
                    </tbody>
                </table>
            ` : "";
        }).join("");

        const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Dropsite Locations (Free delivery)</title>
            <style>
                @font-face {
                    font-family: 'Tomarik Introvert';
                    src: url('data:font/woff2;base64,<BASE64-FONT-DATA>') format('woff2');
                }
                body {
                    font-family: 'Tomarik Introvert', sans-serif;
                    margin: 20px;
                    padding: 0;
                    background-color: #f7f7f7;
                }
                h1, h2 {
                    text-align: center;
                    color: #333;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 20px 0;
                }
                th, td {
                    border: 1px solid #ddd;
                    padding: 12px;
                    text-align: center;
                }
                th {
                    background-color: #f2f2f2;
                    color: #333;
                    font-weight: bold;
                }
                tr:nth-child(even) {
                    background-color: #fafafa;
                }
                tr:hover {
                    background-color: #f1f1f1;
                }
            </style>
        </head>
        <body>
            <h1>Home Delivery</h1>
            <p>There is a $20 fee for home delivery with free delivery for orders over $125. See map (above) for delivery area. Eugene/Springfield/ and Junction City delieries happen on Tuesdays and Corvallis deliveries happen on Saturdays.</p>
            <h1>Drop Sites (Free)</h1>
            <p>Drop site locations and days are listed below.  All dropsite deliveries are free. You can choose your preferred dropsite locationwhen placing your order.
            ${tableSections}
        </body>
        </html>`;

        // Write the HTML file
        const outputPathHTML = '../docs/delivery_data.html';
        fs.writeFileSync(outputPathHTML, htmlContent, 'utf8');
        console.log(`HTML data written to ${outputPathHTML}`);

        // Prepare the TSV content
        const tsvHeader = "Name\tDay\tAddress\tTime\tLatitude\tLongitude\n";
        const tsvRows = filteredData.flatMap(row => row.days.map(day => {
            return `${row.name}\t${day}\t${row.address}\t${row.time}\t${row.latitude}\t${row.longitude}`;
        })).join("\n");

        const tsvContent = tsvHeader + tsvRows;

        // Write the TSV file
        const outputPathTSV = 'data/delivery_data.tsv';
        fs.writeFileSync(outputPathTSV, tsvContent, 'utf8');
        console.log(`TSV data written to ${outputPathTSV}`);

    } catch (error) {
        console.error('An error occurred:', error);

        // Send error email if enabled in utilities
        if (utilities.sendErrorEmail) {
            utilities.sendErrorEmail(error);
        }
    }
}

run();

