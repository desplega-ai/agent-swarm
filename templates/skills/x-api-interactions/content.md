# X API Interactions (Twitter API v2)

## Authentication

Use OAuth 1.0a for all write operations (POST). Bearer tokens are read-only.

Credentials are stored in swarm config:
- `X_API_KEY` — Consumer key
- `X_API_SECRET` — Consumer secret
- `X_ACCESS_TOKEN` — Access token
- `X_ACCESS_TOKEN_SECRET` — Access token secret

Retrieve with `get-config` tool.

## OAuth 1.0a Signing

```bash
node -e "
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');

const oauth = OAuth({
  consumer: { key: process.env.X_API_KEY, secret: process.env.X_API_SECRET },
  signature_method: 'HMAC-SHA1',
  hash_function: (base, key) => crypto.createHmac('sha1', key).update(base).digest('base64')
});

const token = { key: process.env.X_ACCESS_TOKEN, secret: process.env.X_ACCESS_TOKEN_SECRET };
const url = 'https://api.x.com/2/tweets';
const auth = oauth.authorize({ url, method: 'POST' }, token);
console.log(oauth.toHeader(auth).Authorization);
"
```

## Pre-Check: Conversation Restrictions (CRITICAL)

Before attempting a reply, **always check the target tweet's reply_settings**:

```bash
curl -s "https://api.x.com/2/tweets/{TWEET_ID}?tweet.fields=reply_settings" \
  -H "Authorization: Bearer $X_BEARER_TOKEN"
```

Response includes `reply_settings`:
- `everyone` — Anyone can reply
- `mentionedUsers` — Only mentioned users can reply
- `following` — Only followers can reply

**If reply_settings is NOT "everyone", do NOT attempt the reply.** Report back that the tweet has conversation restrictions.

## Posting a Tweet

```bash
curl -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: $OAUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"text": "Your tweet text"}'
```

## Posting a Reply

```bash
curl -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: $OAUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"text": "Your reply text", "reply": {"in_reply_to_tweet_id": "TWEET_ID"}}'
```

## Posting a Quote Tweet

```bash
curl -X POST "https://api.x.com/2/tweets" \
  -H "Authorization: $OAUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"text": "Your quote text", "quote_tweet_id": "TWEET_ID"}'
```

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| **402 CreditsDepleted** | Monthly API credits exhausted | **STOP immediately.** Do NOT retry. Save generated content to agent-fs. Report to Slack. Taras must top up at developer.x.com. |
| 403 Forbidden on reply | Conversation restrictions | Pre-check reply_settings |
| 403 Forbidden on quote | Quote restrictions | Report back, don't retry |
| 401 Unauthorized | Bad OAuth signature | Verify credentials, check timestamp |
| 429 Too Many Requests | Rate limit | Wait for reset time |

**IMPORTANT: 402 CreditsDepleted is NOT retryable.** Both media-attached and text-only tweets fail with this error. The issue is account-level, not request-level. Do not waste context trying alternative posting methods.

## Account Info

- **Account:** @desplegalabs
- **User ID:** 2027510506601488384

## Workflow

1. Get credentials from swarm config
2. **Pre-check** target tweet's reply_settings (if replying)
3. Construct OAuth 1.0a signature
4. POST the tweet/reply/quote
5. If 402, STOP — save content to agent-fs and report
6. If 403, report the restriction — do NOT retry blindly

## Trade-offs

**OAuth 1.0a vs Bearer token:** Bearer tokens are simpler but read-only. Write operations require the full 4-token OAuth 1.0a signing dance. The `oauth-1.0a` npm package simplifies this.

**Rate limits:** Twitter v2 API rate limits are aggressive on the free/basic tier. Pre-check conversation restrictions before attempting a reply to avoid burning a rate limit slot on a guaranteed-failure request.
