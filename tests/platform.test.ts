import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { userHome } from "../src/platform.js";

describe("userHome", () => {
  it("prefers USERPROFILE on Windows", () => {
    expect(userHome({ USERPROFILE: "/windows", HOME: "/posix" }, "win32")).toBe(
      resolve("/windows"),
    );
  });

  it("prefers HOME on POSIX", () => {
    expect(userHome({ USERPROFILE: "/windows", HOME: "/posix" }, "linux")).toBe(resolve("/posix"));
  });
});
