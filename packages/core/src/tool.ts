import { z } from "zod";
import type { ToolSpec } from "./types.js";

/** read: no side effects. write: changes files. exec: runs arbitrary commands. */
export type Risk = "read" | "write" | "exec";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  risk: Risk;
  run(input: z.infer<S>, ctx: ToolContext): Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

export function toSpec(tool: AnyTool): ToolSpec {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema: schema };
}
