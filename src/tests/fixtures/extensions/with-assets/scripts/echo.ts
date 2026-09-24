import { z } from "zod";

export const argsSchema = z.object({ label: z.string().optional() });

export default async function echo(args: { label?: string }) {
  return { label: args.label ?? "none" };
}
