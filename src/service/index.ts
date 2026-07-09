/**
 * Selects the right service controller for the current platform.
 */
import { detectPlatform } from "./platform.js";
import { linuxController } from "./linux.js";
import { macosController } from "./macos.js";
import type { ServiceController } from "./types.js";
import { windowsController } from "./windows.js";

export { buildLaunchSpec } from "./platform.js";
export type { LaunchSpec, ServiceController, ServiceResult } from "./types.js";

export function getController(): ServiceController {
  switch (detectPlatform()) {
    case "windows":
      return windowsController;
    case "linux":
      return linuxController;
    case "macos":
      return macosController;
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}
