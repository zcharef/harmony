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

async function navigateToGeneralChannel(page: Page) {
  await page
    .locator(`[data-test="server-button"][data-server-id="${HARMONY_DEV_SERVER_ID}"]`)
    .click()
  await page.locator('[data-test="channel-sidebar"]').waitFor({ timeout: 10000 })
  await page
    .locator(`[data-test="channel-button"][data-channel-id="${GENERAL_CHANNEL_ID}"]`)
    .click()
  await page.locator('[data-test="chat-area"]').waitFor({ timeout: 10000 })
  await page.locator('[data-test="message-item"]').first().waitFor({ timeout: 10000 })
}

test.describe('Message Actions', () => {
  test('should edit own message and verify content changes', async ({ page }) => {
    await loginAsAlice(page)
    await navigateToGeneralChannel(page)

    // Find alice's "Welcome to Harmony!" message and capture its ID
    const targetMessage = page.locator('[data-test="message-item"]').filter({
      has: page.locator('[data-test="message-content"]', {
        hasText: 'Welcome to Harmony!',
      }),
    })
    await expect(targetMessage).toBeVisible()
    const messageId = await targetMessage.getAttribute('data-message-id')

    // Hover to reveal action buttons
    await targetMessage.hover()

    const editButton = targetMessage.locator('[data-test="message-edit-button"]')
    await expect(editButton).toBeVisible()
    await editButton.click()

    // After clicking edit, message-content is replaced by edit-input.
    // Re-locate the message by its stable data-message-id attribute.
    const editingMessage = page.locator(
      `[data-test="message-item"][data-message-id="${messageId}"]`,
    )
    const editInput = editingMessage.locator('[data-test="message-edit-input"]')
    await expect(editInput).toBeVisible()
    // Content may differ from seed if a previous run already edited it
    const currentValue = await editInput.inputValue()
    expect(currentValue.length).toBeGreaterThan(0)

    // Clear and fill with new content
    await editInput.clear()
    await editInput.fill('Welcome to Harmony! (edited via E2E)')
    await expect(editInput).toHaveValue('Welcome to Harmony! (edited via E2E)')

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${GENERAL_CHANNEL_ID}/messages/${messageId}`) &&
        response.request().method() === 'PATCH',
    )

    await editingMessage.locator('[data-test="message-edit-save"]').click()

    const response = await responsePromise
    expect(response.status()).toBeLessThan(400)

    // Verify updated content
    const updatedContent = editingMessage.locator('[data-test="message-content"]')
    await expect(updatedContent).toContainText('edited via E2E')

    // Verify edited indicator appears
    const editedIndicator = editingMessage.locator('[data-test="message-edited-indicator"]')
    await expect(editedIndicator).toBeVisible()
    await expect(editedIndicator).toHaveText('(edited)')
  })

  test('should delete own message and verify it disappears', async ({ page }) => {
    await loginAsAlice(page)
    await navigateToGeneralChannel(page)

    // Send a new message so we don't destroy seed data
    // Register listener BEFORE any interaction to avoid race
    const sendResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${GENERAL_CHANNEL_ID}/messages`) &&
        response.request().method() === 'POST',
      { timeout: 30000 },
    )

    const messageTextarea = page.locator('[data-test="message-input"]')
    await messageTextarea.fill('Message to delete in E2E')
    await expect(messageTextarea).toHaveValue('Message to delete in E2E')

    await messageTextarea.press('Enter')

    const sendResponse = await sendResponsePromise
    expect(sendResponse.status()).toBeLessThan(400)

    // Extract the real message ID from the API response
    const sendBody = await sendResponse.json()
    const newMessageId = sendBody.id as string
    expect(newMessageId.length).toBeGreaterThan(0)

    // Wait for the real message to appear in the DOM (replaces optimistic)
    const newMessage = page.locator(`[data-test="message-item"][data-message-id="${newMessageId}"]`)
    await expect(newMessage).toBeVisible({ timeout: 10000 })

    // Hover to reveal action buttons
    await newMessage.hover()

    const deleteButton = newMessage.locator('[data-test="message-delete-button"]')
    await expect(deleteButton).toBeVisible()

    const deleteResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/channels/${GENERAL_CHANNEL_ID}/messages/${newMessageId}`) &&
        response.request().method() === 'DELETE',
    )

    await deleteButton.click()

    const deleteResponse = await deleteResponsePromise
    expect(deleteResponse.status()).toBeLessThan(400)

    // Verify the message is no longer visible
    await expect(newMessage).not.toBeVisible({ timeout: 10000 })
  })
})
