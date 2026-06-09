// Stock Android (e.g. Pixel): no Samsung Pass overlay, so Enter is unambiguous.
// Second profile, proving DeviceProfile is pluggable.

import type { DeviceProfile } from "./types.ts";

export const pixelStock: DeviceProfile = {
  id: "pixel-stock",
  async submit(device) {
    await device.pressKey("enter");
  },
  submitHint:
    "Device: this is a stock-Android phone. Submitting a field with the Enter key " +
    "works, and tapping a Continue/Sign-in button is also fine — no invisible " +
    "overlays to avoid.",
};
