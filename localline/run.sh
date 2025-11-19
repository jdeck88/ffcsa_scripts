#!/bin/bash

# This script is designed to first setup the a particular Node environment
# and then execute particular node scripts

# use NVM to get latest node
#export NVM_DIR=$HOME/.nvm;
#source $NVM_DIR/nvm.sh;

# Change to the current location
cd "$(dirname "$0")"

# Check if the correct number of arguments is provided
if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <node_script>"
    exit 1
fi

# Assign the argument to a variable
node_script="$1"

# Check if the Node.js script exists
if [ ! -f "$node_script" ]; then
    echo "Error: Node.js script not found: $node_script"
    exit 1
fi

# Execute the Node.js script
node "$node_script" >> data/output.log 2>&1

git pull
# Run github push when subscriptions file is run...
echo $1
if [ "$1" == "subscriptions.js" ]; then
  if [[ -n $(git status -s data/order_data_*) ]]; then
    git add data/order_data_*
    git commit -m "Update data files"
    git push
    echo "Changes pushed to GitHub."
  else
    echo "No changes in data files."
  fi
fi
if [ "$1" == "pricelist_checker.js" ]; then
  if [[ -n $(git status -s data/*_analytics.csv) ]]; then
    git add data/*_analytics.csv
    git commit -m "Update data files"
    git push
    echo "Changes pushed to GitHub."
  else
    echo "No changes in data files."
  fi
fi
if [ "$1" == "weekly_kpi.js" ]; then
  if [[ -n $(git status -s data/weekly_kpi.json) ]]; then
    git add data/weekly_kpi.json
    #git add data/fulfillment_kpi.json
    git commit -m "Update weekly kpi files"
    git push
    echo "Changes pushed to GitHub."
  else
    echo "No changes in data files."
  fi
fi
if [ "$1" == "fulfillment_strategies.js" ]; then
  if [[ -n $(git status -s data/delivery_data.tsv) ]]; then
    git add data/delivery_data.tsv
    git add ../docs/delivery_data.html
    git commit -m "Update fulfillment strategies file"
    git push
    echo "Changes pushed to GitHub."
  else
    echo "No changes in data files."
  fi
fi
if [ "$1" == "monthly_vendors.js" ]; then
  shopt -s nullglob  # prevents literal *.xlsx if no match
  files=(data/products_*.xlsx)

  if [ ${#files[@]} -gt 0 ]; then
    if [[ -n $(git status -s "${files[@]}") ]]; then
      git add "${files[@]}"
      git commit -m "Update pricelists generated... as a historical record since LL does not maintain them"
      git push
      echo "✅ Changes pushed to GitHub."
    else
      echo "ℹ️ No changes in data files."
    fi
  else
    echo "⚠️ No product Excel files found in data/."
  fi
fi

