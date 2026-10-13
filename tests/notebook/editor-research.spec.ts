import { test, expect, type Page } from "@playwright/test";
test.setTimeout(90000);
const boot = async (
  page: Page,
  content = "# Research\n\nA **bold** idea.\n\n- [ ] Check evidence\n",
) => {
  await page.goto("/tests/notebook/app-harness.html?view=editor&research");
  await expect(page.locator(".sidebar")).toBeVisible({ timeout: 45000 });
  await page.evaluate((text) => {
    (window as any).fixtureNoteContents["/vault/Loose.md"] = text;
  }, content);
  await page.locator('[data-note-path="/vault/Loose.md"]').click();
  await expect(
    page.locator('[data-region="editor"] .cm-content'),
  ).toContainText(content.split("\n")[0].replace(/^#+\s*/, ""));
};
test("live/source/read preserve edits and undo; properties use the editor save path", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await boot(page);
  const editor = page.locator('[data-region="editor"]');
  await expect(
    editor.getByRole("button", { name: "Live", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await editor.getByRole("button", { name: "Source", exact: true }).click();
  const cm = editor.locator(".cm-content");
  await cm.fill("# Research\n\nChanged content.");
  await editor.getByRole("button", { name: "Read", exact: true }).click();
  await expect(editor.locator(".rich-markdown")).toContainText(
    "Changed content.",
  );
  await editor.getByRole("button", { name: "Live", exact: true }).click();
  await cm.press("Control+z");
  await expect(cm).toContainText("Check evidence");
  await editor.locator(".note-properties summary").click();
  await editor.getByLabel("Tags", { exact: true }).fill("science\nதமிழ்");
  await editor.getByLabel("Status", { exact: true }).click();
  await expect(cm).toContainText("science");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).fixtureNoteContents["/vault/Loose.md"],
      ),
    )
    .toContain("science");
  await editor.getByRole("button", { name: "Source", exact: true }).click();
  await cm.press("Control+z");
  await expect(cm).not.toContainText("tags:");
  expect(errors).toEqual([]);
});
test("read renders tables, nested lists, literal code and safe note embeds", async ({
  page,
}) => {
  await boot(
    page,
    "# Research\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- Outer\n  - Inner\n\n```txt\n[[Literal]]\n```\n\n[[Loose]]\n\n![[Loose]]\n\n![remote](https://example.invalid/image.png)\n",
  );
  const editor = page.locator('[data-region="editor"]');
  await editor.getByRole("button", { name: "Read", exact: true }).click();
  await expect(editor.locator("table")).toHaveCount(2);
  await expect(editor.locator("pre").first()).toContainText("[[Literal]]");
  await expect(editor.locator("ul ul").first()).toContainText("Inner");
  await expect(editor.locator(".embedded-note")).toHaveCount(1);
  await expect(
    editor.getByRole("button", { name: "Load remote media: remote" }).first(),
  ).toBeVisible();
  await editor.locator(".note-link-trigger").first().focus();
  await expect(
    page.getByRole("group", { name: "Preview of Loose" }).first(),
  ).toContainText("Research");
});
test("PDF point comments save, reopen, rotate and insert a durable quote link", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await boot(page);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("prism-open-pdf", { detail: {} })),
  );
  const reader = page.getByRole("region", { name: "PDF reader" });
  await expect(reader.locator(".textLayer").first()).toContainText(
    "Research evidence",
    { timeout: 15000 },
  );
  await reader
    .getByRole("button", { name: "Add point comment", exact: true })
    .click();
  await reader
    .locator('[data-pdf-page="1"]')
    .click({ position: { x: 100, y: 150 } });
  await reader.getByLabel("Comment on page 1").fill("Useful evidence");
  await reader
    .getByRole("button", { name: "Save annotations", exact: true })
    .click();
  await expect(reader.getByRole("status")).toHaveText("Annotations saved");
  await reader.getByRole("button", { name: "Rotate", exact: true }).click();
  await expect(reader.locator(".pdf-comment-dot")).toHaveCount(1);
  await reader.getByRole("button", { name: "Insert quote into note" }).click();
  await reader.getByRole("button", { name: "Close PDF", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("prism-pdf:");
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("prism-open-pdf", {
        detail: { documentId: "a".repeat(64), page: 1 },
      }),
    ),
  );
  await expect(page.getByLabel("Comment on page 1")).toHaveValue(
    "Useful evidence",
  );
  expect(errors).toEqual([]);
});
test("PDF highlights capture text; save conflicts retain the draft", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("prism-open-pdf", { detail: {} })),
  );
  const reader = page.getByRole("region", { name: "PDF reader" });
  const layer = reader.locator(".textLayer").first();
  await expect(layer).toContainText("Research evidence", { timeout: 15000 });
  await layer.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await reader
    .getByRole("button", { name: "Highlight selection", exact: true })
    .click();
  await expect(reader.locator(".pdf-mark")).not.toHaveCount(0);
  await page.evaluate(() => {
    (window as any).fixtureAnnotationConflict = true;
  });
  await reader
    .getByRole("button", { name: "Save annotations", exact: true })
    .click();
  await expect(reader.getByRole("alert")).toContainText("CONFLICT");
  await expect(reader.getByRole("status")).toHaveText("Unsaved annotations");
  await expect(reader.locator(".pdf-mark")).not.toHaveCount(0);
});

const openReader = async (page: Page) => {
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("prism-open-pdf", {
        detail: { documentId: "a".repeat(64) },
      }),
    ),
  );
  const reader = page.getByRole("region", { name: "PDF reader" });
  await expect(reader.locator(".textLayer").first()).toContainText(
    "Research evidence",
    { timeout: 15000 },
  );
  return reader;
};
const pointComment = async (page: Page, comment: string) => {
  const reader = page.getByRole("region", { name: "PDF reader" });
  await reader
    .getByRole("button", { name: "Add point comment", exact: true })
    .click();
  await reader
    .locator('[data-pdf-page="1"]')
    .click({ position: { x: 100, y: 150 } });
  await reader.getByLabel("Comment on page 1").fill(comment);
};
const draft = (page: Page) =>
  page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith("prism_pdf_draft:"),
    );
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  });

test("PDF cancel preserves recovery; mouse-confirmed discard removes it on reopening", async ({
  page,
}) => {
  await boot(page);
  const reader = await openReader(page);
  await pointComment(page, "Recover me");
  await reader.getByRole("button", { name: "Close PDF" }).click();
  await expect(page.locator(".pdf-reader")).toHaveAttribute("inert", "");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(reader.getByLabel("Comment on page 1")).toHaveValue(
    "Recover me",
  );
  expect((await draft(page)).entries[0].comment).toBe("Recover me");
  await boot(page);
  await openReader(page);
  await expect(reader.getByLabel("Comment on page 1")).toHaveValue(
    "Recover me",
  );
  await reader.getByRole("button", { name: "Close PDF" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "OK", exact: true })
    .click();
  await expect(reader).toHaveCount(0);
  expect(await draft(page)).toBeNull();
  await openReader(page);
  await expect(reader.getByText("No annotations yet.")).toBeVisible();
});

test("PDF edits during save retain newer text and advance recovery revision", async ({
  page,
}) => {
  await boot(page);
  const reader = await openReader(page);
  await pointComment(page, "First revision");
  await page.evaluate(() => {
    (window as any).fixtureDelayAnnotationSave = true;
  });
  await reader
    .getByRole("button", { name: "Save annotations", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).fixtureFinishAnnotationSave),
    )
    .toBe("function");
  await reader.getByLabel("Comment on page 1").fill("Newer revision");
  await page.evaluate(() => {
    (window as any).fixtureFinishAnnotationSave();
  });
  await expect(
    reader.getByRole("button", { name: "Save annotations", exact: true }),
  ).toBeEnabled();
  await expect.poll(async () => (await draft(page))?.revision).toBe(1);
  expect((await draft(page)).entries[0].comment).toBe("Newer revision");
  await boot(page);
  await openReader(page);
  await expect(reader.getByLabel("Comment on page 1")).toHaveValue(
    "Newer revision",
  );
  await reader
    .getByRole("button", { name: "Save annotations", exact: true })
    .click();
  await expect(reader.getByRole("status")).toHaveText("Annotations saved");
  expect(await draft(page)).toBeNull();
});

test("Live tasks autosave and undo; self embeds refresh; local media resolves fragments", async ({
  page,
}) => {
  await boot(
    page,
    "# Original\n\n- [ ] Verify\n\n![[Loose]]\n\n![Local](../attachments/research.png#preview)\n",
  );
  const editor = page.locator('[data-region="editor"]');
  const task = editor.getByRole("checkbox", { name: "Toggle task" });
  await expect(task).toBeVisible();
  await task.check();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).fixtureNoteContents["/vault/Loose.md"],
      ),
    )
    .toContain("- [x] Verify");
  await editor.locator(".cm-content").press("Control+z");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).fixtureNoteContents["/vault/Loose.md"],
      ),
    )
    .toContain("- [ ] Verify");
  await editor.locator(".cm-content").press("Control+Home");
  await editor.locator(".cm-content").press("End");
  await page.keyboard.type(" revised");
  await expect(editor.locator(".embedded-note")).toContainText(
    "Original revised",
  );
  await expect(editor.locator(".embedded-note")).toHaveCount(1);
  await expect
    .poll(() =>
      editor
        .locator('img[alt="Local"]')
        .first()
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() =>
      (window as any).fixtureCalls
        .filter((c: any) => c.command === "research_asset")
        .every((c: any) => c.args.target === "../attachments/research.png"),
    ),
  ).toBe(true);
});

test("note preview keyboard entry and Escape restore trigger focus", async ({
  page,
}) => {
  await boot(page, "# Research\n\n[[Loose]]\n");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  const trigger = page
    .locator('[data-region="editor"] .note-link-trigger')
    .first();
  await trigger.focus();
  await trigger.press("ArrowDown");
  const popup = page.getByRole("group", { name: "Preview of Loose" });
  await expect(popup.getByRole("button", { name: "Open note" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

for (const theme of ["industrial", "glass", "gloss"])
  for (const mode of ["light", "dark"]) {
    test(`editor and PDF controls in ${theme} ${mode} at narrow width`, async ({
      page,
    }) => {
      await page.goto(
        `/tests/notebook/app-harness.html?theme=${theme}&mode=${mode}&view=editor&research`,
      );
      await expect(page.locator(".sidebar")).toBeVisible({ timeout: 45000 });
      await page.locator('[data-note-path="/vault/Loose.md"]').click();
      await page
        .getByRole("button", { name: "AI assistant", exact: true })
        .click();
      await page.setViewportSize({ width: 720, height: 900 });
      await page.getByRole("button", { name: "Source", exact: true }).click();
      await page.getByRole("button", { name: "Live", exact: true }).click();
      const reader = await openReader(page);
      await reader
        .getByRole("button", { name: "Zoom in", exact: true })
        .click();
      await reader.getByRole("button", { name: "Rotate", exact: true }).click();
      await reader
        .getByRole("button", { name: "Next page", exact: true })
        .click();
      await expect(
        reader.getByRole("spinbutton", { name: "Page", exact: true }),
      ).toHaveValue("2");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await reader.getByRole("button", { name: "Close PDF" }).click();
    });
  }

test("invalid PDF recovery remains downloadable and can be explicitly cleared", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() =>
    localStorage.setItem(
      `prism_pdf_draft:${encodeURIComponent("/vault")}:${"a".repeat(64)}`,
      JSON.stringify({
        version: 1,
        documentId: "a".repeat(64),
        revision: 0,
        entries: [{ id: "broken", page: 1 }],
      }),
    ),
  );
  const reader = await openReader(page);
  await expect(reader.getByRole("alert")).toContainText(
    "recovery draft is invalid",
  );
  await expect(reader.getByText("No annotations yet.")).toBeVisible();
  await expect(
    reader.getByRole("button", { name: "Download unsaved draft" }),
  ).toBeVisible();
  expect(await draft(page)).not.toBeNull();
  await reader
    .getByRole("button", { name: "Reload saved annotations" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "OK", exact: true })
    .click();
  await expect(reader.getByRole("status")).toHaveText("Annotations saved");
  expect(await draft(page)).toBeNull();
});

test("PDF relinking does not leak into a later reload", async ({ page }) => {
  await boot(page);
  const reader = await openReader(page);
  await pointComment(page, "Draft");
  await page.evaluate(() => {
    (window as any).fixtureAnnotationConflict = true;
  });
  await reader
    .getByRole("button", { name: "Save annotations", exact: true })
    .click();
  await expect(reader.getByRole("alert")).toContainText("CONFLICT");
  await reader.getByRole("button", { name: "Relink identical PDF" }).click();
  await expect(reader.getByRole("alert")).toContainText("Recovered unsaved");
  await reader
    .getByRole("button", { name: "Reload saved annotations" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "OK", exact: true })
    .click();
  await expect(reader.getByRole("status")).toHaveText("Annotations saved");
  expect(
    await page.evaluate(() =>
      (window as any).fixtureCalls
        .filter((c: any) => c.command === "research_open_pdf")
        .map((c: any) => c.args.relink),
    ),
  ).toEqual([false, true, false]);
});
