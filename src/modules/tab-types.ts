/**
 * Contract for every candidate-detail tab. Each module exports an async server component with these props from
 * `src/modules/<module>/candidate-tab.tsx`; the detail page renders it only if the viewer has the tab's permission.
 * Tabs MUST re-check permissions server-side themselves (never rely on the page alone) and must only read data for
 * `candidateId` after the page has verified record-level access via `loadCandidateFor()`.
 */
export interface CandidateTabProps {
  candidateId: string;
}
