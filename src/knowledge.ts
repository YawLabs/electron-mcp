/**
 * Single source of truth for the vintage of embedded Electron knowledge
 * (breaking changes, deprecated APIs, security recommendations, performance
 * anti-patterns, concept explanations).
 *
 * When a new Electron major releases, follow KNOWLEDGE.md to update the
 * embedded data and bump these fields.
 */
export const KNOWLEDGE_VERSION = {
  lastVerified: "2026-04-13",
  electronStable: 41,
  supportedRange: { min: 20, max: 41 },
  sources: {
    breakingChanges: "https://www.electronjs.org/docs/latest/breaking-changes",
    security: "https://www.electronjs.org/docs/latest/tutorial/security",
    performance: "https://www.electronjs.org/docs/latest/tutorial/performance",
    releases: "https://releases.electronjs.org",
  },
} as const;

export function knowledgeFooter(): string {
  return `\n\n---\n_Knowledge last verified ${KNOWLEDGE_VERSION.lastVerified} (Electron v${KNOWLEDGE_VERSION.electronStable} stable). For anything newer, check ${KNOWLEDGE_VERSION.sources.releases}._`;
}
