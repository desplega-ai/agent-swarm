# PostgreSQL 16 with pgvector, small enough for images.tar.
#
# pgvector/pgvector:pg16 is about 480 MB unpacked. This image is the official
# postgres:16-alpine plus pgvector built from source, without LLVM (about 195 MB of
# JIT support that the workload does not use; compose.yaml sets jit=off). The second
# stage flattens the layers, so the deleted files do not stay in the archive.
FROM postgres:16-alpine AS build
ARG PGVECTOR_VERSION=v0.8.7
RUN apk add --no-cache --virtual .build build-base git \
  && git clone --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /tmp/pgvector \
  && cd /tmp/pgvector \
  && make OPTFLAGS="" with_llvm=no \
  && make install with_llvm=no \
  && cd / \
  && rm -rf /tmp/pgvector \
  && apk del .build \
  && rm -rf /usr/lib/libLLVM* /usr/local/lib/postgresql/llvmjit* /usr/local/lib/postgresql/bitcode

FROM scratch
COPY --from=build / /
# The configuration of postgres:16-alpine, which `FROM scratch` does not carry over.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  LANG=en_US.utf8 \
  PG_MAJOR=16 \
  PGDATA=/var/lib/postgresql/data
VOLUME /var/lib/postgresql/data
STOPSIGNAL SIGINT
EXPOSE 5432
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["postgres"]
