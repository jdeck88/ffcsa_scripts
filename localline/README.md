FFCSA Local Line Scripts
========================

This folder contains the scripts that generate FFCSA operational reports from the Local Line API. Most scripts are run via cron using `run.sh`, which sets up Node via NVM and writes logs to `localline/data/output.log`.

Important notes
- Run `delivery_orders.js` first when running a batch manually; it downloads the orders CSV used by other reports.
- Most scripts rely on `utilities.js` for Local Line auth, downloads, and email sending.

Historical vendor prices
------------------------
`order_pricing.js` supplies vendor costing to `vendors.js`, `monthly_vendors.js`,
`weekly_report.js`, and `publish_dashboard_auto26.js`. It fetches each selected
order once and uses the order entry's saved `package_unit_price` multiplied by
`quantity_to_charge`. It does not look up current catalog prices, round weights
to whole units, or substitute customer prices for missing vendor prices.

For example, three salamis ordered at a $20 base price and two ordered at $15
cost $90. The vendor PDF lists the two prices separately. Customer sales remain
the saved order totals, including their price-list adjustments. Price changes
to the catalog do not reprice earlier orders. Explicit edits to an order are
reflected on the next run.

For Full Farm CSA boxes, the fulfillment sheets use the saved base price on each
component. Local Line's component `price` is the component total **per box**, not
the unit price. The existing report scopes are retained: fulfillment sheets add
component quantities for source vendors, while monthly/weekly sales summaries
cost the parent order lines. This change does not reallocate bundle sales or
replace parent box costs with component costs in those summaries.

Order exports and fetched order details are checked for matching product/package
subtotals. Missing historical prices, unavailable component charge quantities,
API failures, or mismatched exports stop priced reports before sending them.
Details appear in `<orders-file>_pricing_review.csv` alongside the input CSV.
A saved price of $0 is valid. Weighted box components without an explicit charge
quantity require review; their cost is not guessed from the customer price.
Packing and customer balance/spending reports retain their existing behavior.

Each fetched order's pricing data is preserved in `data/order_price_history/`
as an immutable version identified by its contents. These files exclude customer
contact information. Correcting an order creates another version; rerunning an
unchanged order leaves its version intact. Keep this directory in server backups.
The reports no longer refresh dated `products_YYYY-MM-DD.xlsx` files for costing.
Existing product snapshots are left in place. `vendors.js` still uses a current
product export to resolve component vendor names, not prices.

New summary CSVs include `PricingBasis=order-package-unit-price-v1`. Weekly report
and dashboard readers flag older summaries and leave those costs unavailable
until rebuilt. Replaced summary CSVs are archived in `data/vendor_summary_history/`.
Already emailed PDFs and already published Sheets are not changed automatically.

Run from this folder:

```sh
# Run regression tests without network access or email.
node --test order_pricing.test.js

# Generate local vendor artifacts without sending email.
node vendors.js --dry-run

# Rebuild August 2026 monthly artifacts without email (date selects prior month).
node monthly_vendors.js 2026-09-01 --dry-run

# Rebuild missing/legacy weekly summaries and make a local PDF.
node weekly_report.js /tmp/sales_kpi26.csv /tmp/weekly_report.pdf --backfill-vendor-weeks

# Rebuild missing/legacy weekly summaries and preview the dashboard locally.
node publish_dashboard_auto26.js --backfill-vendor-weeks --dry-run
```

These reporting commands make read-only Local Line API requests. The two
`--dry-run` report modes still write local exports and reports. Rebuilding many
weeks takes longer because saved order details are fetched individually, with
at most four order requests in flight. Existing order-selection filters (such
as `status=OPEN`) remain in effect when rebuilding historical periods.

Manual dispositions (Frozen/Dairy/Tote overrides)
- File: `localline/manual_dispositions.json`
- Keys: Product ID or Product name (from the orders CSV `Product` column). Matching is case-insensitive and uses substring matching.
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
- `dairy_monitor.js`: flags members with `CSA Only` customer-account tags who ordered from the target dairy vendor (currently `radiant` / Vendor ID `3158`), emails a detailed body summary, and attaches a PDF report
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
