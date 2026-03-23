#!/bin/sh
set -eu

cp /opt/hrbot/hrbot.ui.http.conf /etc/nginx/conf.d/default.conf

if [ -f /etc/nginx/ssl/fullchain.pem ] && [ -f /etc/nginx/ssl/privkey.pem ]; then
  printf '\n' >> /etc/nginx/conf.d/default.conf
  cat /opt/hrbot/hrbot.ui.https.conf >> /etc/nginx/conf.d/default.conf
fi
