import pc from "picocolors";

let verbose = false;

export function setVerbose(v: boolean) {
  verbose = v;
}

export function isVerbose() {
  return verbose;
}

export const log = {
  info(msg: string) {
    process.stderr.write(msg + "\n");
  },
  success(msg: string) {
    process.stderr.write(pc.green("✓") + " " + msg + "\n");
  },
  warn(msg: string) {
    process.stderr.write(pc.yellow("!") + " " + msg + "\n");
  },
  error(msg: string) {
    process.stderr.write(pc.red("✖") + " " + msg + "\n");
  },
  hint(msg: string) {
    process.stderr.write(pc.dim("  hint: " + msg) + "\n");
  },
  debug(msg: string) {
    if (verbose) process.stderr.write(pc.dim("[debug] " + msg) + "\n");
  },
};

export { pc };
