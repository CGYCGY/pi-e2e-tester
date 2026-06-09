// Samsung Pass invisibly overlays the AuthKit Continue button, so tapping it hits
// the wrong (social-provider) button — submit auth fields with KEYCODE_ENTER.

import type { DeviceProfile } from "./types.ts";

export const samsungGalaxy: DeviceProfile = {
  id: "samsung-galaxy",
  async submit(device) {
    await device.pressKey("enter");
  },
  submitHint:
    "Device: this is a Samsung phone. Submit auth/text fields with the Enter key " +
    "(the type verb's submit does this) and NEVER tap a Continue/Sign-in button — " +
    "Samsung Pass invisibly overlays those buttons, so a tap lands on the wrong " +
    "(social-provider) control.",
};
