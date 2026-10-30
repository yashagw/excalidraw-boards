import { describe, expect, it } from "vitest";
import { cleanFolder, cleanId } from "../server/paths.ts";

describe("cleanId", () => {
  it("normalises slashes, spaces and the extension", () => {
    expect(cleanId(" /Work/ Architecture /")).toBe("Work/Architecture");
    expect(cleanId("Work/Arch.excalidraw")).toBe("Work/Arch");
    expect(cleanId("Ideas 2026/日本語 board")).toBe("Ideas 2026/日本語 board");
  });

  it.each(["", "/", "../etc/passwd", "a/../b", ".hidden", "a/.git", "a\\b", "a:b", 'a"b', "a\u0000b", 42, null])("rejects %j", (bad) => {
    expect(() => cleanId(bad)).toThrow();
  });
});

describe("cleanFolder", () => {
  it("treats empty input as the top level", () => {
    expect(cleanFolder(undefined)).toBe("");
    expect(cleanFolder("")).toBe("");
    expect(cleanFolder("/")).toBe("");
    expect(cleanFolder("Work/")).toBe("Work");
  });
});
