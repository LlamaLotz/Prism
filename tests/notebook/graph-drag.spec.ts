import { test, expect, type Page } from '@playwright/test';

// Regression coverage for "a dragged node must bring the nodes connected to it
// along": dragging used to move the grabbed node alone while its neighbourhood
// stayed behind on a slack link spring.
const url = '/tests/notebook/graph-harness.html';

const center = async (page: Page, id: string) => {
  const box = await page.locator(`g.nodes > g[data-node-id="${id}"] circle.node-circle`).boundingBox();
  if (!box) throw new Error(`node ${id} is not rendered`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Presses on `from`, drags it by (dx, dy) and holds the button down. */
const drag = async (page: Page, from: { x: number; y: number }, dx: number, dy: number) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 25; i++) {
    await page.mouse.move(from.x + (dx * i) / 25, from.y + (dy * i) / 25);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(700);
};

test('dragging a node carries its connected neighbours', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(`${url}?nodes=8`);
  await expect(page.locator('g.nodes > g')).toHaveCount(8);
  await page.waitForTimeout(2000);

  const before = { alpha: await center(page, 'Alpha'), bravo: await center(page, 'Bravo') };
  await drag(page, before.alpha, 200, 120);
  const during = { alpha: await center(page, 'Alpha'), bravo: await center(page, 'Bravo') };
  await page.mouse.up();

  const dragged = distance(before.alpha, during.alpha);
  const followed = distance(before.bravo, during.bravo);
  expect(dragged).toBeGreaterThan(150);
  // The neighbour has to travel most of the way with the dragged node.
  expect(followed).toBeGreaterThan(dragged * 0.55);
});

test('dragging a leaf carries the hub it is connected to', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(`${url}?shape=hub&nodes=20`);
  await expect(page.locator('g.nodes > g')).toHaveCount(20);
  await page.waitForTimeout(3000);

  const before = { hub: await center(page, 'Alpha'), leaf: await center(page, 'Note 9') };
  await drag(page, before.leaf, 200, 120);
  const during = { hub: await center(page, 'Alpha'), leaf: await center(page, 'Note 9') };
  await page.mouse.up();

  // A hub node has many links, so the degree-weighted spring barely reacts to
  // a single link at rest; the drag has to carry it anyway. Compare against the
  // leaf's travel instead of an absolute pixel value: a large hub typically
  // follows around 55-60%, and an absolute threshold sat inside the noise band.
  const leafDistance = distance(before.leaf, during.leaf);
  const hubDistance = distance(before.hub, during.hub);
  expect(leafDistance).toBeGreaterThan(150);
  expect(hubDistance).toBeGreaterThan(leafDistance * 0.5);
});

test.describe('reduce motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the graph is laid out on screen and drags carry neighbours', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(`${url}?nodes=8`);
    await expect(page.locator('g.nodes > g')).toHaveCount(8);
    await page.waitForTimeout(2000);

    // With reduced motion the timer never ticks, so the pre-warmed layout has
    // to be painted once. Before that, every node group sat at the SVG origin.
    const transforms = await page
      .locator('g.nodes > g')
      .evaluateAll(elements => elements.map(element => element.getAttribute('transform')));
    expect(transforms.every(Boolean)).toBe(true);
    const positions = new Set(transforms);
    expect(positions.size).toBe(8);

    const before = { alpha: await center(page, 'Alpha'), bravo: await center(page, 'Bravo') };
    await drag(page, before.alpha, 200, 120);
    const during = { alpha: await center(page, 'Alpha'), bravo: await center(page, 'Bravo') };
    await page.mouse.up();

    expect(distance(before.alpha, during.alpha)).toBeGreaterThan(150);
    expect(distance(before.bravo, during.bravo)).toBeGreaterThan(40);
  });
});
