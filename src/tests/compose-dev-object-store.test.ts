import { expect, test } from "bun:test";

for (const file of ["docker-compose.local.yml", "docker-compose.scripts-only.yml"]) {
  test(`${file}: MinIO ports bind to loopback by default`, async () => {
    const compose = Bun.YAML.parse(
      await Bun.file(new URL(`../../${file}`, import.meta.url)).text(),
    ) as { services: { minio: { ports: string[] } } };
    expect(compose.services.minio.ports).toEqual([
      `\${MINIO_BIND_ADDRESS:-127.0.0.1}:9000:9000`,
      `\${MINIO_BIND_ADDRESS:-127.0.0.1}:9001:9001`,
    ]);
  });
}
