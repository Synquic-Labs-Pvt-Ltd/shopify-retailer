# Deploying the Retailer Studio backend

This runbook deploys the backend (Express API plus the generation queue worker) as one Docker service and connects it to a Shopify app. The embedded web app (apps/web) is deployed separately and is not needed for the mobile app.

## 1. What you need

| Item | Where from |
|---|---|
| A Docker-capable host (Render, Railway, Fly.io, Koyeb, a VPS) | Any. Build from this repository's `Dockerfile`, build context = repository root |
| A MongoDB database | MongoDB Atlas free cluster works. Create a database user, allow the host's IP (or 0.0.0.0/0 for a first test), copy the `mongodb+srv://...` connection string and add the database name `retailer-studio` |
| A Shopify Partner / Dev Dashboard account and a dev store with a few products that have images | shopify.dev |
| The Google Cloud project `shopify-retailer` with the Vertex AI API enabled and a service account with the role Vertex AI User | Already done |

## 2. Host settings

| Setting | Value |
|---|---|
| Repository | https://github.com/Synquic-Labs-Pvt-Ltd/shopify-retailer.git, branch `main` |
| Runtime | Docker, Dockerfile path `./Dockerfile`, context `.` |
| Port | The container listens on `PORT` (default 3000). Hosts that inject `PORT` need no setting |
| Health check path | `/health` (answers 200 even while MongoDB is connecting) |
| Instances | 1 (more are safe, the queue claims jobs atomically, but one is enough) |
| Memory | At least 512 MB, 1 GB recommended |
| Always on | Yes. The queue worker and Shopify webhooks need a running process; free tiers that sleep will delay jobs |

## 3. Environment variables

Paste these into the host's environment settings. A ready file with the generated secrets filled in is at `apps/backend/secrets/deploy.env` on the machine that prepared this repository (git-ignored, never committed).

| Variable | Value | Notes |
|---|---|---|
| NODE_ENV | production | Production refuses development defaults and requires an https PUBLIC_BASE_URL |
| ROLE | all | API and queue worker in one process |
| PUBLIC_BASE_URL | https://YOUR-BACKEND-HOST | The public https address of this service, no trailing slash. Known after the first deploy; set it, then redeploy |
| MONGODB_URI | your connection string | Include the database name |
| JWT_SECRET | 64 hex characters | Generate with `openssl rand -hex 32` |
| TOKEN_ENC_KEY | 64 hex characters | Generate with `openssl rand -hex 32`. Encrypts Shopify tokens at rest. Changing it later invalidates stored tokens |
| SHOPIFY_API_KEY | Client ID from the Shopify app | Available after step 4. Use any placeholder for the first deploy |
| SHOPIFY_API_SECRET | Client secret from the Shopify app | Same |
| SHOPIFY_SCOPES | read_products,read_files,write_files | Must equal the scopes configured on the Shopify app |
| SHOPIFY_API_VERSION | 2026-10 | |
| APP_DEEP_LINK_SCHEME | retailerstudio | Mobile app login return link |
| GOOGLE_CLOUD_PROJECT | shopify-retailer | Optional when GOOGLE_SERVICE_ACCOUNT_JSON is set (the key carries the project id) |
| GOOGLE_SERVICE_ACCOUNT_JSON | the service-account key as base64 on one line, or the raw JSON | Hosts that only take env vars. The base64 form is in `apps/backend/secrets/GOOGLE_SERVICE_ACCOUNT_JSON.b64.txt`. A host with secret files can use GOOGLE_APPLICATION_CREDENTIALS (a file path) instead |
| LOG_LEVEL | info | |

Secrets (JWT_SECRET, TOKEN_ENC_KEY, SHOPIFY_API_SECRET, GOOGLE_SERVICE_ACCOUNT_JSON, MONGODB_URI) belong in the host's secret store, never in the repository. The generation settings (output counts, models, per-model rate limits, `video.mode`) live in `apps/backend/config/generation.config.json` and are read at start; change them in the repository and redeploy, or mount an edited file and set GENERATION_CONFIG_PATH to hot reload it.

## 4. Create the Shopify app

In the Shopify Dev Dashboard create an app. Field names may differ slightly from this list.

| Field | Value |
|---|---|
| App name | Retailer Studio (the name must not contain "Shopify") |
| App URL | https://YOUR-BACKEND-HOST/ |
| Embedded in admin | Off for now (the embedded web app is not deployed yet) |
| Allowed redirection URL | https://YOUR-BACKEND-HOST/auth/shopify/callback |
| Scopes | read_products, read_files, write_files |
| Webhooks API version | 2026-10 |
| Webhook subscription app/uninstalled | https://YOUR-BACKEND-HOST/webhooks/shopify |
| Compliance webhooks customers/data_request, customers/redact, shop/redact | https://YOUR-BACKEND-HOST/webhooks/shopify |
| Distribution | Public app, unlisted (or custom) |

Then copy the Client ID into SHOPIFY_API_KEY and the Client secret into SHOPIFY_API_SECRET, redeploy, and check `https://YOUR-BACKEND-HOST/health`: it should report `db: connected`.

## 5. Install and test

1. Install the app on the dev store from the Dev Dashboard install link. Shopify opens the app URL, the backend starts the OAuth install, and a page confirms the app is installed.
2. Build the mobile app with `EXPO_PUBLIC_API_MOCK=false` and `EXPO_PUBLIC_API_BASE_URL=https://YOUR-BACKEND-HOST` (both are inlined at build time), install it, log in with the store domain.
3. Start with one or two products. Each product costs one planner call, two image calls and one Veo video. Quotas are in `lanes` in the generation config.

## 6. When the embedded web app is deployed

Deploy apps/web as its own service (Next.js, `pnpm -F @rs/web build` then `pnpm -F @rs/web start`, environment in `apps/web/.env.example`: NEXT_PUBLIC_SHOPIFY_API_KEY, BACKEND_URL, NEXT_PUBLIC_MOCK unset). Then change the Shopify app: App URL = the web origin, Embedded = on, and keep the redirect URL and webhook URLs working through the web origin (the web app forwards /auth/shopify/* and /webhooks/shopify to the backend). `apps/backend/shopify/shopify.app.toml` has the matching configuration for the Shopify CLI.

## 7. Security notes

- The generated secrets were created on a development machine that has a known malware problem. Before real merchants use the app, generate fresh JWT_SECRET and TOKEN_ENC_KEY on a clean machine or in the host's secret generator, and rotate the Google service-account key.
- Never commit the files in `apps/backend/secrets/`. The folder is git-ignored.
