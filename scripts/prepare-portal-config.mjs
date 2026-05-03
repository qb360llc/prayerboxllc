import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(process.cwd(), "..");
const portalDir = resolve(repoRoot, "portal");
const configPath = resolve(portalDir, "config.js");

const projectUrl = process.env.PRAYERBOX_PROJECT_URL?.trim() || "";
const anonKey = process.env.PRAYERBOX_ANON_KEY?.trim() || "";
const vapidPublicKey = process.env.PRAYERBOX_VAPID_PUBLIC_KEY?.trim() || "";
const environmentName = process.env.PRAYERBOX_ENV?.trim() || "production";

if (!projectUrl || !anonKey || !vapidPublicKey) {
  if (!existsSync(configPath)) {
    throw new Error(
      "Missing PRAYERBOX_* environment variables and portal/config.js does not exist.",
    );
  }

  console.log(
    "[prepare-portal-config] PRAYERBOX_* environment variables not set. Keeping existing portal/config.js.",
  );
  process.exit(0);
}

const configSource = `window.PRAYERBOX_PORTAL_CONFIG = {
  projectUrl: ${JSON.stringify(projectUrl)},
  anonKey: ${JSON.stringify(anonKey)},
  vapidPublicKey: ${JSON.stringify(vapidPublicKey)},
  environment: ${JSON.stringify(environmentName)},
};
`;

const previous = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
if (previous === configSource) {
  console.log(`[prepare-portal-config] portal/config.js already matches ${environmentName}.`);
  process.exit(0);
}

writeFileSync(configPath, configSource, "utf8");
console.log(`[prepare-portal-config] Wrote portal/config.js for ${environmentName}.`);
