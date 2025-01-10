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
            .filter(location => location.address && location.address.latitude !== null) // Exclude records with null latitude
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
                    day: deliveryDays.length > 0 ? deliveryDays.join(", ") : "None",
                    address: address.formatted_address || "Address not available",
                    time: availability.time_slots.length > 0 ? availability.time_slots.map(slot => `${slot.start} - ${slot.end}`).join(", ") : "No time slots",
                    instructions: availability.instructions 
                        ? availability.instructions.replace(/<[^>]+>/g, '').replace(/\t+/g, ' ').trim() 
                        : "No instructions",  // Removes tabs and HTML tags from instructions
                    latitude: address.latitude,
                    longitude: address.longitude,
                };
            });

        if (formattedData.length === 0) {
            console.log("No valid records to write.");
            return;
        }

        // Prepare the TSV file
        const tsvHeader = "Name\tDay\tAddress\tTime\tInstructions\tLatitude\tLongitude\n";
        const tsvRows = formattedData.map(row => {
            return `${row.name}\t${row.day}\t${row.address}\t${row.time}\t${row.instructions}\t${row.latitude}\t${row.longitude}`;
        }).join("\n");

        const tsvContent = tsvHeader + tsvRows;

        // Write the tab-delimited content to file
        const outputPath = 'data/delivery_data.tsv';
        fs.writeFileSync(outputPath, tsvContent, 'utf8');
        console.log(`Data written to ${outputPath}`);

    } catch (error) {
        console.error('An error occurred:', error);

        // Send error email if enabled in utilities
        if (utilities.sendErrorEmail) {
            utilities.sendErrorEmail(error);
        }
    }
}

run();

