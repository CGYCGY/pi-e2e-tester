import type { DeviceProfile } from "./types.ts";
import { samsungGalaxy } from "./samsung-galaxy.ts";
import { pixelStock } from "./pixel-stock.ts";

const PROFILES: Record<string, DeviceProfile> = {
  [samsungGalaxy.id]: samsungGalaxy,
  [pixelStock.id]: pixelStock,
};

export function getProfile(name: string): DeviceProfile {
  const profile = PROFILES[name];
  if (!profile) {
    const known = Object.keys(PROFILES).sort().join(", ");
    throw new Error(
      `pi-e2e-tester: unknown device profile "${name}".\n` +
        `  Fix config.json -> device.profile to one of: ${known}.`,
    );
  }
  return profile;
}

export type { DeviceProfile };
