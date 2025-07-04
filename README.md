[FFCSA KPIs](https://jdeck88.github.io/ffcsa_scripts/)
# ffcsa_scripts
publicly available scripts on FFCSA database

Need to install npm packages: mysql, config, fs


```
#To generate an excel spreadsheet 
node query-to-xlsx.sh script/vapg.sql

#run the monthly script files and email 
node runner.sh script/product_export.sql "message"
```

To run one-off exports 
```
node runner-onetime.sh
```

To install, need to create a config directory with default.json specifying connection parameters
Also, for gmail settings be sure to use app password.  see config settings

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
