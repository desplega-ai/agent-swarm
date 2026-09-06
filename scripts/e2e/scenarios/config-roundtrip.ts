import { asRecord, expect, expectStatus } from "../http";
import { SkipError } from "../report";
import type { Scenario } from "../run";

export const configRoundtrip: Scenario = {
  name: "config-roundtrip",
  async run(ctx) {
    const key = "SWARM_HIDE_CLOUD_PROMO";
    const upsert = await ctx.api("PUT", "/api/config", {
      body: { scope: "global", scopeId: null, key, value: "true", isSecret: false },
    });
    if (upsert.status === 400) {
      throw new SkipError(
        `The config API rejected catalog key ${key}: ${upsert.text.slice(0, 300)}`,
      );
    }
    expectStatus(upsert, [200], "upsert config");
    const id = asRecord(upsert.json).id;
    expect(typeof id === "string", "Config upsert response has no id");

    let response = await ctx.api("GET", "/api/config?scope=global");
    expectStatus(response, [200], "list config after upsert");
    const configs = asRecord(response.json).configs;
    expect(Array.isArray(configs), "Config list has no configs array");
    expect(
      configs
        .map(asRecord)
        .some((config) => config.id === id && config.key === key && config.value === "true"),
      "Config list does not contain the stored value",
    );

    expectStatus(await ctx.api("DELETE", `/api/config/${id}`), [200], "delete config");
    response = await ctx.api("GET", "/api/config?scope=global");
    expectStatus(response, [200], "list config after delete");
    const remaining = asRecord(response.json).configs;
    expect(
      Array.isArray(remaining) && !remaining.map(asRecord).some((config) => config.id === id),
      "Deleted config is still present",
    );
  },
};
