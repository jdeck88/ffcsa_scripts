$(document).ready(function () {
    // ✅ Example Data: Each object represents a week's KPI values
    const rawData = [
        { date: "2024-01-01 - 2024-01-07", totalSales: 10000, orders: 120, subscriberOrders: 80, guestOrders: 40, avgItems: 3.5, avgOrderAmount: 85, activeSubscribers: 300, projectedRevenue: 15000 },
        { date: "2024-01-08 - 2024-01-14", totalSales: 10500, orders: 130, subscriberOrders: 85, guestOrders: 45, avgItems: 3.8, avgOrderAmount: 88, activeSubscribers: 320, projectedRevenue: 16000 },
        { date: "2024-01-15 - 2024-01-21", totalSales: 9500, orders: 110, subscriberOrders: 75, guestOrders: 35, avgItems: 3.6, avgOrderAmount: 83, activeSubscribers: 290, projectedRevenue: 14500 }
    ];

    // ✅ Extract Unique Dates (Headers)
    const dates = rawData.map(entry => entry.date);

    // ✅ Extract KPI Labels from First Object Keys (Skipping `date`)
    const kpiLabels = Object.keys(rawData[0]).filter(key => key !== "date");

    // ✅ Insert Date Headers into the Table
    const headerRow = document.getElementById("headerRow");
    dates.forEach(date => {
        const th = document.createElement("th");
        th.textContent = date;
        headerRow.appendChild(th);
    });

    // ✅ Populate Transposed Table Data
    const tableBody = document.getElementById("tableBody");

    kpiLabels.forEach(kpi => {
        const tr = document.createElement("tr");

        // ✅ Add KPI Label (Frozen First Column)
        const tdLabel = document.createElement("td");
        tdLabel.textContent = formatKpiLabel(kpi);
        tr.appendChild(tdLabel);

        // ✅ Add KPI Data for Each Date
        rawData.forEach(entry => {
            const td = document.createElement("td");
            td.textContent = entry[kpi];
            tr.appendChild(td);
        });

        tableBody.appendChild(tr);
    });

    // ✅ Initialize DataTable with Fixed First Column
    $('#weeklyKpiTable').DataTable({
        scrollX: true,
        scrollCollapse: true,
        paging: false, // ✅ Keep all KPI rows visible
        fixedColumns: {
            leftColumns: 1 // ✅ Freeze first column (KPI names)
        }
    });
});

// ✅ Convert camelCase KPIs to readable labels
function formatKpiLabel(kpi) {
    return kpi
        .replace(/([A-Z])/g, " $1") // Add spaces before uppercase letters
        .replace(/^./, str => str.toUpperCase()); // Capitalize first letter
}

