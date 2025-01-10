const fs = require('fs');
const XLSX = require('xlsx');
const _ = require('lodash');
var request = require('request');
const axios = require('axios');
require('dotenv').config();
const utilities = require('./utilities');

// Create a new workbook
result =  run_analyzer('herdshare', 'https://localline.ca/api/backoffice/v2/price-lists/2966/products/export/?direct=true')
result =  run_analyzer('guest', 'https://localline.ca/api/backoffice/v2/price-lists/3124/products/export/?direct=true')
result =  run_analyzer('members', 'https://localline.ca/api/backoffice/v2/price-lists/2718/products/export/?direct=true')

async function run_analyzer(pricelist_name, url) {

	data = await utilities.getAccessToken();
	const accessToken = JSON.parse(data).access;

	const input_file = 'data/' + pricelist_name + '_pricelist.xlsx'

	utilities.downloadBinaryData(url, input_file, accessToken)
		.then((input_file) => {
			// Load the Excel workbook
			const workbook = XLSX.readFile(input_file);

			// Specify sheet names
			const productsSheetName = 'Products';

			// Get sheet data
			const productsSheet = workbook.Sheets[productsSheetName];

			// Convert sheets to arrays
			const productsData = XLSX.utils.sheet_to_json(productsSheet , { header: 1 });

			const result = Object.values(productsData)
			//.filter(row => row[12] === 'Y') // Filter based on 'Visible' column
				.filter(row => row[12] === 'Y')
				.map(row => ({
					Priceslist: pricelist_name, // Vendor
					Vendor: row[3].replace(/["']/g, ''), // Vendor
					Product: row[5].replace(/["']/g, ''), // Product
					Inventory: row[11], // Visible
					Visible: row[12], // Visible
					'Item Unit': row[8], // Item Unit
					'Charge Unit': row[9], // Charge Unit
					'Package Name': row[16].replace(/["']/g, ''), // Package Name
					'# of Items': row[17], // # of Items
					'Purchase Price': row[20], // Package Price
					'Retail Price': row[21], // Price List Adjusted Price
					'Margin': (((row[21] - row[20]) / row[21]) * 100).toFixed(0), // Margin calculation
					'Markup': (((row[21] - row[20]) / row[20]) * 100).toFixed(0) // Margin calculation
				}))
				.sort((a, b) => parseFloat(a.Margin) - parseFloat(b.Margin));

			// CSV header
			const header = Object.keys(result[0]).join(',') + '\n';

			// CSV data
			const csvData = result.map(obj => Object.values(obj).map(value => {
				// If value is a string containing comma, wrap it in double quotes
				if (typeof value === 'string' && value.includes(',')) {
					return `"${value}"`;
				}
				return value;
			}).join(',')).join('\n');



			output_file = 'data/' + pricelist_name +'_pricelist_analytics.csv'

			// Write CSV data to file
			fs.writeFileSync(output_file, header + csvData);

			console.log(output_file+ ' written successfully');

		})
		.catch((error) => {
			console.log('error fetching file from server' + error);
		})
}
