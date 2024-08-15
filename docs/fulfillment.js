document.addEventListener("DOMContentLoaded", function() {
    const apiUrl = 'https://raw.githubusercontent.com/jdeck88/ffcsa_scripts/main/localline/data/weekly_kpi.json';

    fetch(apiUrl)
        .then(response => response.json())
        .then(data => {
            const weeks = data.weeks;

            // Sort weeks by date in ascending order (if necessary)
            weeks.sort((a, b) => new Date(a.dateRange.split(' to ')[1]) - new Date(b.dateRange.split(' to ')[1]));

            // Extract all unique fulfillment names for rows
            const fulfillmentNames = new Set();
            weeks.forEach(week => {
                week.data.forEach(item => {
                    fulfillmentNames.add(item.fulfillmentName);
                });
            });

            // Convert set to array and sort alphabetically
            const sortedFulfillmentNames = [...fulfillmentNames].sort();

            // Populate table headers dynamically
            const tableHead = document.querySelector('#fulfillmentTable thead tr');
            tableHead.innerHTML = `<th>Fulfillment Name</th>` + weeks.map(week => `<th>${week.dateRange}</th>`).join('');

            // Function to format total and count
            function formatTotalAndCount(total, count) {
                return `$${total} (${count})`;
            }

            // Function to populate the fulfillment table based on selected metric
            function populateFulfillmentTable(metric) {
                const tableBody = document.querySelector('#fulfillmentTable tbody');
                tableBody.innerHTML = '';

                sortedFulfillmentNames.forEach(name => {
                    const rowData = `<tr><td>${name}</td>`;
                    const dataCells = weeks.map(week => {
                        const item = week.data.find(item => item.fulfillmentName === name);
                        if (item) {
                            return `<td>${formatTotalAndCount(item.total, item.count)}</td>`;
                        } else {
                            return `<td>-</td>`;
                        }
                    }).join('');
                    tableBody.innerHTML += rowData + dataCells + '</tr>';
                });

                // Initialize DataTables.js for fulfillment table
                $('#fulfillmentTable').DataTable({
                    paging: true,
                    searching: false,
                    pageLength: 100, // Set default number of entries per page
                    suppressWarnings: true, // Suppress DataTables warnings
                    // More options as needed
                });
            }

            // Event listener for metric form submission
            document.getElementById('metricForm').addEventListener('submit', function(event) {
                event.preventDefault(); // Prevent form submission
                const selectedMetric = document.querySelector('input[name="metric"]:checked').value;
                populateFulfillmentTable(selectedMetric);
            });

            // Initial load: populate fulfillment table with 'total' as default metric
            populateFulfillmentTable('total');
        })
        .catch(error => {
            console.error('Error fetching fulfillment data:', error);
        });
});

