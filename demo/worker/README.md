# Demo Worker

The public API behind the live demo on offhook.welldun.ai (see [DEMO.md](../../DEMO.md)). It runs on Cloudflare Workers' free plan.

So far it serves:

| Route | What it does |
| --- | --- |
| `GET /use-cases` | The three launch use cases, from `site/src/use-cases.ts` |
| `POST /plans` | `{"purpose": "..."}` → `{"status": "planned", "plan": {...}}` or `{"status": "refused", "reason": "..."}` |

## Run it

Wrangler needs Node 22 (`nvm use`).

```bash
pnpm install
cp .dev.vars.example .dev.vars   # add GROQ_API_KEY
pnpm dev                         # http://localhost:8787
pnpm test
```

```bash
curl -s localhost:8787/plans -H 'content-type: application/json' \
  -d '{"purpose": "Call customers who missed a delivery yesterday. Find a new day and note any instructions for the driver."}'
```
