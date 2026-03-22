import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT_DIR = join(__dirname, '../..')
const SRC_DIR = join(ROOT_DIR, 'src')

/**
 * Architecture tests for dependency version coupling.
 *
 * These validate structural rules after the @hey-api/client-fetch removal
 * and version pinning strategy:
 * - No runtime imports from the deprecated @hey-api/client-fetch package
 * - tailwindcss exact pin matches @tailwindcss/vite
 * - @playwright/test version matches Docker Compose image tag
 * - Generated API client uses bundled local client, not external package
 *
 * Run with: just test-arch
 */

function getAllFiles(dir: string, extensions: string[]): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath, extensions))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath)
    }
  }
  return files
}

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf-8'))
}

describe('Dependency Version Coupling', () => {
  describe('hey_api_client_fetch_removal', () => {
    it('no source files import from @hey-api/client-fetch (deprecated package)', () => {
      const files = getAllFiles(SRC_DIR, ['.ts', '.tsx'])
      const violations: string[] = []

      for (const filePath of files) {
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          // Match both single and double quote import styles
          if (/from\s+['"]@hey-api\/client-fetch['"]/.test(line)) {
            violations.push(`${relative(SRC_DIR, filePath)}:${i + 1}`)
          }
        }
      }

      expect(
        violations,
        `Imports from @hey-api/client-fetch found. This package was removed — the client is now bundled in @hey-api/openapi-ts. Use './client' (local) instead.\nViolations:\n${violations.join('\n')}`,
      ).toEqual([])
    })

    it('@hey-api/client-fetch is not listed in package.json', () => {
      const pkg = readPackageJson()
      const deps = (pkg.dependencies ?? {}) as Record<string, string>
      const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>

      expect(
        deps['@hey-api/client-fetch'],
        '@hey-api/client-fetch should not be in dependencies (deprecated, bundled in openapi-ts)',
      ).toBeUndefined()
      expect(
        devDeps['@hey-api/client-fetch'],
        '@hey-api/client-fetch should not be in devDependencies (deprecated, bundled in openapi-ts)',
      ).toBeUndefined()
    })
  })

  describe('tailwindcss_version_pinning', () => {
    it('tailwindcss is exact-pinned (no caret) and matches @tailwindcss/vite', () => {
      const pkg = readPackageJson()
      const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>

      const tailwindVersion = devDeps.tailwindcss
      const tailwindViteVersion = devDeps['@tailwindcss/vite']

      // Both must be present
      expect(tailwindVersion, 'tailwindcss must be in devDependencies').toBeDefined()
      expect(tailwindViteVersion, '@tailwindcss/vite must be in devDependencies').toBeDefined()

      // tailwindcss must be exact-pinned (no ^ or ~ prefix)
      expect(
        tailwindVersion.startsWith('^') || tailwindVersion.startsWith('~'),
        `tailwindcss must be exact-pinned (no caret/tilde). Found: "${tailwindVersion}". Tailwind v4 requires tailwindcss and @tailwindcss/vite to resolve to the exact same version — a caret allows drift.`,
      ).toBe(false)

      // Strip range prefix from @tailwindcss/vite for comparison
      const viteBase = tailwindViteVersion.replace(/^[\^~]/, '')

      expect(
        tailwindVersion,
        `tailwindcss (${tailwindVersion}) must match @tailwindcss/vite base version (${viteBase}). Mismatched versions cause Tailwind v4 build failures.`,
      ).toBe(viteBase)
    })
  })

  describe('playwright_version_coupling', () => {
    it('@playwright/test version matches docker-compose.playwright.yml image tag', () => {
      const pkg = readPackageJson()
      const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>
      const playwrightPkgVersion = devDeps['@playwright/test']

      expect(playwrightPkgVersion, '@playwright/test must be in devDependencies').toBeDefined()

      // Strip caret/tilde to get the base version
      const pkgBase = playwrightPkgVersion.replace(/^[\^~]/, '')

      const composePath = join(ROOT_DIR, 'docker-compose.playwright.yml')
      expect(existsSync(composePath), 'docker-compose.playwright.yml must exist').toBe(true)

      const composeContent = readFileSync(composePath, 'utf-8')

      // Extract version from image tag like: mcr.microsoft.com/playwright:v1.58.2-noble
      const imageMatch = composeContent.match(
        /mcr\.microsoft\.com\/playwright:v([\d.]+)/,
      )
      expect(
        imageMatch,
        'docker-compose.playwright.yml must contain a Playwright image with a version tag (e.g., mcr.microsoft.com/playwright:v1.58.2-noble)',
      ).not.toBeNull()

      const dockerVersion = imageMatch![1]

      expect(
        pkgBase,
        `@playwright/test version (${pkgBase}) must match Docker image tag (${dockerVersion}). Mismatched versions cause CI test failures due to browser binary incompatibility.`,
      ).toBe(dockerVersion)
    })
  })

  describe('generated_client_uses_bundled_import', () => {
    it('client.gen.ts imports from local ./client, not @hey-api/client-fetch', () => {
      const clientGenPath = join(SRC_DIR, 'lib/api/client.gen.ts')
      expect(existsSync(clientGenPath), 'src/lib/api/client.gen.ts must exist').toBe(true)

      const content = readFileSync(clientGenPath, 'utf-8')

      // Must NOT import from the deprecated external package
      expect(
        content.includes("from '@hey-api/client-fetch'") ||
          content.includes('from "@hey-api/client-fetch"'),
        'client.gen.ts must not import from @hey-api/client-fetch (deprecated). The generated client should use the local bundled client.',
      ).toBe(false)

      // Must import from the local bundled client
      expect(
        /from\s+['"]\.\/client['"]/.test(content),
        "client.gen.ts must import from './client' (local bundled client from @hey-api/openapi-ts)",
      ).toBe(true)
    })
  })
})
