import os from "node:os";
import path from "node:path";

export function configDir(): string {
  return path.join(os.homedir(), ".auto-embed");
}

export function configFile(): string {
  return path.join(configDir(), "config.json");
}
