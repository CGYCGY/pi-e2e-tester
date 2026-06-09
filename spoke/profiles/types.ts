// Submitting a focused auth field branches by device (see samsung-galaxy.ts),
// so it's behavior behind an interface, not a config string. Picked by
// config.device.profile.

import type { Device } from "../device.ts";

export interface DeviceProfile {
  id: string;
  submit(device: Device): Promise<void>;
  // Injected verbatim into the spoke prompt so the LLM gets a TRUE device-submit
  // rule for THIS phone, never a hardcoded-wrong one (e.g. Samsung's Pass overlay).
  submitHint: string;
}
