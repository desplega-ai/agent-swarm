# The API image of the commit under test, plus the model's client scripts in /k.
# One image serves both containers: `app` runs the API, `client` idles and runs /k.
# The scripts add a few KB, so images.tar holds the API layers once.
ARG SWARM_IMAGE=ghcr.io/desplega-ai/agent-swarm:sha-7dce4fa
FROM ${SWARM_IMAGE}
COPY --chmod=755 k/ /k/
RUN mkdir -p /state
