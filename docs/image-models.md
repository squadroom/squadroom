# Image models

The image tools (`image_generate`, `image_edit`) that Claude Code windows can
use call [Krea](https://www.krea.ai)'s API with your own `KREA_API_KEY`. The
catalog is [`src/config/design-models.ts`](../src/config/design-models.ts).

**Prices are approximate.** They were read from Krea's OpenAPI description
(<https://api.krea.ai/openapi.json>, each endpoint's `x-krea-pricing`) on
2026-09-26. Check them with Krea before relying on them, and set your cap
there: Krea draws on a prepaid API balance, so its balance (with auto top-up
off) is the hard ceiling. When the balance is empty Krea answers HTTP 402 and
the call fails.

| ID | Model | Text only | With style references | Kind |
|---|---|---|---|---|
| `krea-2-turbo` | Krea 2 Turbo | $0.015 | $0.0175 | image |
| `krea-2-medium` | Krea 2 Medium | $0.03 | $0.035 | image |
| `krea-2-large` | Krea 2 Large | $0.06 | $0.065 | image |
| `flux-kontext-dev` | Flux Kontext Dev (edits) | $0.02 | — | edit |

- **One request, one output.** Krea's image endpoints take no count, so each
  image is its own job, charged at its own price.
- **Billing.** Krea documents that failed and cancelled jobs are not billed,
  so Squadroom refunds a failed or cancelled call; a completed job costs its
  listed price.
- **Outputs** are downloaded as soon as a job completes, over HTTPS, from
  Krea's output hosts only, and written into the agent's `design/` folder.
- **Reference images** (up to 4 style references, or an edit's source) are
  uploaded as Krea assets first, because Krea takes them by URL.
- **Terms.** <https://www.krea.ai/terms>: Krea grants a non-exclusive licence
  to content generated with its services, subject to its own policies. Read
  them yourself before using generated images.

To add a model, it must have a documented fixed price per request (so the
charge at submit is exact). Add it to `DESIGN_MODELS` with its endpoint,
prices, reference limit, output hosts and sources, then add it here.
