/**
 * Agent Skills module for the built-in MCP server.
 *
 * Exposes skills directories (each containing a SKILL.md with frontmatter)
 * as MCP tools: list_skills, activate_skill, read_resource, run_script.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi", ".mov",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
  ".wasm", ".o", ".a", ".class", ".pyc",
]);

function isValidSkillName(name) {
  if (!name || typeof name !== "string") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  if (name.includes("\0")) return false;
  if (name === "." || name === "..") return false;
  return true;
}

function safePath(base, relative) {
  if (typeof relative === "string" && relative.includes("\0")) return null;
  const resolved = path.resolve(base, relative);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
    return resolved;
  }
  let realBase;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    return null;
  }
  if (!real.startsWith(realBase + path.sep) && real !== realBase) return null;
  return real;
}

function isBinaryFile(filePath) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (m) {
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      meta[m[1].trim()] = value;
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Skill operations
// ---------------------------------------------------------------------------

function discoverSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.isSymbolicLink())
    .map((d) => {
      const skillMd = path.join(skillsDir, d.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) return null;
      const raw = fs.readFileSync(skillMd, "utf-8");
      const fm = parseFrontmatter(raw);
      return {
        name: d.name,
        display_name: fm.name || d.name,
        description: fm.description || "",
        dir: path.join(skillsDir, d.name),
      };
    })
    .filter(Boolean);
}

function loadSkillContent(skillsDir, skillName) {
  if (!isValidSkillName(skillName)) return null;
  const skillMd = safePath(skillsDir, path.join(skillName, "SKILL.md"));
  if (!skillMd || !fs.existsSync(skillMd)) return null;
  return fs.readFileSync(skillMd, "utf-8");
}

function listSkillFiles(skillDir) {
  const files = [];
  const walk = (dir, prefix, depth) => {
    if (!fs.existsSync(dir) || depth > 10) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel, depth + 1);
      else if (entry.name !== "SKILL.md") files.push(rel);
    }
  };
  walk(skillDir, "", 0);
  return files;
}

function readResource(skillsDir, skillName, filePath) {
  if (!isValidSkillName(skillName)) return { error: "Invalid skill name" };
  if (!fs.existsSync(skillsDir)) return { error: "Skills directory not found" };
  const skillDir = path.join(skillsDir, skillName);
  const resolved = safePath(skillDir, filePath);
  if (!resolved) return { error: "Path traversal not allowed" };
  if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };
  if (isBinaryFile(resolved)) return { error: `Binary file — cannot return as text: ${filePath}` };
  return { content: fs.readFileSync(resolved, "utf-8") };
}

function runScript(skillsDir, skillName, scriptPath) {
  return new Promise((resolve) => {
    if (!isValidSkillName(skillName)) return resolve({ error: "Invalid skill name" });
    if (!fs.existsSync(skillsDir)) return resolve({ error: "Skills directory not found" });

    const normalized = scriptPath.replace(/\\/g, "/");
    if (!normalized.startsWith("scripts/")) {
      return resolve({ error: "Scripts must be in the scripts/ directory" });
    }

    const skillDir = path.join(skillsDir, skillName);
    const resolved = safePath(skillDir, scriptPath);
    if (!resolved) return resolve({ error: "Path traversal not allowed" });
    if (!fs.existsSync(resolved)) return resolve({ error: `Script not found: ${scriptPath}` });

    const ext = path.extname(resolved).toLowerCase();
    let cmd, args;
    if (ext === ".sh") { cmd = "bash"; args = [resolved]; }
    else if (ext === ".js" || ext === ".mjs") { cmd = "node"; args = [resolved]; }
    else if (ext === ".py") { cmd = "python3"; args = [resolved]; }
    else { cmd = resolved; args = []; }

    execFile(cmd, args, { cwd: skillDir, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          exitCode: typeof err.status === "number" ? err.status : 1,
          stdout: stdout || "",
          stderr: stderr || err.message,
        });
      }
      resolve({ exitCode: 0, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// MCP tool definitions & handler
// ---------------------------------------------------------------------------

function getToolDefinitions(scriptsEnabled, _permissions) {
  const tools = [
    {
      name: "list_skills",
      description: "Returns the skill catalog — name, description, and available files for each registered skill.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "activate_skill",
      description: "Loads the full SKILL.md content for a given skill name. Use when a skill is relevant to the current task.",
      inputSchema: {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The skill name (as returned by list_skills)" },
        },
        required: ["skill_name"],
      },
    },
    {
      name: "read_resource",
      description: "Reads a specific file from a skill's directory (references, templates, scripts). Use list_skills to see available files first.",
      inputSchema: {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The skill name" },
          file_path: { type: "string", description: "Relative path within the skill directory (e.g. references/setup-guide.md)" },
        },
        required: ["skill_name", "file_path"],
      },
    },
  ];

  if (scriptsEnabled) {
    tools.push({
      name: "run_script",
      description: "Executes a bundled script from a skill's scripts/ directory and returns stdout/stderr. Supports .sh, .js, .py, or any executable with a shebang.",
      inputSchema: {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The skill name" },
          script_path: { type: "string", description: "Relative path to the script (e.g. scripts/hello.sh)" },
        },
        required: ["skill_name", "script_path"],
      },
    });
  }

  return tools;
}

async function handleToolCall(toolName, args, skillsDir, scriptsEnabled, _permissions) {
  if (toolName === "list_skills") {
    const skills = discoverSkills(skillsDir);
    const catalog = skills.map((s) => ({
      name: s.name,
      display_name: s.display_name,
      description: s.description,
      files: listSkillFiles(s.dir),
    }));
    return { content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }] };
  }

  if (toolName === "activate_skill") {
    const content = loadSkillContent(skillsDir, args.skill_name);
    if (!content) {
      return { content: [{ type: "text", text: `Skill not found: ${args.skill_name}` }], isError: true };
    }
    return { content: [{ type: "text", text: content }] };
  }

  if (toolName === "read_resource") {
    const result = readResource(skillsDir, args.skill_name, args.file_path);
    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }
    return { content: [{ type: "text", text: result.content }] };
  }

  if (toolName === "run_script" && scriptsEnabled) {
    const result = await runScript(skillsDir, args.skill_name, args.script_path);
    if (result.error) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }
    const output = [
      `Exit code: ${result.exitCode}`,
      result.stdout ? `--- stdout ---\n${result.stdout}` : "",
      result.stderr ? `--- stderr ---\n${result.stderr}` : "",
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text: output }] };
  }

  return null; // not a skills tool
}

module.exports = { getToolDefinitions, handleToolCall };
