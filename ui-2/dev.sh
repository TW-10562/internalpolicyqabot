#!/bin/bash
# Setup proper Node version and run dev server
source ~/.nvm/nvm.sh
nvm use 22.22.0
cd /home/qabot/hrbot/ui-2
npm run dev
