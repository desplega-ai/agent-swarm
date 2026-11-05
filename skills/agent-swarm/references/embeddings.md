# Choose memory embeddings

Swarm memory supports local TEI and hosted OpenAI-compatible providers. Without embeddings, memory search uses keywords.
These settings belong to the swarm API. Worker credentials do not configure memory embeddings.
Agent-fs has separate embedding settings for its own file search.

## Choose a deployment path

- The [one-command installer](https://github.com/desplega-ai/agent-swarm/blob/main/install.sh) already bundles TEI for new installations. It selects the CPU image for the host architecture.
- For the manual [Compose example](https://github.com/desplega-ai/agent-swarm/blob/main/docker-compose.example.yml), enable the [TEI overlay](https://github.com/desplega-ai/agent-swarm/blob/main/docker-compose.tei.yml) below.
- For an existing deployment, inspect its Compose files and stored configuration before changing the embedding provider.
- For a hosted provider, use Settings, Integrations, Memory. Select a preset or enter an OpenAI-compatible endpoint, model, and key. Test the provider before saving.

`OPENROUTER_API_KEY` alone does not enable memory embeddings. Hosted embeddings need `EMBEDDING_API_KEY`, or the `OPENAI_API_KEY` fallback.
Local TEI needs no paid key. Its overlay supplies `EMBEDDING_API_KEY=local-tei` because the swarm requires a nonempty value.

## Enable TEI with manual Compose

Complete the [Compose preparation](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/compose.md) first.
Check the Docker engine architecture:

```bash
docker info --format '{{.Architecture}}'
```

The default image is `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4` for amd64.
For `aarch64` or `arm64`, add this line to `.env`:

```dotenv
TEI_IMAGE=ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-1.9.4
```

The overlay supplies these API settings:

```dotenv
EMBEDDING_API_BASE_URL=http://tei:80/v1
EMBEDDING_MODEL=nomic-ai/nomic-embed-text-v1.5
EMBEDDING_API_KEY=local-tei
EMBEDDING_QUERY_PREFIX="search_query: "
EMBEDDING_DOCUMENT_PREFIX="search_document: "
```

Keep both trailing spaces in the prefixes. Keep the default 512 dimensions. Do not change dimensions on an existing database.
The overlay leaves the TEI port inside the Compose network and caches model weights in `tei_data`.
It limits TEI memory to 2 GiB and uses the same batch limits as onboarding.
Allow time and disk space for the first model download, approximately 1.1 GB.

Include both files for every Compose operation, including later updates:

```bash
docker compose -f docker-compose.example.yml -f docker-compose.tei.yml --env-file .env config --quiet
docker compose -f docker-compose.example.yml -f docker-compose.tei.yml --env-file .env pull
docker compose -f docker-compose.example.yml -f docker-compose.tei.yml --env-file .env up -d
docker compose -f docker-compose.example.yml -f docker-compose.tei.yml --env-file .env ps
```

The API starts while TEI downloads its model. Keyword search remains available until embeddings work.
The API then embeds memories that lack vectors in the background.
Stored embedding settings can override deployment defaults. To restore TEI, select Local in Settings, Integrations, Memory and test it before saving.
For an existing installation, preserve the database and encryption key before changing providers.
A change of model or document prefix starts re-embedding in the background.

## Verify TEI and swarm memory

Check the TEI health endpoint after the download completes:

```bash
docker compose -f docker-compose.example.yml -f docker-compose.tei.yml --env-file .env exec -T tei \
  curl -fsS http://127.0.0.1:80/health
```

Request an embedding from the running model:

```bash
docker compose -f docker-compose.example.yml -f docker-compose.tei.yml --env-file .env exec -T tei \
  curl -fsS http://127.0.0.1:80/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"nomic-ai/nomic-embed-text-v1.5","input":["search_query: swarm memory"],"dimensions":512}' \
  | jq -e '.data[0].embedding | length == 512'
```

In `/setup` or Settings, Integrations, Memory, test the Local provider. Confirm that the test succeeds.
Store a memory, then search for it with different words that retain its meaning.
TEI health alone does not prove that the swarm uses the local provider.
Read the [memory guide](https://docs.agent-swarm.dev/docs/architecture/memory#local-embeddings-with-tei) for recovery and provider changes.
