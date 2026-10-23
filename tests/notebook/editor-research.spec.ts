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
  // `fill` on CodeMirror can land as one history group or as select-all +
  // insert (two groups) depending on timing. Undo until the original text is
  // back instead of assuming a fixed number of steps.
  for (let i = 0; i < 3; i++) {
    if ((await cm.innerText()).includes("Check evidence")) break;
    await cm.press("Control+z");
  }
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

test("PDF open survives a delayed reader module", async ({ page }) => {
  let releaseModule!: () => void;
  const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
  let requested = false;
  await page.route('**/src/components/editor/PdfReader.tsx*', async route => {
    requested = true;
    await moduleGate;
    await route.continue();
  });
  try {
    await boot(page);
    // The editor is usable while the PDF module is still in flight. Opening
    // must retain the request rather than dispatch to a missing listener.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('prism-open-pdf', {
      detail: { documentId: 'a'.repeat(64) },
    })));
    await expect.poll(() => requested).toBe(true);
    releaseModule();
    const reader = page.getByRole('region', { name: 'PDF reader' });
    await expect(reader.locator('.textLayer').first()).toContainText('Research evidence', { timeout: 15000 });
  } finally {
    releaseModule();
    await page.unrouteAll({ behavior: 'wait' });
  }
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
      const editor = page.locator('[data-region="editor"]');
      const radius = theme === "industrial" ? 0 : theme === "glass" ? 10 : 12;
      // Selected ink must always accompany its intended accent fill.
      for (const selector of ['.editor-mode-group button[aria-pressed="true"]', '.linkhub-tabs button[aria-selected="true"]']) {
        const selected = editor.locator(selector);
        if (await selected.count()) {
          expect(await selected.evaluate(el => {
            const probe = document.createElement('span');
            probe.style.backgroundColor = 'var(--nb-selected-bg)';
            probe.style.color = 'var(--nb-selected-ink)';
            el.append(probe);
            const expected = getComputedStyle(probe);
            const actual = getComputedStyle(el);
            const matches = actual.backgroundColor === expected.backgroundColor && actual.color === expected.color;
            probe.remove();
            return matches;
          })).toBe(true);
        }
      }

      for (const menu of [".editor-format", ".editor-overflow"]) {
        await editor.locator(`${menu} > summary`).click();
        const surface = editor.locator(`${menu} > div`);
        await expect(surface).toBeVisible();
        const menuBounds = await surface.boundingBox();
        const editorBounds = await editor.boundingBox();
        expect(menuBounds!.x).toBeGreaterThanOrEqual(editorBounds!.x);
        expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(720);
        expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(900);
        expect(await surface.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBe(radius);
        expect(await surface.evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/);
        await expect(surface.getByText(/Move to folder/i)).toHaveCount(0);
        if (menu === ".editor-overflow") {
          await page.screenshot({ path: `/tmp/prism-tools-${theme}-${mode}.png` });
          await surface.getByRole("button", { name: "Tools", exact: true }).click();
          expect(await surface.locator('.editor-menu').evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBe(radius);
          await surface.getByRole("button", { name: "Tools", exact: true }).click();
        }
        await editor.locator(`${menu} > summary`).click();
      }
      await editor.locator('.cm-content').fill('Evidence evidence EVIDENCE');
      await editor.getByRole('button', { name: 'Find', exact: true }).click();
      const find = editor.getByRole('search', { name: 'Find in note' });
      const query = find.getByRole('textbox', { name: 'Find in note' });
      await query.fill('evidence');
      await expect(find.locator('.editor-find-count')).toHaveText('1/3');
      await query.press('Enter');
      await expect(find.locator('.editor-find-count')).toHaveText('2/3');
      await query.press('Shift+Enter');
      await expect(find.locator('.editor-find-count')).toHaveText('1/3');
      await find.getByRole('button', { name: 'Match case', exact: true }).click();
      await expect(find.locator('.editor-find-count')).toHaveText('1/1');
      const caseButton = find.getByRole('button', { name: 'Match case', exact: true });
      await expect.poll(() => caseButton.evaluate(el => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--nb-selected-bg)';
        el.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return getComputedStyle(el).backgroundColor === expected;
      })).toBe(true);
      expect(await find.evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/);
      expect(await find.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBe(radius);
      const bounds = await find.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720);
      await page.screenshot({ path: `/tmp/prism-find-${theme}-${mode}.png` });
      await query.press('Escape');
      await expect(find).toHaveCount(0);
      await page.getByRole("button", { name: "Source", exact: true }).click();
      await page.getByRole("button", { name: "Live", exact: true }).click();
      const reader = await openReader(page);
      expect(await reader.evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/);
      const commentButton = reader.getByRole('button', { name: 'Add point comment', exact: true });
      for (const pressed of [false, true]) {
        if (pressed) await commentButton.click();
        expect(await commentButton.evaluate(el => {
          const style = getComputedStyle(el);
          const luminance = (color: string) => {
            const components = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(n => {
              const value = n / 255;
              return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
            });
            return components[0] * .2126 + components[1] * .7152 + components[2] * .0722;
          };
          const ink = luminance(style.color), fill = luminance(style.backgroundColor);
          return (Math.max(ink, fill) + .05) / (Math.min(ink, fill) + .05);
        })).toBeGreaterThanOrEqual(4.5);
      }

      expect(await reader.locator('.pdf-page').first().evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBe(0);
      await reader.getByRole('textbox', { name: 'Find in PDF' }).fill('Research');
      await reader.getByRole('button', { name: 'Search PDF', exact: true }).click();
      await expect(reader.getByRole('button', { name: 'Page 1', exact: true })).toBeVisible();
      await page.screenshot({ path: `/tmp/prism-pdf-${theme}-${mode}.png` });

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
  // The confirm closes after the exit animation; poll so the reload's
  // draft cleanup lands before asserting.
  await expect.poll(() => draft(page)).toBeNull();
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
  // The reload re-open is an async effect: the status flips synchronously on
  // setDirty(false) while research.open lands a tick later. Poll instead of
  // asserting immediately so parallel-worker load can't win the race.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).fixtureCalls
          .filter((c: any) => c.command === "research_open_pdf")
          .map((c: any) => c.args.relink),
      ),
    )
    .toEqual([false, true, false]);
});

test("PDF icons, palette, scrolling and collapsed drafts remain usable", async ({ page }) => {
  await boot(page);
  const reader = await openReader(page);
  for (const name of ["Zoom in", "Zoom out", "Rotate", "Search PDF", "Close PDF"]) {
    const button = reader.getByRole("button", { name, exact: true });
    await expect(button.locator("svg")).toBeVisible();
    await expect(button).toHaveAttribute("title", name);
  }
  await reader.getByRole("button", { name: "Highlight color: yellow", exact: true }).click();
  await reader.getByRole("button", { name: "pink", exact: true }).click();
  await expect(reader.getByRole("button", { name: "Highlight color: pink", exact: true })).toBeVisible();
  await pointComment(page, "Unsaved comment that must survive collapsing");
  const toggle = reader.getByRole("button", { name: /Annotations \(1\)/ });
  await toggle.click();
  await expect(reader.getByRole("complementary", { name: "Annotations" })).toBeHidden();
  await toggle.click();
  await expect(reader.getByLabel("Comment on page 1")).toHaveValue("Unsaved comment that must survive collapsing");
  await reader.getByRole("button", { name: "Annotation color on page 1: pink" }).click();
  await reader.getByRole("button", { name: "blue", exact: true }).click();
  await expect(reader.getByRole("button", { name: "Annotation color on page 1: blue" })).toBeVisible();
  await reader.locator('.pdf-pages').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(reader.getByRole("spinbutton", { name: "Page", exact: true })).toHaveValue("2");
  await reader.locator('.pdf-pages').evaluate(el => { el.scrollTop = 0; });
  await expect(reader.getByRole("spinbutton", { name: "Page", exact: true })).toHaveValue("1");
  await reader.getByRole("button", { name: "Close PDF", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Discard unsaved PDF annotations?");
});

test("long annotation headings wrap without truncation or horizontal overflow", async ({ page }) => {
  await boot(page);
  const text = "A long research excerpt " + "unbroken".repeat(45);
  await page.evaluate(text => {
    localStorage.setItem(`prism_pdf_draft:${encodeURIComponent('/vault')}:${'a'.repeat(64)}`, JSON.stringify({
      version: 1, documentId: 'a'.repeat(64), revision: 0,
      entries: [{ id: 'long', page: 1, rects: [[10, 10, 30, 30]], text, comment: 'Comment', color: 'yellow', createdAt: Date.now(), updatedAt: Date.now() }],
    }));
  }, text);
  const reader = await openReader(page);
  const heading = reader.locator('.pdf-annotation-heading');
  await expect(heading).toContainText(text);
  expect(await heading.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await reader.locator('.pdf-annotations').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

for (const theme of ['industrial', 'glass', 'gloss']) {
  for (const mode of ['light', 'dark']) {
    test(`PDF annotation colors and shapes in ${theme} ${mode}`, async ({ page }) => {
      await page.goto(`/tests/notebook/app-harness.html?theme=${theme}&mode=${mode}&view=editor&research`);
      await expect(page.locator('.sidebar')).toBeVisible({ timeout: 45000 });
      await page.evaluate((text) => {
        (window as any).fixtureNoteContents["/vault/Loose.md"] = text;
      }, "# Research\n\nA **bold** idea.\n");
      const note = page.locator('[data-note-path="/vault/Loose.md"]');
      await expect(note).toBeVisible({ timeout: 45000 });
      await note.click();
      await expect(
        page.locator('[data-region="editor"] .cm-content'),
      ).toContainText("Research", { timeout: 45000 });
      await page.evaluate(() => {
        localStorage.setItem(`prism_pdf_draft:${encodeURIComponent('/vault')}:${'a'.repeat(64)}`, JSON.stringify({
          version: 1, documentId: 'a'.repeat(64), revision: 0,
          entries: [{ id: 'color-test', page: 1, rects: [[70, 710, 230, 728]], text: 'A long selected excerpt with multiple lines of research evidence. '.repeat(5), comment: 'Evidence', color: 'yellow', createdAt: Date.now(), updatedAt: Date.now() }],
        }));
      });
      const reader = await openReader(page);
      const heading = reader.locator('.pdf-annotation-heading');
      await expect(heading).toBeVisible({ timeout: 15000 });
      await heading.click();
      const mark = reader.locator('.pdf-mark').first();
      await expect(mark).toHaveAttribute('data-selected', 'true');
      await expect(mark).toHaveCSS('outline-style', 'none');
      await expect(mark).toHaveCSS('background-color', 'rgb(245, 212, 66)');
      await expect(heading).toHaveCSS('border-top-width', '0px');
      for (const control of [heading, reader.getByLabel('Comment on page 1')]) {
        expect(await control.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeLessThanOrEqual(12);
        expect(await control.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      const picker = reader.getByRole('button', { name: 'Annotation color on page 1: yellow', exact: true });
      const swatch = picker.locator('.pdf-color-swatch');
      expect((await swatch.boundingBox())!.width).toBeGreaterThanOrEqual(18);
      expect((await swatch.boundingBox())!.height).toBeGreaterThanOrEqual(18);
      await expect(swatch).toHaveCSS('background-color', 'rgb(245, 212, 66)');
      await picker.click();
      const blue = reader.getByRole('button', { name: 'blue', exact: true });
      expect((await blue.locator('.pdf-color-swatch').boundingBox())!.width).toBeGreaterThanOrEqual(18);
      await blue.click();
      await expect(mark).toHaveCSS('background-color', 'rgb(101, 168, 245)');
      await expect(reader.getByRole('button', { name: 'Annotation color on page 1: blue', exact: true }).locator('.pdf-color-swatch')).toHaveCSS('background-color', 'rgb(101, 168, 245)');
      // Keyboard focus must remain visible even though marks have none.
      // Industrial uses outline; glass/gloss use a box-shadow ring.
      await heading.focus();
      await page.keyboard.press('Tab');
      await expect(reader.getByLabel('Comment on page 1')).toBeFocused();
      await expect.poll(async () => await reader.getByLabel('Comment on page 1').evaluate(el => {
        const style = getComputedStyle(el);
        return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
      })).toBe(true);
      if (theme === 'gloss' && mode === 'dark') await page.screenshot({ path: '/tmp/prism-pdf-annotation-fix.png' });
    });
  }
}
