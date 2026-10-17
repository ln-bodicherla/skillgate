import { readdir, lstat, readFile, mkdir, copyFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
const MAX_FILES = 2000,
  MAX_FILE = 4 * 1024 * 1024,
  MAX_TOTAL = 64 * 1024 * 1024;
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function within(child, parent) {
  const r = relative(resolve(parent), resolve(child));
  return (
    r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !r.startsWith(sep))
  );
}
export async function snapshot(root, { rejectLinks = false } = {}) {
  const result = Object.create(null);
  let count = 0,
    total = 0;
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        key = relative(root, path).split(sep).join("/");
      if (++count > MAX_FILES)
        throw new Error("File count exceeds inspection limit.");
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        if (rejectLinks)
          throw new Error(`Symlinks are not accepted as inputs: ${key}`);
        result[key] = { type: "symlink", unsafe: true };
        continue;
      }
      if (stat.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!stat.isFile())
        throw new Error(`Special file cannot be inspected: ${key}`);
      total += stat.size;
      if (stat.size > MAX_FILE || total > MAX_TOTAL)
        throw new Error("Artifact exceeds inspection size limit.");
      const data = await readFile(path);
      result[key] = {
        type: "file",
        sha256: hash(data),
        bytes: data.length,
        executable: Boolean(stat.mode & 0o111),
      };
    }
  }
  await walk(root);
  return result;
}
export const digest = (tree) =>
  hash(
    JSON.stringify(
      Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
export async function copyTree(source, destination) {
  if (within(destination, source) || within(source, destination))
    throw new Error("Copy directories must be separate.");
  const stat = await lstat(source);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Input must be a real directory.");
  const tree = await snapshot(source, { rejectLinks: true });
  await mkdir(destination, { recursive: true });
  for (const [key, info] of Object.entries(tree)) {
    const target = join(destination, key);
    await mkdir(resolve(target, ".."), { recursive: true });
    await copyFile(join(source, key), target);
    if (info.type !== "file") throw new Error("Unexpected input type.");
  }
  const actual = await snapshot(destination, { rejectLinks: true });
  if (digest(tree) !== digest(actual))
    throw new Error("Input changed while it was being copied.");
  return { tree: actual, digest: digest(actual) };
}
export function changes(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .flatMap((path) => {
      if (JSON.stringify(before[path]) === JSON.stringify(after[path]))
        return [];
      return [
        {
          path,
          operation: !before[path]
            ? "created"
            : !after[path]
              ? "deleted"
              : "modified",
          before: before[path] || null,
          after: after[path] || null,
        },
      ];
    });
}
