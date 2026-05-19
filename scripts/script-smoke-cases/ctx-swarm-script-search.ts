/* script-smoke
{
  "name": "scripts-smoke-ctx-swarm-script-search",
  "description": "Smoke test ctx.swarm MCP tool calls from reusable scripts",
  "intent": "rich scripts api smoke ctx swarm script search",
  "args": {
    "query": "ctx fetch redaction"
  },
  "expect": {
    "exitCode": 0,
    "result": {
      "success": true,
      "foundFetchCase": true
    }
  }
}
*/

export default async (args: { query: string }, ctx: any) => {
  const response = await ctx.swarm.script_search({ query: args.query, limit: 10 });
  const results = response?.data?.results ?? [];
  return {
    success: response?.success === true,
    foundFetchCase: results.some(
      (result: { name?: string }) => result.name === "scripts-smoke-ctx-fetch-redaction",
    ),
  };
};
