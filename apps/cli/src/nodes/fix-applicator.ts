/**
 * fix_applicator node — applies auto-fixable best practice patches to desiredState.
 *
 * Wave-6c F3: SOLID refactor. This file is now a thin façade over the
 * SRP sub-modules in `./fix-applicator/`. All previously-exported names
 * remain accessible here for back-compat with tests and intra-repo imports.
 *
 * @see Story 22.2, Epic 22
 * @see feedback_autofix_user_decides (3-mode preserved in mode-resolver)
 */

export { fixApplicatorNode } from "./fix-applicator/orchestrator.js";
