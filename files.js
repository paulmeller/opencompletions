/**
 * Workspace file management for OpenCompletions.
 *
 * Handles file upload/download/listing across local, sprite, and vercel backends.
 * Each workspace is an isolated directory bound to a specific backend instance.
 *
 * State machine: created → running → completed | error
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { Readable } = require("stream");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const workspaces = new Map();

// Backend config — set via init()
let config = {};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init(cfg) {
  config = cfg;
}

// ---------------------------------------------------------------------------
// Workspace CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new workspace bound to a specific backend.
 * For sprite/vercel, also binds to a specific instance.
 */
async function createWorkspace(backend, spriteName, sandboxId) {
  const id = crypto.randomBytes(16).toString("hex");
  const ws = {
    id,
    state: "created",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    uploadedFiles: new Map(),
    totalBytes: 0,
    backend,
  };

  if (backend === "local") {
    ws.localDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ws-"));
  } else if (backend === "sprite") {
    ws.spriteName = spriteName;
    ws.remotePath = `/home/sprite/ws-${id}`;
    // Create manifest on remote to establish directory
    await spriteWriteFile(
      spriteName,
      `${ws.remotePath}/.manifest.json`,
      Buffer.from(JSON.stringify({ id, created: Date.now() })),
    );
  } else if (backend === "vercel") {
    ws.sandboxId = sandboxId;
    ws.remotePath = `ws-${id}`;
    // Create directory on sandbox
    await vercelMkdir(sandboxId, ws.remotePath);
  }

  workspaces.set(id, ws);
  return { id };
}

/**
 * Save a file to a workspace.
 */
async function saveFile(workspaceId, filename, buffer) {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw Object.assign(new Error("Workspace not found"), { code: 404 });
  if (ws.state === "running") {
    throw Object.assign(new Error("Cannot upload while workspace is running"), { code: 409 });
  }

  ws.lastAccessedAt = Date.now();
  ws.totalBytes += buffer.length;
  ws.uploadedFiles.set(filename, { size: buffer.length });

  if (ws.backend === "local") {
    const filePath = safePath(ws.localDir, filename);
    fs.writeFileSync(filePath, buffer);
  } else if (ws.backend === "sprite") {
    await spriteWriteFile(
      ws.spriteName,
      `${ws.remotePath}/${filename}`,
      buffer,
    );
  } else if (ws.backend === "vercel") {
    // Use tarball upload for Vercel
    const tar = createTarGz([{ name: filename, buffer }]);
    await vercelWriteTar(ws.sandboxId, ws.remotePath, tar);
  }

  return { name: filename, size: buffer.length };
}

/**
 * List files in a workspace.
 */
async function listFiles(workspaceId) {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw Object.assign(new Error("Workspace not found"), { code: 404 });
  ws.lastAccessedAt = Date.now();

  const files = [];

  if (ws.backend === "local") {
    const entries = fs.readdirSync(ws.localDir);
    for (const name of entries) {
      const stat = fs.statSync(path.join(ws.localDir, name));
      if (!stat.isFile()) continue;
      const isUploaded = ws.uploadedFiles.has(name);
      files.push({
        name,
        size: stat.size,
        type: isUploaded ? "input" : "output",
      });
    }
  } else if (ws.backend === "sprite") {
    const listing = await spriteListDir(ws.spriteName, ws.remotePath);
    for (const entry of listing) {
      if (entry.name === ".manifest.json") continue;
      const isUploaded = ws.uploadedFiles.has(entry.name);
      files.push({
        name: entry.name,
        size: entry.size || 0,
        type: isUploaded ? "input" : "output",
      });
    }
  } else if (ws.backend === "vercel") {
    const listing = await vercelListDir(ws.sandboxId, ws.remotePath);
    for (const entry of listing) {
      const isUploaded = ws.uploadedFiles.has(entry.name);
      files.push({
        name: entry.name,
        size: entry.size || 0,
        type: isUploaded ? "input" : "output",
      });
    }
  }

  return files;
}

/**
 * Read a file from a workspace. Returns a ReadableStream.
 */
async function readFile(workspaceId, filename) {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw Object.assign(new Error("Workspace not found"), { code: 404 });
  ws.lastAccessedAt = Date.now();

  if (ws.backend === "local") {
    const filePath = safePath(ws.localDir, filename);
    if (!fs.existsSync(filePath)) {
      throw Object.assign(new Error("File not found"), { code: 404 });
    }
    return fs.createReadStream(filePath);
  } else if (ws.backend === "sprite") {
    return spriteReadFile(ws.spriteName, `${ws.remotePath}/${filename}`);
  } else if (ws.backend === "vercel") {
    return vercelReadFile(ws.sandboxId, ws.remotePath, filename);
  }
}

/**
 * Delete a workspace and all its files.
 */
async function deleteWorkspace(workspaceId) {
  const ws = workspaces.get(workspaceId);
  if (!ws) return;

  workspaces.delete(workspaceId);

  if (ws.backend === "local") {
    try {
      fs.rmSync(ws.localDir, { recursive: true, force: true });
    } catch {}
  } else if (ws.backend === "sprite") {
    spriteDeleteDir(ws.spriteName, ws.remotePath).catch(() => {});
  } else if (ws.backend === "vercel") {
    vercelDeleteDir(ws.sandboxId, ws.remotePath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------
function setWorkspaceState(id, state) {
  const ws = workspaces.get(id);
  if (ws) ws.state = state;
}

function getWorkspace(id) {
  return workspaces.get(id) || null;
}

function getWorkspaceCwd(id) {
  const ws = workspaces.get(id);
  if (!ws) return null;
  if (ws.backend === "local") return ws.localDir;
  return ws.remotePath;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove expired workspaces (skip running ones).
 */
async function cleanupExpired(ttlMs) {
  const now = Date.now();
  for (const [id, ws] of workspaces) {
    if (ws.state === "running") continue;
    if (now - ws.lastAccessedAt > ttlMs) {
      await deleteWorkspace(id);
    }
  }
}

/**
 * Startup scan: remove stale oc-ws-* dirs from tmpdir (local only).
 */
function cleanupOrphaned() {
  try {
    const tmpDir = os.tmpdir();
    const entries = fs.readdirSync(tmpDir);
    const knownLocalDirs = new Set();
    for (const ws of workspaces.values()) {
      if (ws.localDir) knownLocalDirs.add(ws.localDir);
    }
    for (const name of entries) {
      if (!name.startsWith("oc-ws-")) continue;
      const fullPath = path.join(tmpDir, name);
      if (knownLocalDirs.has(fullPath)) continue;
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// File manifest for system prompt injection
// ---------------------------------------------------------------------------
function buildFileManifest(workspaceId) {
  const ws = workspaces.get(workspaceId);
  if (!ws || ws.uploadedFiles.size === 0) return null;

  const lines = ["Files in your working directory:"];
  for (const [name, info] of ws.uploadedFiles) {
    lines.push(`- ${name} (${formatBytes(info.size)})`);
  }
  return lines.join("\n");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/**
 * Validate and sanitize a filename.
 */
function validateFilename(name) {
  if (!name || typeof name !== "string") return null;
  // Strip path components
  const base = path.basename(name);
  if (!base || base === "." || base === "..") return null;
  // Reject null bytes and control chars
  if (/[\x00-\x1f]/.test(base)) return null;
  // Reject path traversal
  if (base.includes("..")) return null;
  // Max 255 bytes
  if (Buffer.byteLength(base, "utf-8") > 255) return null;
  return base;
}

/**
 * Ensure file access stays within workspace directory.
 */
function safePath(baseDir, filename) {
  const resolved = path.resolve(baseDir, filename);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    throw Object.assign(new Error("Path traversal blocked"), { code: 403 });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Content-Type mapping
// ---------------------------------------------------------------------------
const CONTENT_TYPES = {
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++src",
  ".sh": "text/x-shellscript",
};

function contentTypeForFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Tar/Gz creation for Vercel (zero deps, minimal ustar)
// ---------------------------------------------------------------------------

/**
 * Create a gzipped tar archive from an array of {name, buffer} entries.
 */
function createTarGz(files) {
  const blocks = [];

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, "utf-8");
    if (nameBytes.length > 100) {
      throw new Error(`Filename too long for tar: ${file.name}`);
    }

    // 512-byte ustar header
    const header = Buffer.alloc(512);

    // name (0-100)
    nameBytes.copy(header, 0);

    // mode (100-108) — 0644
    header.write("0000644\0", 100, 8, "ascii");

    // uid (108-116)
    header.write("0000000\0", 108, 8, "ascii");

    // gid (116-124)
    header.write("0000000\0", 116, 8, "ascii");

    // size (124-136) — octal, 11 digits + null
    const sizeStr = file.buffer.length.toString(8).padStart(11, "0");
    header.write(sizeStr + "\0", 124, 12, "ascii");

    // mtime (136-148) — current time in octal
    const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, "0");
    header.write(mtime + "\0", 136, 12, "ascii");

    // checksum placeholder (148-156) — spaces
    header.write("        ", 148, 8, "ascii");

    // typeflag (156) — '0' = regular file
    header.write("0", 156, 1, "ascii");

    // magic (257-263) — "ustar\0"
    header.write("ustar\0", 257, 6, "ascii");

    // version (263-265) — "00"
    header.write("00", 263, 2, "ascii");

    // Compute checksum: sum of all bytes in header (treating checksum field as spaces)
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    const checksumStr = checksum.toString(8).padStart(6, "0");
    header.write(checksumStr + "\0 ", 148, 8, "ascii");

    blocks.push(header);

    // File data, padded to 512-byte boundary
    const data = file.buffer;
    blocks.push(data);
    const padding = 512 - (data.length % 512);
    if (padding < 512) {
      blocks.push(Buffer.alloc(padding));
    }
  }

  // Two 512-byte zero blocks as end-of-archive marker
  blocks.push(Buffer.alloc(1024));

  const tar = Buffer.concat(blocks);
  return zlib.gzipSync(tar);
}

// ---------------------------------------------------------------------------
// Sprite backend helpers
// ---------------------------------------------------------------------------

async function spriteWriteFile(spriteName, remotePath, buffer) {
  const encodedPath = encodeURIComponent(remotePath);
  const url = `${config.SPRITE_API}/v1/sprites/${encodeURIComponent(spriteName)}/fs/write?path=${encodedPath}&workingDir=/home/sprite&mkdir=true`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.SPRITE_TOKEN}`,
      "Content-Type": "application/octet-stream",
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(
      new Error(`Sprite file write failed (${res.status}): ${text}`),
      { code: 502 },
    );
  }
}

async function spriteReadFile(spriteName, remotePath) {
  const encodedPath = encodeURIComponent(remotePath);
  const url = `${config.SPRITE_API}/v1/sprites/${encodeURIComponent(spriteName)}/fs/read?path=${encodedPath}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.SPRITE_TOKEN}` },
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw Object.assign(new Error("File not found"), { code: 404 });
    }
    throw Object.assign(
      new Error(`Sprite file read failed (${res.status})`),
      { code: 502 },
    );
  }

  // Convert web ReadableStream to Node.js Readable
  return Readable.fromWeb(res.body);
}

async function spriteListDir(spriteName, remotePath) {
  const encodedPath = encodeURIComponent(remotePath);
  const url = `${config.SPRITE_API}/v1/sprites/${encodeURIComponent(spriteName)}/fs/list?path=${encodedPath}&workingDir=/home/sprite`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.SPRITE_TOKEN}` },
  });

  if (!res.ok) {
    if (res.status === 404) return [];
    throw Object.assign(
      new Error(`Sprite dir list failed (${res.status})`),
      { code: 502 },
    );
  }

  const data = await res.json();
  // Sprite fs/list returns array of { name, size, type, ... }
  return (data.entries || data || []).filter((e) => e.type === "file");
}

async function spriteDeleteDir(spriteName, remotePath) {
  const encodedPath = encodeURIComponent(remotePath);
  const url = `${config.SPRITE_API}/v1/sprites/${encodeURIComponent(spriteName)}/fs/delete?path=${encodedPath}`;

  await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.SPRITE_TOKEN}` },
  });
}

/**
 * Check if a workspace directory still exists on the sprite.
 */
async function spriteWorkspaceExists(spriteName, remotePath) {
  const encodedPath = encodeURIComponent(remotePath + "/.manifest.json");
  const url = `${config.SPRITE_API}/v1/sprites/${encodeURIComponent(spriteName)}/fs/read?path=${encodedPath}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.SPRITE_TOKEN}` },
  });
  if (res.ok || res.status === 200) {
    // Drain body to avoid memory leak
    await res.text().catch(() => {});
  }
  return res.ok;
}

// ---------------------------------------------------------------------------
// Vercel backend helpers
// ---------------------------------------------------------------------------

function vercelUrl(urlPath) {
  const sep = urlPath.includes("?") ? "&" : "?";
  return `${config.VERCEL_API}${urlPath}${sep}teamId=${encodeURIComponent(config.VERCEL_TEAM_ID)}`;
}

function vercelHdrs() {
  return {
    Authorization: `Bearer ${config.VERCEL_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function vercelMkdir(sandboxId, dirPath) {
  const res = await fetch(vercelUrl(`/v1/sandboxes/${sandboxId}/fs/mkdir`), {
    method: "POST",
    headers: vercelHdrs(),
    body: JSON.stringify({ path: dirPath, cwd: "/vercel/sandbox" }),
  });

  if (!res.ok) {
    throw Object.assign(
      new Error(`Vercel mkdir failed (${res.status}): ${await res.text()}`),
      { code: 502 },
    );
  }
}

async function vercelWriteTar(sandboxId, cwd, tarBuffer) {
  const res = await fetch(vercelUrl(`/v1/sandboxes/${sandboxId}/fs/write`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.VERCEL_TOKEN}`,
      "Content-Type": "application/gzip",
      "x-cwd": `/vercel/sandbox/${cwd}`,
    },
    body: tarBuffer,
  });

  if (!res.ok) {
    throw Object.assign(
      new Error(`Vercel tar write failed (${res.status}): ${await res.text()}`),
      { code: 502 },
    );
  }
}

async function vercelReadFile(sandboxId, dirPath, filename) {
  const filePath = `${dirPath}/${filename}`;
  const res = await fetch(vercelUrl(`/v1/sandboxes/${sandboxId}/fs/read`), {
    method: "POST",
    headers: vercelHdrs(),
    body: JSON.stringify({ path: filePath, cwd: "/vercel/sandbox" }),
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw Object.assign(new Error("File not found"), { code: 404 });
    }
    throw Object.assign(
      new Error(`Vercel file read failed (${res.status})`),
      { code: 502 },
    );
  }

  return Readable.fromWeb(res.body);
}

async function vercelListDir(sandboxId, dirPath) {
  // Use exec to list files with sizes
  const cmd = `find ${dirPath} -maxdepth 1 -type f -printf '%s %f\\n'`;
  const res = await fetch(vercelUrl(`/v1/sandboxes/${sandboxId}/cmd`), {
    method: "POST",
    headers: vercelHdrs(),
    body: JSON.stringify({
      command: "bash",
      args: ["-c", cmd],
      env: {},
      cwd: "/vercel/sandbox",
    }),
  });

  if (!res.ok) return [];
  const data = await res.json();
  const cmdId = data.command.id;

  // Stream stdout from logs endpoint (Vercel API doesn't return output inline)
  let stdout = "";
  const logsRes = await fetch(
    vercelUrl(`/v1/sandboxes/${sandboxId}/cmd/${cmdId}/logs`),
    { headers: { Authorization: `Bearer ${config.VERCEL_TOKEN}` } },
  );

  if (!logsRes.ok) return [];
  const text = await logsRes.text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.stream === "stdout") stdout += event.data;
    } catch {}
  }

  const entries = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    const size = parseInt(trimmed.slice(0, spaceIdx), 10);
    const name = trimmed.slice(spaceIdx + 1);
    if (name && !isNaN(size)) {
      entries.push({ name, size });
    }
  }
  return entries;
}

async function vercelDeleteDir(sandboxId, dirPath) {
  await fetch(vercelUrl(`/v1/sandboxes/${sandboxId}/cmd`), {
    method: "POST",
    headers: vercelHdrs(),
    body: JSON.stringify({
      command: "rm",
      args: ["-rf", dirPath],
      env: {},
      cwd: "/vercel/sandbox",
    }),
  });
}

/**
 * Check if a workspace directory still exists on the sandbox.
 */
async function vercelWorkspaceExists(sandboxId, dirPath) {
  const res = await fetch(vercelUrl(`/v1/sandboxes/${sandboxId}/cmd`), {
    method: "POST",
    headers: vercelHdrs(),
    body: JSON.stringify({
      command: "test",
      args: ["-d", dirPath],
      env: {},
      cwd: "/vercel/sandbox",
    }),
  });

  if (!res.ok) return false;
  const data = await res.json();
  const cmdId = data.command.id;

  const waitRes = await fetch(
    vercelUrl(`/v1/sandboxes/${sandboxId}/cmd/${cmdId}?wait=true`),
    { headers: { Authorization: `Bearer ${config.VERCEL_TOKEN}` } },
  );
  if (!waitRes.ok) return false;
  const waitData = await waitRes.json();
  return waitData.command?.exitCode === 0;
}

/**
 * Pre-run validation: check that workspace dir still exists on remote.
 */
async function validateWorkspaceExists(workspaceId) {
  const ws = workspaces.get(workspaceId);
  if (!ws) return false;

  if (ws.backend === "local") {
    return fs.existsSync(ws.localDir);
  } else if (ws.backend === "sprite") {
    return spriteWorkspaceExists(ws.spriteName, ws.remotePath);
  } else if (ws.backend === "vercel") {
    return vercelWorkspaceExists(ws.sandboxId, ws.remotePath);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  init,
  createWorkspace,
  saveFile,
  listFiles,
  readFile,
  deleteWorkspace,
  cleanupExpired,
  cleanupOrphaned,
  setWorkspaceState,
  getWorkspace,
  getWorkspaceCwd,
  buildFileManifest,
  validateFilename,
  contentTypeForFile,
  createTarGz,
  validateWorkspaceExists,
  safePath,
};
