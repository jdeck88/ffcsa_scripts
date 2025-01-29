require('dotenv').config();
const mysql = require('mysql2/promise');
const ExcelJS = require('exceljs');
const fs = require('fs');

async function exportPricelistToExcel() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE
    });

    try {
        // Load existing template
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile('product-import-template (1).xlsx');
        const worksheet = workbook.worksheets[0];

        // Query pricelist data
        const [rows] = await connection.execute('SELECT * FROM pricelist');

        // Mapping database columns to Excel
        const columnMapping = {
            id: 'Product ID',
            localLineProductID: 'Local Line Product ID',
            packageID: 'Package ID',
            category: 'Category',
            productName: 'Product Name',
            packageName: 'Package Name',
            retailSalesPrice: 'Retail Price',
            lowest_weight: 'Min Weight',
            highest_weight: 'Max Weight',
            dff_unit_of_measure: 'Unit of Measure',
            num_of_items: 'Num of Items',
            available_on_ll: 'Available',
            description: 'Description',
            track_inventory: 'Track Inventory',
            stock_inventory: 'Stock Quantity',
            visible: 'Visible'
        };

        // Get header row
        const headerRow = worksheet.getRow(1).values.map(v => v?.toString().trim() || '');

        // Write data to Excel
        let rowIndex = 2;
        rows.forEach(row => {
            const excelRow = [];
            headerRow.forEach(header => {
                const dbColumn = Object.keys(columnMapping).find(key => columnMapping[key] === header);
                excelRow.push(dbColumn ? row[dbColumn] : '');
            });

            worksheet.addRow(excelRow);
            rowIndex++;
        });

        // Save the file
        const outputFile = 'output-pricelist.xlsx';
        await workbook.xlsx.writeFile(outputFile);
        console.log(`Excel file created: ${outputFile}`);
    } catch (error) {
        console.error('Error exporting data:', error);
    } finally {
        await connection.end();
    }
}

exportPricelistToExcel();

