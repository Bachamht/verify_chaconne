import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn keeps the project's custom font sizes", () => {
  it("text-kpi / text-title / text-display / text-md survive a later text color", () => {
    for (const size of ["text-kpi", "text-title", "text-display", "text-md"]) {
      expect(cn(size, "text-fg-1").split(" ")).toEqual([size, "text-fg-1"]);
    }
  });
  it("two font sizes still merge (later wins)", () => {
    expect(cn("text-kpi", "text-sm")).toBe("text-sm");
    expect(cn("text-sm", "sm:text-display", "text-title")).toBe("sm:text-display text-title");
  });
  it("two colors still merge", () => {
    expect(cn("text-fg-1", "text-warn")).toBe("text-warn");
  });
});
