$(document).ready(async function () {
    const dataUrl = "https://raw.githubusercontent.com/jdeck88/ffcsa_scripts/main/localline/data/weekly_kpi.json";

    try {
        // ✅ Fetch JSON Data from GitHub
        const response = await fetch(dataUrl);
        if (!response.ok) throw new Error(`Failed to fetch weekly data: ${response.statusText}`);
        const jsonData = await response.json();

        // ✅ Extract weekly data
        const weeksData = jsonData.weeks;
        if (!Array.isArray(weeksData) || weeksData.length === 0) {
            throw new Error("Invalid JSON format: Missing 'weeks' array.");
        }

        // ✅ Compute Yearly Sales Average from Weekly Data
        const totalSalesValues = weeksData.map(week => parseFloat(week.data.totalSales) || 0);
        const yearlyAverageSales = totalSalesValues.reduce((sum, sales) => sum + sales, 0) / totalSalesValues.length;

        console.log(`✅ Computed Yearly Average Sales: ${yearlyAverageSales.toFixed(2)}`);

        // ✅ Extract Unique Date Ranges as Columns
        const dateRanges = weeksData.map(entry => entry.dateRange);

        // ✅ Extract KPI Labels from First Entry (excluding nested objects)
        let kpiLabels = Object.keys(weeksData[0].data).filter(
            key => typeof weeksData[0].data[key] !== "object"
        );

        // ✅ Add New KPI Labels for Computed Columns
        kpiLabels.push("activeSubscriberOrderRate", "salesComparedToYearlyAvg");

        // ✅ Populate Table Headers with Date Ranges
        const headerRow = document.getElementById("headerRow");
        dateRanges.forEach(dateRange => {
            const th = document.createElement("th");
            th.textContent = dateRange;
            headerRow.appendChild(th);
        });

        // ✅ Populate Table Body
        const tableBody = document.getElementById("tableBody");

        kpiLabels.forEach(kpi => {
            const tr = document.createElement("tr");

            // ✅ First Column: KPI Label (Frozen Column)
            const tdLabel = document.createElement("td");
            tdLabel.textContent = formatKpiLabel(kpi);
            tr.appendChild(tdLabel);

            // ✅ Append Data for Each Date
            weeksData.forEach(week => {
                const td = document.createElement("td");

                if (kpi === "activeSubscriberOrderRate") {
                    // ✅ Calculate % of Active Subscribers Who Made an Order
                    const percentage = ((week.data.numSubscriberOrders / week.data.totalActiveSubscribers) * 100).toFixed(2);
                    td.textContent = `${Math.round(percentage)}%`
                } else if (kpi === "salesComparedToYearlyAvg") {
                    // ✅ Compare Total Sales to Yearly Average
                    const comparison = ((parseFloat(week.data.totalSales) / yearlyAverageSales) * 100).toFixed(2);
                    td.textContent = `${Math.round(comparison)}%`
                } else {
                    // ✅ Default: Use existing data
                    td.textContent = week.data[kpi] !== undefined ? week.data[kpi] : "-";
                }

                tr.appendChild(td);
            });

            tableBody.appendChild(tr);
        });

        // ✅ Initialize DataTable with Fixed First Column
        let table = $('#weeklyKpiTable').DataTable({
            scrollX: true,
            scrollCollapse: true,
            paging: false, // ✅ Keep all KPI rows visible
            ordering: false, // ✅ Disable sorting
            info: false, // ✅ Hide table info text
            searching: false, // ✅ Disable search box
            fixedColumns: {
                leftColumns: 1 // ✅ Freeze first column (KPI names)
            }
        });

        // ✅ Start Scrolled to the Right
        setTimeout(() => {
            let container = $(".dataTables_scrollBody");
            container.scrollLeft(container[0].scrollWidth);
        }, 500);

        console.log("✅ Data loaded successfully");

    } catch (error) {
        console.error("❌ Error fetching data:", error);
    }
});

// ✅ Convert camelCase KPIs to readable labels
function formatKpiLabel(kpi) {
    const labels = {
        activeSubscriberOrderRate: "% of Active Subscribers Ordered",
        salesComparedToYearlyAvg: "Sales Compared to Yearly Avg"
    };
    return labels[kpi] || kpi.replace(/([A-Z])/g, " $1").replace(/^./, str => str.toUpperCase());
}

