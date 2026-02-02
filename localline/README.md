FFCSA Local Line Scripts
========================

This folder contains the scripts that generate FFCSA operational reports from the Local Line API. Most scripts are run via cron using `run.sh`, which sets up Node via NVM and writes logs to `localline/data/output.log`.

Important notes
- Run `delivery_orders.js` first when running a batch manually; it downloads the orders CSV used by other reports.
- Most scripts rely on `utilities.js` for Local Line auth, downloads, and email sending.

Manual dispositions (Frozen/Dairy/Tote overrides)
- File: `localline/manual_dispositions.json`
- Keys: Product ID or Product name (from the orders CSV `Product` column). Matching is case-insensitive.
- Values: `Frozen`, `Dairy`, `Tote`
- Used by: `checklists.js` (packlists + manifests), `delivery_orders.js` (delivery orders PDF), `optimaroute.js` (optimaroute.xlsx)
- Purpose: override missing/incorrect `Packing Tag` values in Local Line exports
- After editing, rerun the report(s) to apply changes

Example:
```
{
  "1023667": "Frozen",
  "Breakfast Bundle": "Frozen"
}
```

Running manually
- Most scripts are executed as `node <script>.js` from this folder.
- For date-specific runs, edit the script’s date config near the bottom (e.g. `fullfillmentDateObject` or `utilities.getNextFullfillmentDate()`).

Environment
These scripts rely on a `.env` file (not committed). Typical fields:
```
USERNAME=user_email
PASSWORD=user_pass

MAIL_ACCESS=mail_access_key
MAIL_USER=mail_access_email

ENVIRONMENT=PRODUCTION | DEVELOPMENT
```

Scripts overview
- `run.sh`: loads NVM and runs a named script (cron entrypoint)
- `utilities.js`: Local Line API + email helpers (library, not a cron target)
- `checklists.js`: dropsite manifests + frozen/dairy packlists (PDF, emailed)
- `delivery_orders.js`: delivery order PDFs (grouped Frozen/Dairy/Tote) and labels
- `vendors.js`: vendor pull lists for a fulfillment date
- `optimaroute.js`: optimaroute.xlsx with per-customer Frozen/Dairy/Tote counts
- `subscriptions.js`: subscription payment report + account updates
- `weekly_kpi.js`: weekly KPI report
- `weekly_benefits.js`: weekly benefits report
- `dufb_summary_sales_report.js`: monthly DUFB summary report
- `monthly_customers.js`: monthly customer report
- `monthly_vendors.js`: monthly vendor summary report
- `product_kpi.js`: product KPI export over a date range
- `new_subscribers.js`: report of new subscribers
- `status_change.js`: compares subscriber exports to find cancellations/new plans
- `pricelist_checker.js`: checks price list consistency
- `fulfillment_strategies.js`: exports active fulfillment strategies/dropsites with schedules
- `download_subscriber_meta_report.sh`: downloads subscriber meta report used by subscriber scripts
- `auto_sub_index.js`: Express API that creates subscription orders
- `auto_sub_constants.js`, `auto_sub_request.js`: helpers for `auto_sub_index.js`
- `testEmail.js`: quick SMTP/email config test

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
