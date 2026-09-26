import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "../../api/types";

mock.module("@/components/ui/tooltip", () => import("../ui/tooltip"));
mock.module("@/lib/utils", () => import("../../lib/utils"));

const { TooltipProvider } = await import("../ui/tooltip");
const { UserChip, userInitials } = await import("./user-chip");

const taras = {
  id: "4dacc65cdab044a6805b2aa0342331b7",
  name: "Taras Yarema",
  email: "t@desplega.ai",
  emailAliases: [],
  preferredChannel: "slack",
} as User;

function render(userRef: string, user?: User) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UserChip userRef={userRef} user={user} />
    </TooltipProvider>,
  );
}

describe("UserChip", () => {
  test("initials take the first letters of the first two words", () => {
    expect(userInitials("Taras Yarema")).toBe("TY");
    expect(userInitials("picateclas")).toBe("PI");
    expect(userInitials("  ")).toBe("?");
  });

  test("a known user shows name and avatar, not the raw ID", () => {
    const html = render(taras.id, taras);
    expect(html).toContain("Taras Yarema");
    expect(html).toContain(">TY<");
    expect(html).not.toContain(`>${taras.id}<`);
    expect(html).toContain(`Copy ID ${taras.id}`);
  });

  test("an unknown reference renders as stored, so nothing is hidden", () => {
    const html = render("someone@example.com");
    expect(html).toContain("someone@example.com");
    expect(html).toContain(">?<");
  });
});
