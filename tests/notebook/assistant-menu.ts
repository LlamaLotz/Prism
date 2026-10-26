import type { Page } from '@playwright/test';

/**
 * The conversation's ⋮ menu. It owns the Agent on/off toggle, so tests open it
 * before touching agent state.
 */
export async function openConversationMenu(page: Page) {
  await page.getByLabel('Conversation actions').click();
}

/** Ensures Agent is enabled from the conversation menu (its only location now). */
export async function toggleAgent(page: Page) {
  await openConversationMenu(page);
  const enabled = page.getByRole('button', { name: 'Agent ON', exact: true });
  if (await enabled.isVisible()) await page.keyboard.press('Escape');
  else await page.getByRole('button', { name: 'Agent OFF', exact: true }).click();
}
