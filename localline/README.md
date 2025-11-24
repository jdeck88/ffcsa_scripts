Contained in this directory are sceripts that generate PDF reports for FFCSA operations and reporting.

1. `checklists.js` generates checklists used for packing for each fulfillment date
2. `delivery_orders.js` generates delivery orders for each fulfillment date
3. `vendors.js` generates vendor pull lists for each fulfillment date
4. `monthly_vendors.js`  generates sales by vendor for the previous month
5. `subscriptions.js`  generates a list of new payments for subscription and then updates accounts

The above scripts are designed to run using a cronjob (see below).  There may be times when you need to run these scripts
manually.  In this case you want to alter and run node files each individually,
calling the script main or run function with a specific date that you want to run,
for example changing the line `delivery_order(utilities.getNextFullfillmentDate());` with `delivery_order('2023-10-31)`
and then running the script like  `node delivery_order.js` 

The cronjob to use for all scripts is below.  `run.sh` is a bash script that runs
each individual nodejs script.  All of the nodejs scripts generate a different
type of report that is emailed.  `run.sh` outputs a log file into `data/output.log`

NOTE: always run `delivery_orders.js` first since that downloads necessary files for other
scripts

These scripts rely on a `.env` file that is not committed to github looks something like:
```
USERNAME=user_email
PASSWORD=user_pass

MAIL_ACCESS=mail_access_key
MAIL_USER=mail_access_email

ENVIRONMENT=PRODUCTION | DEVELOPMENT
```

```
# **************************************** #
# Killdeer Scripts
# **************************************** #
# 5:16 AM PT every Monday — square_market_report.js
16 12 * * 1 /home/jdeck/code/killdeer/scripts/run.sh square_market_report.js
# 4:16 AM PT daily — exportPricelistForViewing.js
16 11 * * * /home/jdeck/code/killdeer/scripts/run.sh export_master_pricelist.js
# 4:10 AM PT daily — backup_mysql.js
10 11 * * * /home/jdeck/code/killdeer/scripts/run.sh backup_mysql.js

# **************************************** #
# Ffcsa/localline Scripts
# **************************************** #
# DAILY
# 6:30 AM PT daily — subscriptions.js
30 13 * * * /home/jdeck/code/ffcsa_scripts/localline/run.sh subscriptions.js
# 12:30 PM PT daily — subscriptions.js
30 19 * * * /home/jdeck/code/ffcsa_scripts/localline/run.sh subscriptions.js
# 6:30 PM PT daily — subscriptions.js
30 1 * * * /home/jdeck/code/ffcsa_scripts/localline/run.sh subscriptions.js
# 12:30 AM PT daily — subscriptions.js
30 7 * * * /home/jdeck/code/ffcsa_scripts/localline/run.sh subscriptions.js
# 3:02 AM PT daily — download_subscriber_meta_report.sh
2 10 * * * /home/jdeck/code/ffcsa_scripts/localline/download_subscriber_meta_report.sh
# 4:20 AM PT daily — pricelist_checker.js
20 11 * * * /home/jdeck/code/ffcsa_scripts/localline/run.sh pricelist_checker.js

# 5:00 PM PT daily — report-today.js
0 0 * * * /home/jdeck/code/production-backend/scripts/run.sh report-today.js
# 8:00 AM PT daily — report-today.js
0 15 * * * /home/jdeck/code/production-backend/scripts/run.sh report-today.js
# 12:30 AM PT daily — clearStartTimes.js
30 7 * * * /home/jdeck/code/production-backend/scripts/run.sh clearStartTimes.js
# 12:31 AM PT daily — fulfillment_strategies.js
31 7 * * * /home/jdeck/code/production-backend/scripts/run.sh fulfillment_strategies.js

# WEEKLY - MONDAY
# 3:00 AM PT every Monday — delivery_orders.js
0 10 * * 1 /home/jdeck/code/ffcsa_scripts/localline/run.sh delivery_orders.js
# 3:04 AM PT every Monday — checklists.js
4 10 * * 1 /home/jdeck/code/ffcsa_scripts/localline/run.sh checklists.js
# 4:11 AM PT every Monday — vendors.js
11 11 * * 1 /home/jdeck/code/ffcsa_scripts/localline/run.sh vendors.js
# 4:12 AM PT every Monday — weekly_kpi.js
12 11 * * 1 /home/jdeck/code/ffcsa_scripts/localline/run.sh weekly_kpi.js
# 4:13 AM PT every Monday — weekly_benefits.js
13 11 * * 1 /home/jdeck/code/ffcsa_scripts/localline/run.sh weekly_benefits.js
# 4:15 AM PT every Monday — optimaroute.js
15 11 * * 1 /home/jdeck/code/ffcsa_scripts/localline/run.sh optimaroute.js

# WEEKLY - TUESDAY
# 4:05 AM PT every Tuesday — status_change.js
5 11 * * 2 /home/jdeck/code/ffcsa_scripts/localline/run.sh status_change.js

# WEEKLY - THURSDAY
# 4:00 AM PT every Thursday — delivery_orders.js
0 11 * * 4 /home/jdeck/code/ffcsa_scripts/localline/run.sh delivery_orders.js
# 4:04 AM PT every Thursday — checklists.js
4 11 * * 4 /home/jdeck/code/ffcsa_scripts/localline/run.sh checklists.js
# 4:11 AM PT every Thursday — vendors.js
11 11 * * 4 /home/jdeck/code/ffcsa_scripts/localline/run.sh vendors.js
# 4:15 AM PT every Thursday — optimaroute.js
15 11 * * 4 /home/jdeck/code/ffcsa_scripts/localline/run.sh optimaroute.js

# MONTHLY
# 5:00 AM PT on the 26th — dufb_summary_sales_report.js
0 12 26 * * /home/jdeck/code/ffcsa_scripts/localline/run.sh dufb_summary_sales_report.js
# 3:01 AM PT on the 1st — monthly_customers.js
1 10 1 * * /home/jdeck/code/ffcsa_scripts/localline/run.sh monthly_customers.js
# 3:03 AM PT on the 1st — monthly_vendors.js
3 10 1 * * /home/jdeck/code/ffcsa_scripts/localline/run.sh monthly_vendors.js
```

`run.sh` sets up the node environment using NVM. It is important that we point to both
a current node here and that has the properly installed dependencies...

```
#!/bin/bash
# use NVM to get latest node
export NVM_DIR=$HOME/.nvm;
source $NVM_DIR/nvm.sh;
```
