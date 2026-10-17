import { posix } from "node:path";
// Best-effort strace decoding. Unknown paths and truncated calls remain uncertainty.
function decode(s) {
  try {
    return JSON.parse(
      '"' +
        s.replace(
          /\\([0-7]{1,3})/g,
          (_, n) => "\\u" + parseInt(n, 8).toString(16).padStart(4, "0"),
        ) +
        '"',
    );
  } catch {
    return null;
  }
}
function quoted(text) {
  return [...text.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => ({
    value: decode(m[1]),
    index: m.index,
    end: m.index + m[0].length,
  }));
}
const systemPath = (p) =>
  ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/proc", "/dev", "/adapter"].some(
    (root) => p === root || p.startsWith(root + "/"),
  );
export function parseTrace(text, executable) {
  let started = false,
    incomplete = 0;
  const events = [],
    timeline = [],
    pending = new Map(),
    cwd = new Map(),
    active = new Set();
  const add = (e) => {
    events.push(e);
    if (timeline.length < 10000) timeline.push(e);
  };
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const match = raw.match(/^(?:\[pid\s+)?(\d+)\]?\s+(.*)$/),
      pid = match?.[1] || "main";
    let line = match?.[2] || raw;
    if (line.includes("<unfinished ...>")) {
      pending.set(pid, line.replace(/\s*<unfinished \.\.\.>$/, ""));
      continue;
    }
    if (line.startsWith("<... ")) {
      const prefix = pending.get(pid);
      pending.delete(pid);
      if (!prefix) {
        if (active.has(pid)) incomplete++;
        continue;
      }
      line = prefix + line.replace(/^<\.\.\. \w+ resumed>/, "");
    }
    const call = line.match(/^(\w+)\((.*)\)\s+=\s+(.*)$/);
    if (!call) {
      if (active.has(pid) && !/^\+\+\+|^---/.test(line)) incomplete++;
      continue;
    }
    const [, syscall, args, result] = call,
      values = quoted(args),
      first = values[0]?.value;
    if (
      !started &&
      ["execve", "execveat"].includes(syscall) &&
      first === executable &&
      /^0(?:\s|$)/.test(result)
    ) {
      started = true;
      active.add(pid);
      cwd.set(pid, null);
    }
    if (!active.has(pid)) continue;
    const success = !result.startsWith("-1 ") && !result.startsWith("?"),
      errno = result.match(/^-1 (\w+)/)?.[1] || null;
    if (
      ["clone", "clone3", "fork", "vfork"].includes(syscall) &&
      /^\d+/.test(result)
    ) {
      const child = result.match(/^\d+/)[0];
      active.add(child);
      cwd.set(child, cwd.get(pid));
      if (args.includes("CLONE_FS")) {
        cwd.set(pid, null);
        cwd.set(child, null);
      }
    }
    if (/"(?:\\.|[^"\\])*"\.\.\./.test(args)) incomplete++;
    if (["execve", "execveat"].includes(syscall)) {
      add({
        type: "process",
        target: first?.startsWith("/")
          ? posix.normalize(first)
          : "(unresolved executable)",
        success,
        errno,
      });
      continue;
    }
    if (
      [
        "connect",
        "sendto",
        "sendmsg",
        "sendmmsg",
        "bind",
        "listen",
        "accept",
        "accept4",
      ].includes(syscall)
    ) {
      const ip =
          args.match(/inet_addr\("([^"]+)"\)/)?.[1] ||
          args.match(/inet_pton\(AF_INET6, "([^"]+)"/)?.[1],
        port = args.match(/htons\((\d+)\)/)?.[1],
        unix = args.match(/sun_path="([^"]*)"/)?.[1];
      add({
        type: "network",
        target: ip
          ? `${ip}:${port || "?"}`
          : unix
            ? `unix:${unix}`
            : "(unresolved endpoint)",
        success,
        errno,
      });
      continue;
    }
    const fileCall =
      /^(open|stat|lstat|fstat|newfstat|access|faccess|unlink|rename|mkdir|rmdir|chmod|fchmod|chown|fchown|symlink|link|truncate|readlink|chdir|fchdir|utime|mknod|exec)/.test(
        syscall,
      );
    if (!fileCall) {
      if (/^(syscall_|io_uring)/.test(syscall)) incomplete++;
      continue;
    }
    // strace -yy annotates dirfds and AT_FDCWD with their paths.
    const resolvePath = (item) => {
      if (item.value === null) return null;
      if (item.value.startsWith("/")) return posix.normalize(item.value);
      const preceding = args.slice(0, item.index),
        fd = preceding.match(/(?:^|,\s*)(?:AT_FDCWD|\d+)<([^>]+)>,\s*$/)?.[1];
      const parent = fd?.startsWith("/")
        ? fd
        : /(?:^|,\s*)AT_FDCWD,\s*$/.test(preceding) || item.index === 0
          ? cwd.get(pid)
          : null;
      return parent ? posix.resolve(parent, item.value) : null;
    };
    let items = /^(rename|link)/.test(syscall)
      ? values.slice(0, 2)
      : values.slice(0, 1);
    if (["symlink", "symlinkat"].includes(syscall)) items = values.slice(1, 2); // Link payload is not a read.
    for (const item of items) {
      const path = resolvePath(item);
      if (syscall === "chdir" && success) cwd.set(pid, path);
      const write =
        /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/.test(args) ||
        /^(unlink|rename|mkdir|rmdir|chmod|fchmod|chown|fchown|symlink|link|truncate|utime|mknod)/.test(
          syscall,
        );
      if (!path) {
        if (item.value !== ".")
          add({
            type: "unresolved-file",
            target: item.value ?? "(undecodable path)",
            success,
            errno,
          });
      } else if (write || !systemPath(path))
        add({
          type: write ? "file-write" : "file-read",
          target: path,
          success,
          errno,
        });
    }
    // Successful opens can resolve a symlink or /proc alias to a different path.
    const resolved = /^open/.test(syscall)
      ? result.match(/^\d+<([^>]+)>/)?.[1]
      : null;
    if (resolved?.startsWith("/") && !systemPath(resolved)) {
      const write = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/.test(args);
      add({
        type: write ? "file-write" : "file-read",
        target: posix.normalize(resolved),
        success,
        errno,
      });
    }
    if (/O_RDWR/.test(args)) {
      for (const item of items) {
        const path = resolvePath(item);
        if (path && !systemPath(path))
          add({ type: "file-read", target: path, success, errno });
      }
      if (resolved?.startsWith("/") && !systemPath(resolved))
        add({
          type: "file-read",
          target: posix.normalize(resolved),
          success,
          errno,
        });
    }
    if (!values.length) {
      const fd = args.match(/^\d+<([^>]+)>/)?.[1];
      if (syscall === "fchdir" && success)
        cwd.set(pid, fd?.startsWith("/") ? fd : null);
      if (
        fd?.startsWith("/") &&
        (!systemPath(fd) || /^(fchmod|fchown)/.test(syscall))
      )
        add({
          type: /^(fchmod|fchown)/.test(syscall) ? "file-write" : "file-read",
          target: fd,
          success,
          errno,
        });
    }
  }
  const unique = new Map(events.map((e) => [JSON.stringify(e), e]));
  return {
    started,
    incomplete:
      incomplete + [...pending.keys()].filter((pid) => active.has(pid)).length,
    events: [...unique.values()].sort((a, b) =>
      JSON.stringify(a) < JSON.stringify(b)
        ? -1
        : JSON.stringify(a) > JSON.stringify(b)
          ? 1
          : 0,
    ),
    timeline,
  };
}
export function newEvents(before, after) {
  const old = new Set(before.map((e) => JSON.stringify(e)));
  return [
    ...new Map(
      after
        .filter((e) => !old.has(JSON.stringify(e)))
        .map((e) => [JSON.stringify(e), e]),
    ).values(),
  ];
}
