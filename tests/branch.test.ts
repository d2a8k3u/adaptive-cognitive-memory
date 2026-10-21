import { describe, expect, it } from "vitest";
import { ticketId } from "../src/branch";

describe("ticketId", () => {
  it.each([
    { branch: "fix/TOUCH-4945/guide-list-search", ticket: "TOUCH-4945" },
    { branch: "fix/touch-4945-x", ticket: "TOUCH-4945" },
    { branch: "main", ticket: undefined },
    { branch: "HEAD", ticket: undefined },
    { branch: "feature/no-ticket", ticket: undefined },
    { branch: "fix/ABC-1/DEF-2", ticket: "ABC-1" },
    { branch: "fix/AB-1", ticket: "AB-1" },
    { branch: "fix/A-1", ticket: undefined },
    { branch: "fix/ABCDEFGHIJ-123456", ticket: "ABCDEFGHIJ-123456" },
    { branch: "fix/ABCDEFGHIJK-1", ticket: undefined },
    { branch: "fix/TOUCH-1234567", ticket: undefined },
    { branch: "feature_TOUCH-4945", ticket: "TOUCH-4945" },
    { branch: "release-2026", ticket: "RELEASE-2026" },
  ])("reads the ticket $ticket from the branch $branch", ({ branch, ticket }) => {
    expect(ticketId(branch)).toBe(ticket);
  });
});
