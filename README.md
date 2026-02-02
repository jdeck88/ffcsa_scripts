[FFCSA KPIs](https://jdeck88.github.io/ffcsa_scripts/)
# ffcsa_scripts
Publicly available scripts on the FFCSA database

Need to install npm packages: mysql, config, fs

Quick usage
```
# To generate an excel spreadsheet from a SQL file
node query-to-xlsx.sh scripts/vapg.sql

# Run a SQL file (prints results; email is optional in runner.sh)
node runner.sh scripts/product_export.sql "message"
```

To install, create a config directory with default.json specifying connection parameters.
For Gmail settings, use an app password (see config settings).

Manual dispositions (Frozen/Dairy/Tote overrides)
- File: localline/manual_dispositions.json
- Keys: Product ID or Product name (from the orders CSV "Product" column). Matching is case-insensitive.
- Values: Frozen, Dairy, Tote
- Used by: localline/checklists.js (packlists + manifests), localline/delivery_orders.js (delivery orders PDF), localline/optimaroute.js (optimaroute.xlsx)
- Purpose: override missing/incorrect Packing Tag values in Local Line exports
- After editing, rerun the report(s) to apply changes

Example:
```
{
  "1023667": "Frozen",
  "Breakfast Bundle": "Frozen"
}
```

Scripts overview
Root helpers (run with node)
- query-to-xlsx.sh: runs a SQL file from scripts/ and writes a .xlsx next to it
- query-to-images.sh: downloads product images from the shop_product table into images/
- runner.sh: runs a SQL file and prints a tab-delimited result (email support is wired but currently disabled)
- run_runner.sh: shell wrapper for runner.sh (cron-friendly)

SQL templates (scripts/)
- allvegetables.sql, graziers_report.sql, graziersgarden.sql, vapg.sql: ad-hoc exports
- customer_detail.sql, customers_export.sql: customer exports
- product_export.sql, products_items.sql, product_images.sql: product-related exports
- vendor_by_month.sql: vendor monthly export

Local Line scripts (localline/)
- run.sh: loads NVM and runs a named node script (logs to localline/data/output.log)
- utilities.js: shared Local Line API + email helpers (library, not a cron target)
- checklists.js: dropsite manifests + frozen/dairy packlists (PDF, emailed)
- delivery_orders.js: delivery order PDFs (grouped Frozen/Dairy/Tote) and labels
- vendors.js: vendor pull lists for a fulfillment date
- optimaroute.js: optimaroute.xlsx with per-customer Frozen/Dairy/Tote counts
- subscriptions.js: pulls subscription payments and updates accounts
- weekly_kpi.js: weekly KPI report
- weekly_benefits.js: weekly benefits report
- dufb_summary_sales_report.js: monthly DUFB summary report
- monthly_customers.js: monthly customer report
- monthly_vendors.js: monthly vendor summary report
- product_kpi.js: product KPI export over a date range
- new_subscribers.js: report of new subscribers
- status_change.js: compares subscriber exports to find cancellations/new plans
- pricelist_checker.js: checks price list consistency
- fulfillment_strategies.js: exports active fulfillment strategies/dropsites with schedules
- download_subscriber_meta_report.sh: downloads the subscriber meta report used by subscriber scripts
- auto_sub_index.js: Express API that creates subscription orders
- auto_sub_constants.js, auto_sub_request.js: helper modules for auto_sub_index.js
- testEmail.js: quick SMTP/email config test

Crontab Scripts
```
# **************************************** #
# Ffcsa/localline Scripts
# **************************************** #
# DAILY
# 6:01 AM PT daily — subscriptions.js
1 13 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh subscriptions.js
# 12:01 PM PT daily — subscriptions.js
1 19 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh subscriptions.js
# 6:01 PM PT daily — subscriptions.js
1 1 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh subscriptions.js
# 12:01 AM PT daily — subscriptions.js
1 7 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh subscriptions.js
# 3:02 AM PT daily — download_subscriber_meta_report.sh
2 10 * * * /home/exouser/code/ffcsa_scripts/localline/download_subscriber_meta_report.sh
# 4:20 AM PT daily — pricelist_checker.js
20 11 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh pricelist_checker.js

# WEEKLY - MONDAY
# 3:00 AM PT every Monday — delivery_orders.js
0 10 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh delivery_orders.js
# 3:04 AM PT every Monday — checklists.js
4 10 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh checklists.js
# 4:11 AM PT every Monday — vendors.js
11 11 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh vendors.js
# 4:12 AM PT every Monday — weekly_kpi.js
12 11 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh weekly_kpi.js
# 4:13 AM PT every Monday — weekly_benefits.js
13 11 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh weekly_benefits.js
# 4:15 AM PT every Monday — optimaroute.js
15 11 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh optimaroute.js

# WEEKLY - TUESDAY
# 4:05 AM PT every Tuesday — status_change.js
5 11 * * 2 /home/exouser/code/ffcsa_scripts/localline/run.sh status_change.js

# WEEKLY - THURSDAY
# 4:00 AM PT every Thursday — delivery_orders.js
0 11 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh delivery_orders.js
# 4:04 AM PT every Thursday — checklists.js
4 11 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh checklists.js
# 4:11 AM PT every Thursday — vendors.js
11 11 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh vendors.js
# 4:15 AM PT every Thursday — optimaroute.js
15 11 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh optimaroute.js

# WEEKLY - FRIDAY
# 4:15 AM PT every Friday — fulfillment_strategies.js
15 11 * * 5 /home/exouser/code/ffcsa_scripts/localline/run.sh fulfillment_strategies.js

# MONTHLY
# 5:00 AM PT on the 26th — dufb_summary_sales_report.js
0 12 26 * * /home/exouser/code/ffcsa_scripts/localline/run.sh dufb_summary_sales_report.js
# 3:01 AM PT on the 1st — monthly_customers.js
1 10 1 * * /home/exouser/code/ffcsa_scripts/localline/run.sh monthly_customers.js
# 3:03 AM PT on the 1st — monthly_vendors.js
3 10 1 * * /home/exouser/code/ffcsa_scripts/localline/run.sh monthly_vendors.js
```
