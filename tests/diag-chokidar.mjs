import chokidar from "chokidar";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "furina-e2e-test");
const f = join(dir, "diag.txt");

console.log("watch:", dir);
const w = chokidar.watch(dir, {
  persistent: true,
  ignoreInitial: true,
});

w.on("ready", () => {
  console.log("watcher ready, watched paths:", w.getWatched());
  setTimeout(() => {
    console.log("writing file...");
    writeFileSync(f, "test\n");
    setTimeout(() => {
      console.log("done, closing");
      w.close();
      process.exit(0);
    }, 2000);
  }, 500);
});

w.on("all", (event, path) => {
  console.log(`  EVENT: ${event} ${path}`);
});
w.on("error", (e) => console.log("  ERR:", e.message));
