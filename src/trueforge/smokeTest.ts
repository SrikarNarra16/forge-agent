/**
 * Prompts for the two debug commands "Forge: Smoke Test" and "Forge: Smoke Test (code question)". They
 * simply send these prompts through the normal Agent panel and controller, so the run is visible in the
 * panel and in the Forge output channel (see ActivityLog).
 */
export const SMOKE_PROMPTS = {
  ping: "Use the ping tool and tell me what it returned.",
  code: "Find get_debug_flag in this workspace and explain exactly which values it treats as false.",
} as const;
