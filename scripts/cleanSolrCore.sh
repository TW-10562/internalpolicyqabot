curl "http://localhost:8983/solr/mycore/update?commit=true" \
  -H "Content-Type: application/json" \
  --data-binary '{
    "delete": { "query":"*:*" }
  }'
