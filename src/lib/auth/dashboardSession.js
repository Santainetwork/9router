import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/localDb";

const SESSION_MAX_AGE_SEC = 24 * 60 * 60;

// First-run password: operator-supplied INITIAL_PASSWORD, else a per-install
// random one generated on first use and persisted with 0600 perms (same pattern
// as jwt-secret). No guessable default exists in the source tree.
const INITIAL_PASSWORD_FILE = "initial-password";

function resolveInitialPassword() {
  const fromEnv = process.env.INITIAL_PASSWORD;
  if (fromEnv) return fromEnv;
  const file = path.join(DATA_DIR, INITIAL_PASSWORD_FILE);
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(12).toString("base64url");
  // Best-effort: a read-only DATA_DIR must not break login entirely.
  try {
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch (e) {
    console.warn(`[auth] cannot persist ${INITIAL_PASSWORD_FILE} in DATA_DIR (${e.code}); initial password is valid for this process only`);
  }
  console.warn(`[auth] first-run dashboard password: ${generated} (stored in ${file})`);
  return generated;
}

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const SECRET = new TextEncoder().encode(loadJwtSecret());

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

export async function createDashboardAuthToken(claims = {}) {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token) {
  if (!token) return false;
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

// Exported for the login route: the value a fresh install authenticates with
// before any hash is saved. Never a hardcoded literal.
export function getInitialPassword() {
  return resolveInitialPassword();
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (storedHash) return bcrypt.compare(password, storedHash);
  // Only INITIAL_PASSWORD (env) or the persisted per-install value is accepted.
  return password === resolveInitialPassword();
}
