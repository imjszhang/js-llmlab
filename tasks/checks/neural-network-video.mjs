// Trusted, self-contained acceptance source. The loader freezes this exact source
// into argv; no candidate module is imported or executed by this checker.
import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

const workspace = realpathSync(process.cwd());
const videoExtensions = new Map([[".mp4", 0], [".mov", 1], [".webm", 2], [".m4v", 3]]);
const codeExtensions = new Set([
  ".html", ".htm", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
  ".py", ".glsl", ".frag", ".vert", ".wgsl", ".css", ".scss", ".vue", ".svelte",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".go", ".swift",
]);
const videos = [];
const sources = [];

function fail(message, infrastructure = false) {
  console.error(`${infrastructure ? "INFRASTRUCTURE ERROR" : "TECHNICAL ACCEPTANCE FAILED"}: ${message}`);
  process.exit(infrastructure ? 2 : 1);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function ignored(name, relative) {
  return relative === "style" || name === "node_modules" || name === ".git" || name === "archives"
    || name === ".venv" || name === "venv" || name === "__pycache__"
    || name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

function walk(directory, prefix = "") {
  for (const name of readdirSync(directory).sort()) {
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    if (ignored(name, relative)) continue;
    const absolute = path.join(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) fail(`candidate symlink is forbidden: ${relative}`);
    if (stat.isDirectory()) {
      walk(absolute, relative);
      continue;
    }
    if (!stat.isFile()) fail(`candidate must be a regular file: ${relative}`);
    const extension = path.extname(name).toLowerCase();
    if (videoExtensions.has(extension) && stat.size > 0) videos.push({ absolute, relative, extension });
    if (codeExtensions.has(extension) && stat.size > 0) {
      // Only inspect text. In particular, never run a candidate renderer to grade it.
      const contents = readFileSync(absolute);
      if (!contents.includes(0) && contents.toString("utf8").trim() !== "") sources.push(relative);
    }
  }
}

// Resolve a host tool explicitly. An empty/relative PATH segment or a candidate
// executable in the workspace cannot replace the trusted ffprobe invocation.
function findProbe() {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const name of process.platform === "win32" ? ["ffprobe.exe", "ffprobe"] : ["ffprobe"]) {
      const candidate = path.join(directory, name);
      try {
        if (contained(workspace, realpathSync(directory))) continue;
        const resolved = realpathSync(candidate);
        if (contained(workspace, resolved) || !lstatSync(resolved).isFile()) continue;
        accessSync(resolved, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return resolved;
      } catch { /* Try the next host PATH entry. */ }
    }
  }
  fail("ffprobe is required on the host PATH; no candidate code was executed", true);
}

function positive(value) {
  return value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}

function displaySize(stream) {
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!positive(width) || !positive(height)) return null;
  let aspect = 1;
  const sampleAspect = stream.sample_aspect_ratio;
  if (sampleAspect !== undefined && sampleAspect !== "N/A" && sampleAspect !== "0:1") {
    if (typeof sampleAspect !== "string" || !/^\d+:\d+$/.test(sampleAspect)) return null;
    const [numerator, denominator] = sampleAspect.split(":").map(Number);
    if (!positive(numerator) || !positive(denominator)) return null;
    aspect = numerator / denominator;
  }
  const sideRotation = Array.isArray(stream.side_data_list)
    ? stream.side_data_list.find((item) => item !== null && typeof item === "object" && item.rotation !== undefined)?.rotation
    : undefined;
  const rawRotation = sideRotation ?? stream.tags?.rotate ?? 0;
  if (!Number.isFinite(Number(rawRotation))) return null;
  const radians = Number(rawRotation) * Math.PI / 180;
  const displayWidth = Math.abs(width * aspect * Math.cos(radians)) + Math.abs(height * Math.sin(radians));
  const displayHeight = Math.abs(width * aspect * Math.sin(radians)) + Math.abs(height * Math.cos(radians));
  return { width: displayWidth, height: displayHeight };
}

try {
  walk(workspace);
  if (sources.length === 0) fail("no nonempty candidate code outside style/dependencies was found");
  if (videos.length === 0) fail("no nonempty candidate video (.mp4/.mov/.webm/.m4v) was found");
  videos.sort((a, b) => videoExtensions.get(a.extension) - videoExtensions.get(b.extension) || a.relative.localeCompare(b.relative));
  const probe = findProbe();
  const deadline = Date.now() + 22000;
  const diagnostics = [];
  for (const candidate of videos) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("video metadata inspection exhausted its bounded checker budget", true);
    const inspected = spawnSync(probe, [
      "-v", "error", "-protocol_whitelist", "file,pipe",
      "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm", "-select_streams", "v",
      "-count_frames", "-read_intervals", "%+#128", "-show_streams", "-show_format", "-of", "json", "-i", candidate.absolute,
    ], { encoding: "utf8", timeout: Math.min(8000, remaining), maxBuffer: 1024 * 1024, shell: false });
    if (inspected.error !== undefined) {
      fail(`ffprobe could not inspect ${candidate.relative}: ${inspected.error.message}`, true);
    }
    if (inspected.status !== 0 || inspected.signal !== null) {
      diagnostics.push(`${candidate.relative}: ffprobe rejected the container`);
      continue;
    }
    let metadata;
    try { metadata = JSON.parse(inspected.stdout); }
    catch { fail(`ffprobe returned invalid JSON for ${candidate.relative}`, true); }
    if (metadata === null || typeof metadata !== "object" || !Array.isArray(metadata.streams)) {
      diagnostics.push(`${candidate.relative}: no video stream metadata`);
      continue;
    }
    const valid = metadata.streams.find((stream) => {
      if (stream === null || typeof stream !== "object" || stream.codec_type !== "video"
        || typeof stream.codec_name !== "string" || stream.codec_name === "" || stream.codec_name === "unknown"
        || stream.disposition?.attached_pic === 1 || !positive(stream.nb_read_frames)) return false;
      const duration = positive(stream.duration) ? Number(stream.duration) : Number(metadata.format?.duration);
      const display = displaySize(stream);
      return positive(duration) && display !== null && display.height > display.width + 0.000001;
    });
    if (valid === undefined) {
      diagnostics.push(`${candidate.relative}: requires a readable video frame, positive duration and portrait display dimensions (SAR/rotation included)`);
      continue;
    }
    const display = displaySize(valid);
    const duration = positive(valid.duration) ? Number(valid.duration) : Number(metadata.format?.duration);
    console.log(`TECHNICAL ACCEPTANCE PASSED: ${candidate.relative}; ${display.width.toFixed(2)}x${display.height.toFixed(2)} display; ${duration}s; readable video frame in inspected prefix; ${sources.length} nonempty candidate code file(s).`);
    console.log("Technical checks only: Chinese narration/text, neural-network explanation, factual accuracy, visual style, motion quality and viral appeal require manual review. Source code was not executed; complete video playback and reproducibility were not verified.");
    process.exit(0);
  }
  fail(`no candidate passed video technical checks\n${diagnostics.join("\n")}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
