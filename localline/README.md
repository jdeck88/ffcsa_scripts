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
##################################
# Killdeer Scripts
##################################
# Runs at 5:16 AM PT every Monday
16 5 * * 1 /home/exouser/code/killdeer/scripts/run.sh square_market_report.js
# Runs at 4:16 AM PT every day
16 4 * * * /home/exouser/code/killdeer/scripts/run.sh exportPricelistForViewing.js
# Runs at 4:10 AM PT every day
10 4 * * * /home/exouser/code/killdeer/scripts/run.sh backup_mysql.js

##################################
# ffcsa_scripts/localline Scripts
##################################
# DAILY
# Runs at 6:01 AM PT daily
1 6 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh subscriptions.js
# Runs at 12:01 PM PT daily
1 12 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh subscriptions.js
# Runs at 6:01 PM PT daily
1 18 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh subscriptions.js
# Runs at 12:01 AM PT daily
1 0 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh subscriptions.js
# Runs at 3:02 AM PT daily
2 3 * * * /home/exouser/code/ffcsa_scripts/localline/download_subscriber_meta_report.sh

# MONDAY
# Runs at 3:00 AM PT every Monday
0 3 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh delivery_orders.js
# Runs at 3:04 AM PT every Monday
4 3 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh checklists.js
# Runs at 3:11 AM PT every Monday
11 3 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh vendors.js
# Runs at 3:12 AM PT every Monday
12 3 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh weekly_kpi.js
# Runs at 3:13 AM PT every Monday
13 3 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh weekly_benefits.js
# Runs at 3:15 AM PT every Monday
15 3 * * 1 /home/exouser/code/ffcsa_scripts/localline/run.sh optimaroute.js

# TUESDAY
# Runs at 3:05 AM PT every Tuesday
5 3 * * 2 /home/exouser/code/ffcsa_scripts/localline/run.sh status_change.js

# THURSDAY
# Runs at 3:00 AM PT every Thursday
0 3 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh delivery_orders.js
# Runs at 3:04 AM PT every Thursday
4 3 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh checklists.js
# Runs at 3:11 AM PT every Thursday
11 3 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh vendors.js
# Runs at 3:15 AM PT every Thursday
15 3 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh optimaroute.js
# Runs at 3:15 AM PT every Friday
15 3 * * 5 /home/exouser/code/ffcsa_scripts/localline/run.sh fulfillment_strategies.js
# Runs at 3:20 AM PT daily
20 3 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh pricelist_checker.js

# MONTHLY
# Runs at 5:00 AM PT on the 26th of the month
0 5 26 * * /home/exouser/code/ffcsa_scripts/localline/run.sh dufb_summary_sales_report.js
# Runs at 2:01 AM PT on the 1st of the month
1 2 1 * * /home/exouser/code/ffcsa_scripts/localline/run.sh monthly_customers.js
# Runs at 2:03 AM PT on the 1st of the month
3 2 1 * * /home/exouser/code/ffcsa_scripts/localline/run.sh monthly_vendors.js
```

`run.sh` sets up the node environment using NVM. It is important that we point to both
a current node here and that has the properly installed dependencies...

```
#!/bin/bash
# use NVM to get latest node
export NVM_DIR=$HOME/.nvm;
source $NVM_DIR/nvm.sh;
```
