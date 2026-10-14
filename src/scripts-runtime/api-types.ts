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

export type ScriptApiCredentialDescriptor = {
  configKey: string;
  headerTemplate?: string;
  queryTemplate?: string;
};

export type ScriptOpenApiConnectionDescriptor = {
  slug: string;
  kind?: "openapi";
  baseUrl: string;
  credential: ScriptApiCredentialDescriptor | null;
  operations: ScriptApiOperationDescriptor[];
};

export type ScriptGraphqlConnectionDescriptor = {
  slug: string;
  kind: "graphql";
  baseUrl: string;
  credential: ScriptApiCredentialDescriptor | null;
};

// The DSN never reaches the sandbox: queries go back to the API server by connection id.
export type ScriptSqlConnectionDescriptor = {
  slug: string;
  kind: "sql";
  connectionId: string;
};

export type ScriptApiConnectionDescriptor =
  | ScriptOpenApiConnectionDescriptor
  | ScriptGraphqlConnectionDescriptor
  | ScriptSqlConnectionDescriptor;

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
  Record<string, (...args: unknown[]) => Promise<unknown>>
>;

export type ScriptMcpRegistryClient = Record<
  string,
  Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
>;
