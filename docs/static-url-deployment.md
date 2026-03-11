# Static URL Deployment

This project can be exposed through one stable website URL by running the built `ui` container and letting nginx proxy all browser API calls to the `api` service.

## Required env

Set these values in the root `.env` file before starting Docker Compose:

```bash
WEB_PORT=7001
API_PORT=8080
PUBLIC_BASE_URL=http://YOUR_SERVER_IP:7001
```

If you have a domain name, use it instead:

```bash
WEB_PORT=80
PUBLIC_BASE_URL=http://bot.your-company.com
```

If the API must be exposed on a different public address, also set:

```bash
PUBLIC_API_BASE_URL=https://api.your-company.com
```

## Start the website

```bash
docker compose up -d --build ui api redis postgres solr rag-python llm-gateway
```

## Access URL

- Website: `${PUBLIC_BASE_URL}`
- API behind website: `${PUBLIC_BASE_URL}/dev-api`

## Notes

- If you use a domain, point the DNS record to the server IP first.
- If you want a clean URL without a port, bind `WEB_PORT=80` or place the stack behind your existing reverse proxy.
- Backend-generated links now use `PUBLIC_BASE_URL` and stop falling back to `localhost` when that variable is set.
