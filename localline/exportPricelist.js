require('dotenv').config();
const mysql = require('mysql2/promise');
const ExcelJS = require('exceljs');
const adjustRetail = 0.65

async function exportPricelistToExcel() {
    const connection = await mysql.createConnection({
        host: process.env.DFF_DB_HOST,
        user: process.env.DFF_DB_USER,
        password: process.env.DFF_DB_PASSWORD,
        database: process.env.DFF_DB_DATABASE,
        port: process.env.DFF_DB_PORT
    });

    try {
        console.log('✅ Connected to database');

        // Headers from the provided spreadsheet
        const columnHeaders = [
            "Internal ID",
            "Local Line Product ID",
            "Package ID",
            "Product",
            "Package Name",
            "Unit Price",
            "Description",
            "# of Items",
            "Track Inventory By",
            "Item Unit",
            "Charge By",
            "Charge Unit",
            "Track Inventory",
            "Inventory",
            "Sold Out Notification",
            "Visible",
        ];

        // Map database columns to spreadsheet headers
        const columnMapping = {
            localLineProductID: "Local Line Product ID",
            id: "Internal ID",
            productName: "Product",
            stock_inventory: "Inventory",
            visible: "Visible",
            description: "Description",
            packageID: "Package ID",
            packageName: "Package Name",
            num_of_items: "# of Items",
            retailSalesPrice: "Unit Price",
            track_inventory: "Track Inventory"
        };

        // Create a new workbook and worksheet
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Pricelist');

        // Add headers to the first row
        worksheet.addRow(columnHeaders);

        // Query data from the pricelist table
        const [rows] = await connection.execute('SELECT * FROM pricelist');

        // Insert data into the worksheet
        rows.forEach(row => {
			// we only work with records that are available on local line
			if (row['available_on_ll'] !== 1) { return; }
            const rowData = columnHeaders.map(header => {
                if (header === "Item Unit") { return "each"; }
                if (header === "Track Inventory By") { return "item"; }
                if (header === "Charge By") { return "item"; }
                if (header === "Charge Unit") { return "each"; }
                if (header === "Sold Out Notification") { return "True"; }
                if (header === "# of Items") { return "1"; }
				if (header === "Visible") { return row['visible'] === 1 ? "True" : "False"; }
				if (header === "Track Inventory") { return row['track_inventory'] === 1 ? "True" : "False"; }
				if (header === "Unit Price") { 
    				if (row['dff_unit_of_measure'] === 'lbs') {
						const lowestWeight = parseFloat(row['lowest_weight']) || 0;
        				const highestWeight = parseFloat(row['highest_weight']) || 0;
        				const retailPrice = parseFloat(row['retailSalesPrice']) || 0;

        				const avgWeight = (lowestWeight + highestWeight) / 2; // Calculate average weight
        				return (avgWeight * retailPrice * adjustRetail).toFixed(2);
    				} else {
        				return (row['retailSalesPrice'] * adjustRetail).toFixed(2); // Use standard logic if not 'lbs'
    				}
				}

                // Find the corresponding database column for this header
                const dbColumn = Object.keys(columnMapping).find(key => columnMapping[key] === header);
                return dbColumn ? row[dbColumn] : ''; // Fill with DB value or leave empty if no match
            });
            worksheet.addRow(rowData);
        });

        // Save the file
        const outputFile = 'output-pricelist.xlsx';
        await workbook.xlsx.writeFile(outputFile);
        console.log(`✅ Excel file created: ${outputFile}`);
    } catch (error) {
        console.error('❌ Error exporting data:', error);
    } finally {
        await connection.end();
    }
}

exportPricelistToExcel();

