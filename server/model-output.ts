type JsonSchema = Record<string, any>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const optionalInOriginal = (parent: JsonSchema, key: string, child: JsonSchema) =>
  !Array.isArray(parent.required) || !parent.required.includes(key) ||
  Object.hasOwn(child, "default");

/** Adapt Zod's schema for strict model output without changing Zod validation. */
export function strictModelOutputSchema(original: JsonSchema): JsonSchema {
  const visit = (node: JsonSchema): JsonSchema => {
    const out: JsonSchema = { ...node };
    delete out.default;
    if (isObject(node.properties)) {
      out.properties = Object.fromEntries(Object.entries(node.properties).map(([key, child]) => {
        const converted = visit(child as JsonSchema);
        return [key, optionalInOriginal(node, key, child as JsonSchema)
          ? { anyOf: [converted, { type: "null" }] } : converted];
      }));
      out.required = Object.keys(node.properties);
      out.additionalProperties = false;
    }
    if (isObject(node.items)) out.items = visit(node.items as JsonSchema);
    for (const keyword of ["anyOf", "oneOf", "allOf"])
      if (Array.isArray(node[keyword])) out[keyword] = node[keyword].map(visit);
    if (isObject(node.$defs))
      out.$defs = Object.fromEntries(Object.entries(node.$defs).map(([key, value]) => [key, visit(value as JsonSchema)]));
    return out;
  };
  return visit(original);
}

/** Remove only provider nulls that stand for originally optional/default keys. */
export function normalizeModelOutput(value: unknown, original: JsonSchema): unknown {
  const resolve = (node: JsonSchema): JsonSchema => {
    if (node.$ref === "#") return original;
    if (typeof node.$ref !== "string" || !node.$ref.startsWith("#/")) return node;
    const parts = node.$ref.slice(2).split("/").map((part) =>
      part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let target: any = original;
    for (const part of parts) target = target?.[part];
    return isObject(target) ? target as JsonSchema : node;
  };
  const visit = (current: unknown, rawNode: JsonSchema): unknown => {
    const node = resolve(rawNode);
    if (Array.isArray(current) && isObject(node.items))
      return current.map((item) => visit(item, node.items as JsonSchema));
    if (isObject(current) && isObject(node.properties)) {
      const next: Record<string, unknown> = { ...current };
      for (const [key, rawChild] of Object.entries(node.properties)) {
        if (!Object.hasOwn(next, key)) continue;
        const child = rawChild as JsonSchema;
        if (next[key] === null && optionalInOriginal(node, key, child)) delete next[key];
        else next[key] = visit(next[key], child);
      }
      return next;
    }
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      const matching = branches.find((branch: JsonSchema) => {
        const candidate = resolve(branch);
        return isObject(current) ? isObject(candidate.properties) :
          Array.isArray(current) ? candidate.type === "array" : false;
      });
      if (matching) return visit(current, matching);
    }
    return current;
  };
  return visit(value, original);
}
