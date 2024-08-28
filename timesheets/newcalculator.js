    const fs = require('fs');
    const path = require('path');
    const XLSX = require('xlsx');

    // Define the base directory and the path to the employee rates file
    const year = "2024";
    const baseDir = `/Users/jdeck/Dropbox/Deck Family Farm DFF/Finances/Payroll/Time Sheets/${year}/`;
    const employeeRatesFile = 'employee_rates.txt';  // Replace with your actual path
    const laborCostFile = 'laborcost.csv';  // Replace with your actual path

    // Load employee rates into a dictionary
    const employeeRates = loadEmployeeRates(employeeRatesFile);

    // Load labor costs into a dictionary
    const laborCosts = loadLaborCosts(laborCostFile);

    // Initialize dictionaries to store the total payment by class by month
    const totalPaymentByClassByMonth = {};

    // Process each monthly timesheet file
    processTimesheets(baseDir, year, totalPaymentByClassByMonth, employeeRates);

    // Generate Excel sheets
    generateExcelSheets(totalPaymentByClassByMonth, laborCosts, year);

    console.log('Processing complete. Results saved to class_output.xlsx.');

    function exportToExcel(data) {
        // Collect all unique classes (columns) across all months
        const classes = new Set();
        Object.values(data).forEach(monthData => {
          monthData.forEach(([category]) => {
            classes.add(category);
          });
        });
      
        const classArray = Array.from(classes);
      
        // Convert data to the format required for the sheet
        const sheetData = [];
        const months = Object.keys(data);
      
        months.forEach(month => {
          const monthData = data[month];
          const row = { Month: month };
      
          classArray.forEach(cls => {
            const entry = monthData.find(([category]) => category === cls);
            row[cls] = entry ? entry[1] : 0;
          });
      
          sheetData.push(row);
        });
      
        return sheetData;
      }

    function loadEmployeeRates(filePath) {
        const rates = {};
        fs.readFileSync(filePath, 'utf8').split('\n').forEach(line => {
            const [employee, rate] = line.split('|');
            if (employee && rate) {
                rates[employee] = parseFloat(rate);
            }
        });
        return rates;
    }

    function loadLaborCosts(filePath) {
        const costs = {};
        const data = fs.readFileSync(filePath, 'utf8').split('\n');

        // Read header to get the company names
        const [header, ...lines] = data;
        const companies = header.split(',').slice(1);  // ['All', 'DFF', 'CC', 'FFCSA']

        lines.forEach(line => {
            const [month, ...costsArray] = line.split(',');
            if (month && costsArray.length === companies.length) {
                costs[month] = {};
                companies.forEach((company, index) => {
                    costs[month][company] = parseFloat(costsArray[index]);
                });
            }
        });

        return costs;
    }

    function processTimesheets(baseDir, year, totalPaymentByClassByMonth, employeeRates) {
        fs.readdirSync(baseDir).filter(file => file.startsWith(`${year}-`) && file.endsWith('.xlsm')).forEach(file => {
            const filePath = path.join(baseDir, file);
            console.log(`Reading file ${filePath}`);

            // Read the Excel file
            const workbook = XLSX.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            let data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            // Process data
            data = data.slice(7); // Drop the first 7 rows
            const headers = data.shift();
            const df = data.map(row => {
                let obj = {};
                headers.forEach((header, index) => obj[header] = row[index]);
                return obj;
            });

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
            });
        });
    }

    function handleValue(value) {
        try {
            const num = Number(value);
            return num * 24; // Convert fraction of a day to hours
        } catch (error) {
            console.log(`Skipping invalid time value '${value}'`);
            return NaN;
        }
    }

    function generateExcelSheets(totalPaymentByClassByMonth, laborCosts, year) {
        const DFFclassData = [];
        const CCclassData = [];
        const FFCSAclassData = [];
        //const ALLclassData = [];
        let currentMonthData = {};


        Object.entries(totalPaymentByClassByMonth).forEach(([month, classes]) => {

            const laborCost = laborCosts[month]['ALL'] || 1;  // Avoid division by zero
            if (laborCost === 1) {
                console.error(`Error: Labor cost for ${month} is not available or is set to 1. Exiting loop.`);
                return; // Exit the current iteration of the loop
            }
            DFFclassData.push([`JournalNo: DFFLaborGJE-${year}-${month}`]);
            DFFclassData.push(['Account', 'Debit', 'Credit', 'Description', 'Class']);

            CCclassData.push([`JournalNo: CCLaborGJE-${year}-${month}`]);
            CCclassData.push(['Account', 'Debit', 'Credit', 'Description', 'Class']);

            FFCSAclassData.push([`JournalNo: FFCSALaborGJE-${year}-${month}`]);
            FFCSAclassData.push(['Account', 'Debit', 'Credit', 'Description', 'Class']);

            let ALLTotal = 0;
            let DFFTotal = 0;
            let CCTotal = 0;
            let FFCSATotal = 0;    

            Object.entries(classes).forEach(([className, totalPayment]) => {
                const actualPaymentAsNumber = parseFloat(totalPayment.toFixed(2));
                ALLTotal += actualPaymentAsNumber;
            });
            

// Assuming `month` is a variable holding the current month name
// Initialize a new row for the current month with the month name followed by empty placeholders for each class
currentMonthData[month] = []

Object.entries(classes).forEach(([className, totalPayment]) => {
    const actualPaymentAsNumber = parseFloat(totalPayment.toFixed(2));
    const percentOfLaborCost = parseFloat((actualPaymentAsNumber / ALLTotal).toFixed(2));
    const totalPaymentAsNumber = parseFloat((percentOfLaborCost * laborCost).toFixed(2));

    if (className.includes('FFCSA') || className.includes('Garden')) {
        FFCSAclassData.push(['Classed Labor', totalPaymentAsNumber, , , className]);
        FFCSATotal += totalPaymentAsNumber;

    } else if (className.includes('Creamy Cow Dairy')) {
        CCclassData.push(['Labor', totalPaymentAsNumber, , ]);
        CCTotal += totalPaymentAsNumber;

    } else {
        DFFclassData.push(['Classed Labor', totalPaymentAsNumber, , , className]);
        DFFTotal += totalPaymentAsNumber;
    }

        currentMonthData[month].push([className, totalPaymentAsNumber]);
    
});



    const CCPrepaid = parseFloat(laborCosts[month]['CC'].toFixed(2))
    const FFCSAPrepaid = parseFloat(laborCosts[month]['FFCSA'].toFixed(2))
    CCAdjusted = parseFloat((CCTotal - CCPrepaid).toFixed(2))
    FFCSAAdjusted = parseFloat((FFCSATotal - FFCSAPrepaid).toFixed(2))

    FFCSATotal = parseFloat(FFCSATotal.toFixed(2))
    CCTotal = parseFloat(CCTotal.toFixed(2))
    DFFTotal = parseFloat(DFFTotal.toFixed(2))


    // DFF adjustment for unclassed labor
    DFFclassData.push([`Unclassed Labor`, , DFFTotal, , ]);

    // CC / DFF Adjustments
    if (CCAdjusted > 0) {
        CCclassData.push([`Owners Equity`, , CCAdjusted, 'Debits owners equity for DFF contribution', ]);
        DFFclassData.push([`Labor: Creamy Cow Payroll Adjustment`, ,  CCAdjusted, 'CC labor credit adjustment', ]);
        DFFclassData.push([`Owners Equity`, CCAdjusted, , 'CC labor credit adjustment', ]);
    } else {
        CCAdjusted = CCAdjusted * -1
        CCclassData.push([`Owners Equity`, CCAdjusted, ,'Debits owners equity for DFF contribution', ]);
        DFFclassData.push([`Labor: Creamy Cow Payroll Adjustment`,  CCAdjusted, ,'CC labor credit adjustment', ]);
        DFFclassData.push([`Owners Equity`, , CCAdjusted,  'CC labor credit Adjustment', ]); 
    }


    FFCSAclassData.push([`Unclassed Labor`, , FFCSATotal,, ]);
    if (FFCSAAdjusted > 0) {
        FFCSAclassData.push([`Labor`, FFCSAAdjusted, ,'DFF labor credit adjustment',]);
        FFCSAclassData.push([`Owners Equity`, , FFCSAAdjusted, 'DFF labor credit adjustment',]);
        DFFclassData.push([`Labor: FFCSA Payroll Adjustment`, , FFCSAAdjusted,'FFCSA labor credit adjustment', ]);
        DFFclassData.push([`Owners Equity`, FFCSAAdjusted, ,'FFCSA labor credit adjustment',]);
    } else {
        FFCSAAdjusted = FFCSAAdjusted * -1
        FFCSAclassData.push([`Labor`, , FFCSAAdjusted, 'DFF labor credit adjustment',]);
        FFCSAclassData.push([`Owners Equity`, FFCSAAdjusted, , 'DFF labor credit adjustment',]);
        DFFclassData.push([`Labor: FFCSA Payroll Adjustment`,  FFCSAAdjusted,,'FFCSA labor credit adjustment',]);
        DFFclassData.push([`Owners Equity`,, FFCSAAdjusted,'FFCSA labor credit adjustment',]);
    }

    const memo = `Memo: This GJE accounts for all labor by class, utilizing timesheet and wage information 
alongside payments made by each entity to accurately track and classify labor costs across CC, FFCSA, and DFF. 
Reported labor costs are weighted and proportioned based on actual dollars paid. As a result, the labor costs 
presented are estimates with a precision of less than 10% per category. However, the overall comparison 
to actual dollars spent on labor is 100% accurate, incorporating education, payroll, taxes, workers' compensation, 
and specific contractor expenses.`;


    DFFclassData.push([memo]);
    CCclassData.push([memo]);
    FFCSAclassData.push([memo]);

    DFFclassData.push([])
    CCclassData.push([])
    FFCSAclassData.push([])    

    });


// After processing all classes, push the current month's data to ALLclassData
//ALLclassData.push(currentMonthData);
//console.log(JSON.stringify(currentMonthData, null, 2));
const sheetData = exportToExcel(currentMonthData);


        // Create a new workbook and convert arrays to sheets
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(DFFclassData), 'DFF');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(CCclassData), 'CC');
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(FFCSAclassData), 'FFCSA');
        const worksheet = XLSX.utils.json_to_sheet(sheetData, { header: ['Month', ...Object.keys(sheetData[0]).slice(1)] });

        //XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(exportToExcel(currentMonthData)), 'Summary');
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Summary');

        // Write the workbook to a file
        XLSX.writeFile(workbook, 'class_output.xlsx');
    }
