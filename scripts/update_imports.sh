#!/bin/bash
# Script to update all quick.db imports to mysql wrapper

find . -type f -name "*.js" -not -path "./node_modules/*" -not -path "./.git/*" | while read file; do
    # Replace require paths
    sed -i "s|require('./quickdb')|require('./mysql')|g" "$file"
    sed -i "s|require('../utils/quickdb')|require('../utils/mysql')|g" "$file"
    sed -i "s|require('../../utils/quickdb')|require('../../utils/mysql')|g" "$file"
    sed -i "s|require('./utils/quickdb')|require('./utils/mysql')|g" "$file"
    sed -i "s|require('../quickdb')|require('../mysql')|g" "$file"
done

echo "All imports updated!"

