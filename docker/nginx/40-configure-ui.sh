#!/bin/sh
set -eu

cp /opt/hrbot/hrbot.ui.http.conf /etc/nginx/conf.d/default.conf

if [ -f /etc/nginx/ssl/fullchain.pem ] && [ -f /etc/nginx/ssl/privkey.pem ]; then
  printf '\n' >> /etc/nginx/conf.d/default.conf
  cat /opt/hrbot/hrbot.ui.https.conf >> /etc/nginx/conf.d/default.conf
fi

# Enable gzip compression for all text-based assets
cat > /etc/nginx/conf.d/gzip.conf << 'GZIP'
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 5;
gzip_min_length 256;
gzip_types
  text/plain
  text/css
  text/javascript
  application/javascript
  application/json
  application/xml
  image/svg+xml
  application/wasm;
GZIP
