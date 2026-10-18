// The phone's WebView localStorage holds the PC bearer token (rc_token). Android
// backup and device-transfer would copy it off the device, so the tracked manifest
// must keep backup off. `cargo tauri android init` can regenerate gen/android, so
// this pins the attributes against a silent revert.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const GEN = "android/src-tauri/gen/android/app/src/main";
const manifest = readFileSync(`${GEN}/AndroidManifest.xml`, "utf8");

describe("android manifest backup policy", () => {
  it("disables backup on the application element", () => {
    const app = manifest.match(/<application\b[^>]*>/s)?.[0] ?? "";
    expect(app).toContain('android:allowBackup="false"');
    expect(app).toContain('android:fullBackupContent="false"');
    expect(app).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
  });

  it("ships data extraction rules that exclude every domain", () => {
    const path = `${GEN}/res/xml/data_extraction_rules.xml`;
    expect(existsSync(path)).toBe(true);
    const rules = readFileSync(path, "utf8");
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body = rules.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`))?.[1] ?? "";
      for (const domain of ["root", "file", "database", "sharedpref", "external"]) {
        expect(body).toContain(`<exclude domain="${domain}" />`);
      }
    }
  });
});
