import fs from "node:fs";
import { describe, expect, it } from "vitest";
import pluginDefinition from "./index.js";

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), "utf8")) as unknown;
}

describe("Mattermost custom plugin identity", () => {
  it("keeps a distinct plugin identity while claiming the canonical Mattermost channel", () => {
    const packageJson = readJson("./package.json") as {
      name: string;
      private: boolean;
      openclaw: {
        extensions: string[];
        runtimeExtensions: string[];
        setupEntry: string;
        runtimeSetupEntry: string;
        channel: { id: string; preferOver: string[] };
        install: {
          minHostVersion: string;
          localPath?: string;
          defaultChoice?: string;
          allowInvalidConfigRecovery?: boolean;
          npmSpec?: string;
          clawhubSpec?: string;
        };
      };
    };
    const manifest = readJson("./openclaw.plugin.json") as {
      id: string;
      channels: string[];
      channelConfigs: { mattermost: { preferOver: string[] } };
    };

    expect(packageJson.name).toBe("openclaw-mattermost-custom");
    expect(packageJson.private).toBe(true);
    expect(manifest.id).toBe("mattermost-custom");
    expect(pluginDefinition.id).toBe(manifest.id);
    expect(manifest.channels).toEqual(["mattermost"]);
    expect(manifest.channelConfigs?.mattermost?.preferOver).toEqual(["mattermost"]);
    expect(packageJson.openclaw.channel).toMatchObject({
      id: "mattermost",
      preferOver: ["mattermost"],
    });
    expect(packageJson.openclaw.extensions).toEqual(["./index.ts"]);
    expect(packageJson.openclaw.runtimeExtensions).toEqual(["./dist/index.js"]);
    expect(packageJson.openclaw.setupEntry).toBe("./setup-entry.ts");
    expect(packageJson.openclaw.runtimeSetupEntry).toBe("./dist/setup-entry.js");
    expect(packageJson.openclaw.install.minHostVersion).toBe(">=2026.7.2-beta.7");
    expect(packageJson.openclaw.install.localPath).toBeUndefined();
    expect(packageJson.openclaw.install.defaultChoice).toBeUndefined();
    expect(packageJson.openclaw.install.allowInvalidConfigRecovery).toBeUndefined();
    expect(packageJson.openclaw.install.npmSpec).toBeUndefined();
    expect(packageJson.openclaw.install.clawhubSpec).toBeUndefined();
  });
});
