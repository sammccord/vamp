import { describe, expect, it } from "vite-plus/test";
import {
  extractMessageBody,
  parseEntityMessage,
  parseMessage,
} from "../src/generators/parse-bop-source.js";

const ENTITY_SOURCE = `import "../node_modules/@vamp/utils/schema/pool.bop"
import "./tags.bop"

message Entity {
\t1 -> guid id;
\t2 -> guid sk;
\t3 -> Tags[] tags;
\t4 -> guid parent;
\t5 -> guid[] children;
\t6 -> Pool health;
}
`;

describe("parseEntityMessage", () => {
  it("parses all Entity fields with indices", () => {
    const entity = parseEntityMessage(ENTITY_SOURCE);
    expect(entity.name).toBe("Entity");
    expect(entity.fields.map((f) => f.name)).toEqual([
      "id",
      "sk",
      "tags",
      "parent",
      "children",
      "health",
    ]);
    expect(entity.fields.map((f) => f.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("classifies scalar fields", () => {
    const entity = parseEntityMessage(ENTITY_SOURCE);
    const id = entity.fields.find((f) => f.name === "id")!;
    expect(id.typeName).toBe("guid");
    expect(id.isScalar).toBe(true);
    expect(id.isArray).toBe(false);
  });

  it("classifies scalar arrays with member type", () => {
    const entity = parseEntityMessage(ENTITY_SOURCE);
    const children = entity.fields.find((f) => f.name === "children")!;
    expect(children.isArray).toBe(true);
    expect(children.memberType).toBe("guid");
    expect(children.isScalar).toBe(true);
  });

  it("classifies custom (non-scalar) message arrays", () => {
    const entity = parseEntityMessage(ENTITY_SOURCE);
    const tags = entity.fields.find((f) => f.name === "tags")!;
    expect(tags.isArray).toBe(true);
    expect(tags.memberType).toBe("Tags");
    expect(tags.isScalar).toBe(false);
  });

  it("classifies custom message fields", () => {
    const entity = parseEntityMessage(ENTITY_SOURCE);
    const health = entity.fields.find((f) => f.name === "health")!;
    expect(health.typeName).toBe("Pool");
    expect(health.isScalar).toBe(false);
    expect(health.isArray).toBe(false);
    expect(health.isMap).toBe(false);
  });

  it("throws when no Entity message present", () => {
    expect(() => parseEntityMessage("message Other { 1 -> guid id; }")).toThrow();
  });
});

describe("parseMessage", () => {
  it("parses map fields", () => {
    const source = `message Scope { 1 -> map[guid, Entity] entities; }`;
    const scope = parseMessage(source, "Scope")!;
    const field = scope.fields[0];
    expect(field.isMap).toBe(true);
    expect(field.keyType).toBe("guid");
    expect(field.valueType).toBe("Entity");
  });

  it("ignores commented-out fields", () => {
    const source = `message M {
      1 -> guid id;
      // 2 -> guid ignored;
      3 -> string name;
    }`;
    const m = parseMessage(source, "M")!;
    expect(m.fields.map((f) => f.name)).toEqual(["id", "name"]);
  });

  it("returns null for a missing message", () => {
    expect(parseMessage("message A { 1 -> guid id; }", "B")).toBeNull();
  });
});

describe("extractMessageBody", () => {
  it("returns the inner body of a message", () => {
    const body = extractMessageBody("message A { 1 -> guid id; }", "A")!;
    expect(body.trim()).toBe("1 -> guid id;");
  });
});
