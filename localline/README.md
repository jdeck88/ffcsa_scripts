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
##################################################
# Local Line Scripts (NOTE: UTC is +8 hours)
##################################################
# Run Subscriptions every day at 02:01 PT which is 10:00 UTC
1 10 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh subscriptions.js

# Run new_subscribers report at 02:02 PT and 14:02 PT
2 10 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh new_subscribers.js
2 22 * * * /home/exouser/code/ffcsa_scripts/localline/run.sh new_subscribers.js

# download the subscriber metabase report from local line every day which keeps a log of
# all upcoming subscriptions.  logging changes in git allows us to look back in time
2 10 * * * /home/exouser/code/ffcsa_scripts/localline/download_subscriber_meta_report.sh

# Run all on Monday at 03:00 PT which is 11:00 UTC
0 11 * * 1  /home/exouser/code/ffcsa_scripts/localline/run.sh delivery_orders.js
2 11 * * 1  /home/exouser/code/ffcsa_scripts/localline/run.sh checklists.js
3 11 * * 1  /home/exouser/code/ffcsa_scripts/localline/run.sh optimaroute.js
4 11 * * 1  /home/exouser/code/ffcsa_scripts/localline/run.sh vendors.js
5 11 * * 1  /home/exouser/code/ffcsa_scripts/localline/run.sh weekly_kpi.js
6 11 * * 1  /home/exouser/code/ffcsa_scripts/localline/run.sh weekly_benefits.js

# Run on Tuesday  at 03:00 PT which is 11:00 UTC wait for weekly_kpi to finish
5 11 * * 2  /home/exouser/code/ffcsa_scripts/localline/run.sh status_change.js

# Run all on Thursday at 03:00 PT which is 11:00 UTC
0 11 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh delivery_orders.js
2 11 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh checklists.js
3 11 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh optimaroute.js
4 11 * * 4 /home/exouser/code/ffcsa_scripts/localline/run.sh vendors.js

# Run pricelist check script to print results Friday morning 03:10 PT which is 11:10 UTC
10 11 * * 5 /home/exouser/code/ffcsa_scripts/localline/run.sh pricelist_checker.js

# Run monthly_customers report on the 1st of the month at 01:01 PT which is 09:00 UTC
1 9 1 * * /home/exouser/code/ffcsa_scripts/localline/run.sh monthly_customers.js
# Run monthly_vendors report on the 1st of the month at 04:01 PT which is 12:00 UTC
1 12 1 * * /home/exouser/code/ffcsa_scripts/localline/run.sh monthly_vendors.js
```

`run.sh` sets up the node environment using NVM. It is important that we point to both
a current node here and that has the properly installed dependencies...

```
#!/bin/bash
# use NVM to get latest node
export NVM_DIR=$HOME/.nvm;
source $NVM_DIR/nvm.sh;
```
