# Static URL Deployment

This project can be exposed through one stable website URL by running the built `ui` container and letting nginx proxy all browser API calls to the `api` service.

## Required env

Set these values in the root `.env` file before starting Docker Compose:

```bash
WEB_PORT=7001
API_PORT=8080
PUBLIC_BASE_URL=http://hrbot.corp.twave:7001
```

If you have a domain name, use it instead:

```bash
WEB_PORT=80
PUBLIC_BASE_URL=http://bot.your-company.com
```

If you already run a host Nginx (recommended) and want a clean domain URL while keeping the containers on high ports:

```bash
WEB_PORT=7001
API_PORT=8080
PUBLIC_BASE_URL=https://bot.your-company.com
```

Then configure host Nginx using one of:

- `deploy/nginx/hrbot.conf.example` (HTTP)
- `deploy/nginx/hrbot.ssl.conf.example` (HTTPS)

If the API must be exposed on a different public address, also set:

```bash
PUBLIC_API_BASE_URL=https://api.your-company.com
```

## Start the website

```bash
docker compose up -d --build ui api worker redis postgres solr rag-python
```

## Access URL

- Website: `${PUBLIC_BASE_URL}`
- API behind website: `${PUBLIC_BASE_URL}/dev-api`

## Notes

- For this deployment, create an internal DNS record `hrbot.corp.twave -> 10.17.0.221`.
- If you use a domain, point the DNS record to the server IP first.
- If you want a clean URL without a port, bind `WEB_PORT=80` or place the stack behind your existing reverse proxy.
- Backend-generated links now use `PUBLIC_BASE_URL` and stop falling back to `localhost` when that variable is set.
