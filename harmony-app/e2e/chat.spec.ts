import { expect, type Page, test } from '@playwright/test'

const HARMONY_DEV_SERVER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const GENERAL_CHANNEL_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

async function loginAsAlice(page: Page) {
  await page.goto('/')
  await page.locator('[data-test="login-email-input"]').fill('alice@harmony.test')
  await page.locator('[data-test="login-password-input"]').fill('password123')
  await page.locator('[data-test="login-submit-button"]').click()
  await page.locator('[data-test="main-layout"]').waitFor({ timeout: 15000 })
}

test.describe('Chat', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAlice(page)
    await page
      .locator(`[data-test="server-button"][data-server-id="${HARMONY_DEV_SERVER_ID}"]`)
      .click()
    await page.locator('[data-test="channel-sidebar"]').waitFor({ timeout: 10000 })
  })

  test('should show chat area when selecting a channel', async ({ page }) => {
    await page
      .locator(`[data-test="channel-button"][data-channel-id="${GENERAL_CHANNEL_ID}"]`)
      .click()

    const chatArea = page.locator('[data-test="chat-area"]')
    await chatArea.waitFor({ timeout: 10000 })

    await expect(page.locator('[data-test="message-list"]')).toBeAttached()
    await expect(page.locator('[data-test="message-input"]')).toBeAttached()
  })

  test('should display seed messages in the channel', async ({ page }) => {
    await page
      .locator(`[data-test="channel-button"][data-channel-id="${GENERAL_CHANNEL_ID}"]`)
      .click()

    const messageList = page.locator('[data-test="message-list"]')
    await messageList.waitFor({ timeout: 10000 })

    const messageItems = page.locator('[data-test="message-item"]')
    await expect(messageItems.first()).toBeAttached({ timeout: 10000 })
    const count = await messageItems.count()
    expect(count).toBeGreaterThanOrEqual(3)

    const allMessageContents = page.locator('[data-test="message-content"]')
    await expect(allMessageContents.filter({ hasText: 'Welcome to Harmony!' })).toHaveCount(1)
    await expect(allMessageContents.filter({ hasText: 'Hey Alice!' })).toHaveCount(1)
  })

  test('should send a message and see it appear', async ({ page }) => {
    await page
      .locator(`[data-test="channel-button"][data-channel-id="${GENERAL_CHANNEL_ID}"]`)
      .click()

    const chatArea = page.locator('[data-test="chat-area"]')
    await chatArea.waitFor({ timeout: 10000 })

    const messageTextarea = page.locator('[data-test="message-input"]')
    await messageTextarea.fill('E2E regression test')
    await expect(messageTextarea).toHaveValue('E2E regression test')

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${GENERAL_CHANNEL_ID}/messages`) &&
        response.request().method() === 'POST',
    )

    await messageTextarea.press('Enter')

    const response = await responsePromise
    expect(response.status()).toBeLessThan(400)

    const newMessage = page
      .locator('[data-test="message-content"]')
      .filter({ hasText: 'E2E regression test' })
    const messageCount = await newMessage.count()
    expect(messageCount).toBeGreaterThanOrEqual(1)
  })
})
