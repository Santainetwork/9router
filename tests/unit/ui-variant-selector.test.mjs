import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const source = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

test("UI variant store persists selection to localStorage", () => {
  const store = source("store/uiVariantStore.js");
  
  assert.match(store, /persist\(/i, "uiVariantStore must use Zustand persist middleware");
  assert.match(store, /name:.*["']9router-ui-variant["']|storageKey.*variant/i, "Must persist with recognizable key");
  assert.match(store, /setVariant|setUiVariant/i, "Must expose setVariant action");
  assert.match(store, /variant.*santai|santai.*friend/is, "Must support 'santai' and 'friend' values");
});

test("uiVariantStore exports from store index", () => {
  const storeIndex = source("store/index.js");
  assert.match(storeIndex, /uiVariantStore|useUiVariantStore/i, "store/index.js must export uiVariantStore");
});

test("DashboardLayout conditionally renders alt shell per variant", () => {
  const layout = source("shared/components/layouts/DashboardLayout.js");
  assert.match(layout, /useUiVariantStore|uiVariant/i, "DashboardLayout must consume uiVariantStore");
  assert.match(layout, /variant.*===.*["']friend["']|DashboardLayoutAlt/i, "Must conditionally render friend variant");
});

test("DashboardLayoutAlt exists and imports friend shell", () => {
  assert.ok(
    existsSync(new URL("../../src/shared/components/layouts/DashboardLayoutAlt.js", import.meta.url)),
    "DashboardLayoutAlt.js must exist"
  );
  const alt = source("shared/components/layouts/DashboardLayoutAlt.js");
  assert.match(alt, /Sidebar|Header/i, "DashboardLayoutAlt must import Sidebar or Header");
  assert.match(alt, /friend.*bundle|v0\.5\.86|adapted from friend/i, "Must document origin from friend bundle");
});

test("Profile page includes UI variant selector", () => {
  const profile = source("app/(dashboard)/dashboard/profile/page.js");
  assert.match(profile, /useUiVariantStore|uiVariant|UI Variant|Dashboard Style/i, "Profile must expose UI variant selector");
  assert.match(profile, /santai.*friend|friend.*santai/is, "Selector must present both options");
});

test("layouts/index.js exports DashboardLayoutAlt", () => {
  const layoutsIndex = source("shared/components/layouts/index.js");
  assert.match(layoutsIndex, /DashboardLayoutAlt/i, "layouts/index.js must export DashboardLayoutAlt");
});
