const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Define the base directory and the path to the employee rates file
const baseDir = '/Users/jdeck/Dropbox/Deck Family Farm DFF/Finances/Payroll/Time Sheets/2024/';
const employeeRatesFile = 'employee_rates.txt';  // Replace with your actual path

// Load employee rates into a dictionary
const employeeRates = {};
fs.readFileSync(employeeRatesFile, 'utf8').split('\n').forEach(line => {
    const [employee, rate] = line.split('|');
    if (employee && rate) {
        employeeRates[employee] = parseFloat(rate);
    }
});

// Initialize dictionaries to store the total payment by employee and by class by month
const totalPaymentByEmployee = {};
const totalPaymentByClassByMonth = {};

// Function to convert [h]:mm formatted time or fraction of a day to decimal hours
function handleValue(value) {
    try {
        const num = Number(value);
        return num * 24; // Convert fraction of a day to hours
    } catch (error) {
        console.log(`Skipping invalid time value '${value}'`);
        return NaN;
    }
}

// Process each monthly timesheet file
fs.readdirSync(baseDir).filter(file => file.startsWith('2024-') && file.endsWith('.xlsm')).forEach(file => {
    const filePath = path.join(baseDir, file);
    console.log(`Reading file ${filePath}`);

    // Read the Excel file
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    let data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Drop the first 7 rows and reset the header to row 8
    data = data.slice(7);
    const headers = data.shift();
    const df = data.map(row => {
        let obj = {};
        headers.forEach((header, index) => obj[header] = row[index]);
        return obj;
    });

    // Ensure 'Employee' column is correctly labeled
    if (!df[0].hasOwnProperty('Employee')) {
        throw new Error("'Employee' column not found. Check the header row or column names.");
    }

    // Process the month part of the filename for output
    const month = path.basename(filePath, '.xlsm').split('-')[1];

    // Initialize dictionary for the current month's class totals
    if (!totalPaymentByClassByMonth[month]) {
        totalPaymentByClassByMonth[month] = {};
    }

    // Iterate over each row (each employee)
    df.forEach(row => {
        const employeeName = row['Employee'];

        // Skip rows where employeeName is undefined
        if (!employeeName) return;

        if (!(employeeName in employeeRates)) {
            console.warn(`Warning: Rate for employee '${employeeName}' not found.`);
            return;
        }

        const hourlyRate = employeeRates[employeeName];
        let totalHours = 0;

        // Limit the number of columns to iterate over to 15
        const columnsToProcess = Object.values(row).slice(1, 16);

        // Iterate over each class column, converting and summing time values
        columnsToProcess.forEach((value, index) => {
            if (index >= 15) return;  // Stop processing if we exceed 15 columns

            const decimalHours = handleValue(value);
            if (!isNaN(decimalHours)) {
                totalHours += decimalHours;
            }
        });

        totalHours = Math.round(totalHours * 100) / 100;

        const payment = totalHours * hourlyRate;

        // Add the payment to the total payment for that employee
        if (employeeName in totalPaymentByEmployee) {
            totalPaymentByEmployee[employeeName] += payment;
        } else {
            totalPaymentByEmployee[employeeName] = payment;
        }

        // Update the total payment by class for the current month
        Object.keys(row).slice(1, 16).forEach((className, index) => {
            const classValue = row[className];
            const decimalHours = handleValue(classValue);
            if (!isNaN(decimalHours)) {
                if (!totalPaymentByClassByMonth[month][className]) {
                    totalPaymentByClassByMonth[month][className] = 0;
                }
                totalPaymentByClassByMonth[month][className] += decimalHours * hourlyRate;
            }
        });

        console.log(`Total hours for employee '${employeeName}': ${totalHours}`);
    });
});

// Convert the results to CSV format
const employeeResults = Object.entries(totalPaymentByEmployee).map(([employee, totalPayment]) => `${employee},${totalPayment}`).join('\n');
fs.writeFileSync('employee_output.csv', 'Employee,Total Payment\n' + employeeResults);

// Convert the results by class by month to CSV format
let classResults = 'Month,Class,Total Payment\n';
Object.entries(totalPaymentByClassByMonth).forEach(([month, classes]) => {
    Object.entries(classes).forEach(([className, totalPayment]) => {
        classResults += `${month},${className},${totalPayment}\n`;
    });
});
fs.writeFileSync('class_output.csv', classResults);

console.log('Processing complete. Results saved to employee_output.csv and class_output.csv.');

