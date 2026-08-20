export interface PromptTemplateDefaultDrift {
  defaultDrifted: boolean;
  customizedBytes: number;
  defaultBytes: number;
  byteDelta: number;
}

export function getPromptTemplateDefaultDrift(
  template: { body: string; isDefault: boolean },
  defaultBody: string,
): PromptTemplateDefaultDrift {
  const customizedBytes = Buffer.byteLength(template.body, "utf8");
  const defaultBytes = Buffer.byteLength(defaultBody, "utf8");

  return {
    defaultDrifted: !template.isDefault && template.body !== defaultBody,
    customizedBytes,
    defaultBytes,
    byteDelta: defaultBytes - customizedBytes,
  };
}
