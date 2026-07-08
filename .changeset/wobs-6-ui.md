---
"miniflare": minor
"wrangler": minor
"@cloudflare/vite-plugin": minor
---

Experimental: add an Observability section to the Local Explorer UI, and enable local observability by default

Adds an Observability entry to the Local Explorer sidebar with two views backed
by the observability HTTP API: a traces list (worker, span/error counts,
duration, outcome) and a trace detail view showing a spans waterfall (nested by
parent, with per-span timeline bars and worker attribution) plus the trace's
logs. Renders with Kumo components.

As the final PR in the stack, this also flips the default: `X_LOCAL_OBSERVABILITY`
now defaults to `true`, so local-dev capture is on by default under both
`wrangler dev` and the Vite plugin. Set `X_LOCAL_OBSERVABILITY=false` to opt out.
