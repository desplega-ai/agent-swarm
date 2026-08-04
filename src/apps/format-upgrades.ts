export const CURRENT_APP_SCHEMA_VERSION = 1;

type AppFormatUpgrade = {
  from: number;
  to: number;
  upgrade: (raw: Record<string, unknown>) => Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function upgradeFrom0(raw: Record<string, unknown>): Record<string, unknown> {
  const upgraded = { ...raw };
  if (isRecord(upgraded.page) && !Object.hasOwn(upgraded, "pages")) {
    upgraded.pages = { main: upgraded.page };
    upgraded.defaultPage = "main";
  }
  delete upgraded.page;

  if (isRecord(upgraded.models)) {
    upgraded.models = Object.fromEntries(
      Object.entries(upgraded.models).map(([modelName, model]) => {
        if (!isRecord(model)) return [modelName, model];
        const upgradedModel = { ...model };
        delete upgradedModel.sources;
        if (isRecord(upgradedModel.columns)) {
          upgradedModel.columns = Object.fromEntries(
            Object.entries(upgradedModel.columns).map(([columnName, column]) => {
              if (!isRecord(column)) return [columnName, column];
              const upgradedColumn = { ...column };
              delete upgradedColumn.source;
              return [columnName, upgradedColumn];
            }),
          );
        }
        return [modelName, upgradedModel];
      }),
    );
  }
  upgraded.schemaVersion = 1;
  return upgraded;
}

const APP_FORMAT_UPGRADES: AppFormatUpgrade[] = [{ from: 0, to: 1, upgrade: upgradeFrom0 }];

export function schemaVersionOf(raw: unknown): number {
  if (
    !isRecord(raw) ||
    typeof raw.schemaVersion !== "number" ||
    !Number.isInteger(raw.schemaVersion)
  ) {
    return 0;
  }
  return raw.schemaVersion;
}

export function upgradeAppDefinition(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;

  let upgraded = raw;
  let version = schemaVersionOf(upgraded);
  while (version < CURRENT_APP_SCHEMA_VERSION) {
    const next = APP_FORMAT_UPGRADES.find((upgrade) => upgrade.from === version);
    if (!next) break;
    upgraded = next.upgrade(upgraded);
    version = next.to;
  }
  return upgraded;
}

export function stampAppDefinition(definition: Record<string, unknown>): Record<string, unknown> {
  return { ...definition, schemaVersion: CURRENT_APP_SCHEMA_VERSION };
}
