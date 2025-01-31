$(document).ready(function () {
    // ✅ Example Data: Weekly KPI Values (Dates as Keys, KPIs as Values)
    const rawData = [
        { date: "2024-01-01 - 2024-01-07", totalSales: 10000, orders: 120, subscriberOrders: 80, guestOrders: 40, avgItems: 3.5, avgOrderAmount: 85, activeSubscribers: 300, projectedRevenue: 15000 },
        { date: "2024-01-08 - 2024-01-14", totalSales: 10500, orders: 130, subscriberOrders: 85, guestOrders: 45, avgItems: 3.8, avgOrderAmount: 88, activeSubscribers: 320, projectedRevenue: 16000 },
        { date: "2024-01-15 - 2024-01-21", totalSales: 9500, orders: 110, subscriberOrders: 75, guestOrders: 35, avgItems: 3.6, avgOrderAmount: 83, activeSubscribers: 290, projectedRevenue: 14500 }
    ];

    // ✅ Extract Unique Date Headers
    const dates = rawData.map(entry => entry.date);

    // ✅ KPI Labels (Fixed First Column)
    const kpiLabels = [
        "Total Sales",
        "Number of Orders",
        "Number of Subscriber Orders",
        "Number of Guest Orders",
        "Average Items per Order",
        "Average Order Amount",
        "Total Active Subscribers",
        "Projected Monthly Subscription Revenue"
    ];

    // ✅ Extract Transposed Data
    const transposedData = kpiLabels.map(label => {
        return {
            label: label,
            values: rawData.map(entry => entry[label.toLowerCase().replace(/\s+/g, '')]) // Convert labels to keys
        };
    });

    // ✅ Populate Table Headers (Date Columns)
    const headerRow = document.getElementById("headerRow");
    dates.forEach(date => {
        const th = document.createElement("th");
        th.textContent = date;
        headerRow.appendChild(th);
    });

    // ✅ Populate Table Body
    const tableBody = document.getElementById("tableBody");
    transposedData.forEach(row => {
        const tr = document.createElement("tr");

        // ✅ Add KPI Label (Fixed First Column)
        const tdLabel = document.createElement("td");
        tdLabel.textContent = row.label;
        tr.appendChild(tdLabel);

        // ✅ Add Data for Each Date
        row.values.forEach(value => {
            const td = document.createElement("td");
            td.textContent = value;
            tr.appendChild(td);
        });

        tableBody.appendChild(tr);
    });

    // ✅ Initialize DataTables with Fixed Columns
    $('#weeklyKpiTable').DataTable({
        scrollX: true,
        scrollCollapse: true,
        paging: false, // ✅ Disable Pagination (All KPIs Visible)
        fixedColumns: {
            leftColumns: 1 // ✅ Freezes the first column (KPI Names)
        }
    });
});

