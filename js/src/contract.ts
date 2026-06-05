/**
 * Loads the shared tool contract (contract/tools.json) and adapts it for the JS
 * server. The contract is the single source of truth for tool names,
 * descriptions and input/output schemas; tool registration is driven by it so
 * the JS server cannot drift from the contract (and, via the Python conformance
 * test, from the Python server).
 *
 * The JSON is bundled into the build by `bun build` (JSON import), so the
 * published package carries its own copy.
 */

import { z } from "zod";
// Canonical contract at the repo root. Bun inlines this JSON at build time.
import contractJson from "../../contract/tools.json" with { type: "json" };

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  summary: string;
  input: JsonSchema;
  output: JsonSchema;
}

interface Contract {
  contractVersion: string;
  tools: ToolSpec[];
}

const contract = contractJson as unknown as Contract;

export const contractVersion: string = contract.contractVersion;
export const tools: ToolSpec[] = contract.tools;

export function getTool(name: string): ToolSpec {
  const spec = tools.find((t) => t.name === name);
  if (!spec) throw new Error(`Tool '${name}' not found in contract`);
  return spec;
}

function baseType(type: string | string[] | undefined): { base: string; nullable: boolean } {
  const types = Array.isArray(type) ? type : type ? [type] : [];
  const nullable = types.includes("null");
  const base = types.find((t) => t !== "null") ?? "string";
  return { base, nullable };
}

function zodForProperty(prop: JsonSchema): z.ZodTypeAny {
  const { base, nullable } = baseType(prop.type);
  let schema: z.ZodTypeAny;
  switch (base) {
    case "integer":
      schema = z.number().int();
      break;
    case "number":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    default:
      schema = z.string();
  }
  if (prop.description) schema = schema.describe(prop.description);
  if (nullable) schema = schema.nullable();
  return schema;
}

/**
 * Build the zod raw shape for a tool's arguments from its contract input schema.
 * Required props are mandatory; others get their declared default (or become
 * optional when no default is given).
 */
export function buildInputShape(spec: ToolSpec): z.ZodRawShape {
  const props = spec.input.properties ?? {};
  const required = new Set(spec.input.required ?? []);
  const shape: z.ZodRawShape = {};
  for (const [name, prop] of Object.entries(props)) {
    let schema = zodForProperty(prop);
    if (!required.has(name)) {
      schema = "default" in prop ? schema.default(prop.default as never) : schema.optional();
    }
    shape[name] = schema;
  }
  return shape;
}
