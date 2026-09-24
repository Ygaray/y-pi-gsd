// Project/App: gsd-pi
// File Purpose: RED-phase placeholder for the close-time residual capture
// writer (GREEN-05, D-05). This is a deliberately non-functional stub —
// see 19-05-PLAN.md Task 1 — that exists only so
// tests/milestone-closeout-residual-capture.test.ts can import real types
// and run for real (not crash on module resolution) while the RED test run
// is captured. The real implementation lands in the GREEN commit.

import type { TrackerItemSeverity } from "./db/writers/tracker-item.js";

export interface MilestoneCloseoutResidualItem {
  title: string;
  severity?: TrackerItemSeverity;
  detail?: string;
  phaseId?: string;
  requirementId?: string;
  supersedesControlPlaneIncidentId?: string;
}

export interface MilestoneCloseoutResidualCapture {
  created: string[];
  skipped: string[];
  warnings: string[];
}

export function captureMilestoneCloseoutResiduals(_input: {
  milestoneId: string;
  items: MilestoneCloseoutResidualItem[];
  basePath: string;
}): MilestoneCloseoutResidualCapture {
  // RED placeholder: never touches the database, always reports nothing
  // captured. Every behavior test that supplies a non-empty item array
  // must fail against this stub.
  return { created: [], skipped: [], warnings: [] };
}
