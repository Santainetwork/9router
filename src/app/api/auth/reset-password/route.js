import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/localDb";

// Reset dashboard password to the first-run value by clearing the stored hash.
// Local-only (enforced by dashboardGuard). The first-run value is the operator's
// INITIAL_PASSWORD or the per-install random password (logged at startup, stored
// in DATA_DIR/initial-password) — never a hardcoded literal. Never returns it.
export async function POST() {
  try {
    await updateSettings({ password: null });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
