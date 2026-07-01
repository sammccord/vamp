import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { loadSchemaFromFile, parseSchema } from "../src/generators/parse-bop.js";

describe("parseSchema", () => {
  it("parses BEBOP_SCHEMA from packages/utils/src/bebop.ts", () => {
    const bebopTsPath = resolve(__dirname, "../../../packages/utils/src/bebop.ts");
    const bytes = loadSchemaFromFile(bebopTsPath);
    const schema = parseSchema(bytes);

    // Should find Error (struct) and Message (message) definitions
    expect(schema.definitions.has("Error")).toBe(true);
    expect(schema.definitions.has("Message")).toBe(true);

    const error = schema.definitions.get("Error")!;
    expect(error.kind).toBe("struct");
    expect(error.fields.map((f) => f.name)).toContain("code");
    expect(error.fields.map((f) => f.name)).toContain("tag");

    const message = schema.definitions.get("Message")!;
    expect(message.kind).toBe("message");
    expect(message.fields.map((f) => f.name)).toContain("methodId");
    expect(message.fields.map((f) => f.name)).toContain("messageId");
  });

  it("resolves scalar type names correctly", () => {
    const bebopTsPath = resolve(__dirname, "../../../packages/utils/src/bebop.ts");
    const bytes = loadSchemaFromFile(bebopTsPath);
    const schema = parseSchema(bytes);

    const error = schema.definitions.get("Error")!;
    const codeField = error.fields.find((f) => f.name === "code")!;
    expect(codeField.typeName).toBe("uint32");
    expect(codeField.isArray).toBe(false);

    const tagField = error.fields.find((f) => f.name === "tag")!;
    expect(tagField.typeName).toBe("string");
  });

  it("extracts BEBOP_SCHEMA bytes from generated TS", () => {
    const bebopTsPath = resolve(__dirname, "../../../packages/utils/src/bebop.ts");
    const bytes = loadSchemaFromFile(bebopTsPath);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
