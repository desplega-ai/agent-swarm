# Rocket.Chat adapter

The Chat SDK adapter for Rocket.Chat, kept in this repo so the integration adds no npm dependency.

- Files: `index.ts` (the adapter), `markdown.ts` (format conversion), `types.ts` (REST and webhook payload types).
- `adapters.ts` loads it with a dynamic `import("./rocketchat")`, so it loads only when the `rocketchat` adapter is configured.
- REST calls send `redirect: "error"`, so the auth header never follows a redirect. Configure the instance's final URL.
- The webhook token check compares SHA-256 digests with `timingSafeEqual`.
