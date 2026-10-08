import { describe, expect, it } from "vitest";
import { connectionDisplayNameForOwner } from "./connection-owner";

describe("connectionDisplayNameForOwner", () => {
  const owner = { label: "Dotta", image: null };

  it("names a personal connection after its owner", () => {
    expect(connectionDisplayNameForOwner({ name: "Notion", config: {} }, "Notion", owner)).toBe("Dotta’s Notion");
  });

  it("does not name a connection every member adds their identity to after its creator", () => {
    expect(connectionDisplayNameForOwner(
      { name: "Personal Mail", config: { memberPersonalIdentities: true } },
      "Personal Mail",
      owner,
    )).toBe("Personal Mail");
  });
});
