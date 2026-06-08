import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { insertBehavior } from "./behaviors.js";
import { behaviorIdsForPath, insertArea, listAreas, matchesGlob } from "./areas.js";

describe("matchesGlob", () => {
  it("* stays within a path segment", () => {
    expect(matchesGlob("checkout/*.ts", "checkout/page.ts")).toBe(true);
    expect(matchesGlob("checkout/*.ts", "checkout/sub/page.ts")).toBe(false);
  });

  it("** crosses segments", () => {
    expect(matchesGlob("checkout/**/*.ts", "checkout/sub/deep/page.ts")).toBe(true);
    expect(matchesGlob("checkout/**/*.ts", "checkout/page.ts")).toBe(true);
  });

  it("? matches one non-separator char", () => {
    expect(matchesGlob("v?.ts", "v1.ts")).toBe(true);
    expect(matchesGlob("v?.ts", "v12.ts")).toBe(false);
  });

  it("is anchored (whole path) and normalizes backslashes", () => {
    expect(matchesGlob("checkout/*.ts", "src/checkout/page.ts")).toBe(false);
    expect(matchesGlob("checkout/*.ts", "checkout\\page.ts")).toBe(true);
  });

  it("treats glob metachars literally outside *?", () => {
    expect(matchesGlob("a.b.ts", "axbxts")).toBe(false);
    expect(matchesGlob("a.b.ts", "a.b.ts")).toBe(true);
  });

  it("{a,b} brace expansion matches any arm", () => {
    expect(matchesGlob("src/{foo,bar}.ts", "src/foo.ts")).toBe(true);
    expect(matchesGlob("src/{foo,bar}.ts", "src/bar.ts")).toBe(true);
    expect(matchesGlob("src/{foo,bar}.ts", "src/baz.ts")).toBe(false);
  });

  it("leading ! negates the pattern", () => {
    expect(matchesGlob("!checkout/*.ts", "checkout/page.ts")).toBe(false);
    expect(matchesGlob("!checkout/*.ts", "payment/page.ts")).toBe(true);
  });
});

describe("behaviorIdsForPath", () => {
  it("unions matching areas and dedups, empty when nothing matches", () => {
    const db = openDb(":memory:");
    const b1 = insertBehavior(db, { name: "Checkout", description: "", criticality: "P0" });
    const b2 = insertBehavior(db, { name: "Payment", description: "", criticality: "P1" });
    insertArea(db, { file_pattern: "checkout/**/*.ts", behavior_ids: [b1] });
    insertArea(db, { file_pattern: "**/*.ts", behavior_ids: [b1, b2] }); // overlaps on b1

    expect(behaviorIdsForPath(db, "checkout/sub/page.ts").sort()).toEqual([b1, b2].sort());
    expect(behaviorIdsForPath(db, "README.md")).toEqual([]);
  });

  it("listAreas returns what was inserted", () => {
    const db = openDb(":memory:");
    const b1 = insertBehavior(db, { name: "X", description: "", criticality: "P2" });
    insertArea(db, { file_pattern: "x/*.ts", behavior_ids: [b1], notes: "note" });
    const areas = listAreas(db);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.file_pattern).toBe("x/*.ts");
    expect(areas[0]?.behavior_ids).toEqual([b1]);
  });
});
