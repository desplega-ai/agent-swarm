export type ScriptApiJsonValue =
  | null
  | boolean
  | number
  | string
  | ScriptApiJsonValue[]
  | { [key: string]: ScriptApiJsonValue };

export type ScriptApiJsonSchema = boolean | { [key: string]: ScriptApiJsonValue };

export type ScriptApiParameterDescriptor = {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: ScriptApiJsonSchema;
};

export type ScriptApiOperationDescriptor = {
  name: string;
  method: string;
  path: string;
  parameters: ScriptApiParameterDescriptor[];
  hasBody: boolean;
  successStatus: string;
  requestBodySchema?: ScriptApiJsonSchema;
  responseSchema: ScriptApiJsonSchema;
  requestType: string;
  responseType: string;
};

export type ScriptApiConnectionDescriptor = {
  slug: string;
  baseUrl: string;
  credential: {
    configKey: string;
    headerTemplate?: string;
    queryTemplate?: string;
  } | null;
  operations: ScriptApiOperationDescriptor[];
};

export type ScriptMcpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: ScriptApiJsonSchema;
};

export type ScriptMcpConnectionDescriptor = {
  slug: string;
  kind: "mcp";
  connectionId: string;
  tools: ScriptMcpToolDescriptor[];
};

export type ScriptApiRegistryClient = Record<
  string,
  Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
>;

export type ScriptMcpRegistryClient = Record<
  string,
  Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
>;
