#!/bin/bash

# This script is designed to first setup the a particular Node environment
# and then execute particular node scripts

# use NVM to get latest node
export NVM_DIR=$HOME/.nvm;
source $NVM_DIR/nvm.sh;

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



