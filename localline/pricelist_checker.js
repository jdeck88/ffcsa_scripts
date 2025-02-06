const fs = require('fs');
const XLSX = require('xlsx');
require('dotenv').config();
const utilities = require('./utilities');

const combinedData = {}; // Stores Deck Family Farm products across price lists
const allVendorData = []; // Stores all vendors' active price products

// Function to properly escape CSV values
function escapeCSVValue(value) {
    if (typeof value === 'string') {
        let escaped = value.replace(/"/g, '""'); // Escape double quotes
        if (escaped.includes(',') || escaped.includes('"') || escaped.includes('\n')) {
            return `"${escaped}"`; // Wrap in quotes if necessary
        }
        return escaped;
    }
    return value;
}

// Main function to run analysis
async function run_analysis() {
    await run_analyzer('herdshare', 'https://localline.ca/api/backoffice/v2/price-lists/2966/products/export/?direct=true');
    await run_analyzer('guest', 'https://localline.ca/api/backoffice/v2/price-lists/3124/products/export/?direct=true');
    await run_analyzer('members', 'https://localline.ca/api/backoffice/v2/price-lists/2718/products/export/?direct=true');

    // Generate output CSVs
    generate_all_vendors_csv();
    generate_combined_analysis();
}

// Function to process a single price list
async function run_analyzer(pricelist_name, url) {
    const data = await utilities.getAccessToken();
    const accessToken = JSON.parse(data).access;
    const input_file = `data/${pricelist_name}_pricelist.xlsx`;

    await utilities.downloadBinaryData(url, input_file, accessToken)
        .then((input_file) => {
            const workbook = XLSX.readFile(input_file);
            const productsSheetName = 'Products';
            const productsSheet = workbook.Sheets[productsSheetName];

            const productsData = XLSX.utils.sheet_to_json(productsSheet, { header: 1 });

            productsData.slice(1).forEach(row => {
                const vendor = row[3]?.replace(/["']/g, '') || '';
                const product = row[5]?.replace(/["']/g, '') || '';
                const packageName = row[16]?.replace(/["']/g, '') || '';  // Ensure package name is included
                const uniqueKey = `${product} - ${packageName}`; // Unique key for combinedData

                // Store data for all vendors (only active products)
                if (row[12] === 'Y') {
                    allVendorData.push({
                        Pricelist: pricelist_name,
                        Vendor: vendor,
                        Category: row[19]?.replace(/["']/g, '') || '',
                        Product: product,
                        'Package Name': packageName,
                        Inventory: row[11] || '',
                        'Item Unit': row[8] || '',
                        'Charge Unit': row[9] || '',
                        '# of Items': row[17] || '',
                        'Purchase Price': row[20] || '',
                        'Retail Price': row[21] || '',
                        'Margin': row[20] && row[21] ? (((row[21] - row[20]) / row[21]) * 100).toFixed(0) : '',
                        'Markup': row[20] && row[21] ? (((row[21] - row[20]) / row[20]) * 100).toFixed(0) : ''
                    });
                }

                // Store Deck Family Farm products (all, regardless of visibility)
if (vendor.toLowerCase().includes("deck family farm")) { // Match any vendor containing "Deck Family Farm"
    if (!combinedData[uniqueKey]) {
        combinedData[uniqueKey] = {
            Vendor: vendor, // Store the exact vendor name for clarity
            Product: product,
            'Package Name': packageName,
            Category: row[19]?.replace(/["']/g, '') || '',
            Inventory: row[11] || '',
            'Item Unit': row[8] || '',
            'Charge Unit': row[9] || '',
            '# of Items': row[17] || '',
            'Purchase Price': row[20] || ''
        };
    }

    // Add price list retail price and margin as separate columns
    combinedData[uniqueKey][`${pricelist_name} Retail Price`] = row[21] || '';
    combinedData[uniqueKey][`${pricelist_name} Margin`] = row[20] && row[21] ? (((row[21] - row[20]) / row[21]) * 100).toFixed(0) : '';
}


            });
        })
        .catch(error => {
            console.log('Error fetching file from server: ' + error);
        });
}

// Function to generate the CSV for all vendors with active prices
function generate_all_vendors_csv() {
    const output_file = 'data/all_vendors_active_prices.csv';

    const headers = Object.keys(allVendorData[0]);
    const rows = allVendorData.map(obj => headers.map(header => escapeCSVValue(obj[header])).join(','));

    const csvContent = [headers.join(','), ...rows].join('\n');
    fs.writeFileSync(output_file, csvContent);

    console.log(`${output_file} written successfully`);
}

// Function to generate the Deck Family Farm analysis CSV
function generate_combined_analysis() {
    const output_file = 'data/deck_family_farm_analysis.csv';

    const headers = [
        "Vendor", "Category", "Product", "Package Name", "Inventory", "Item Unit", "Charge Unit", "# of Items", "Purchase Price",
        "herdshare Retail Price", "herdshare Margin",
        "members Retail Price", "members Margin",
        "guest Retail Price", "guest Margin",
    ];

    // Convert combinedData object to an array and sort by Vendor, Category, Product
    const sortedData = Object.values(combinedData).sort((a, b) => {
        return a.Vendor.localeCompare(b.Vendor) || 
               a.Category.localeCompare(b.Category) || 
               a.Product.localeCompare(b.Product);
    });

    const rows = sortedData.map(product =>
        headers.map(header => escapeCSVValue(product[header] || '')).join(',')
    );

    const csvContent = [headers.join(','), ...rows].join('\n');
    fs.writeFileSync(output_file, csvContent);

    console.log(`${output_file} written successfully`);
}

// Run the analysis
run_analysis();

