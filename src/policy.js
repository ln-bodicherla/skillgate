const under = (target, prefix) =>
  target === prefix || target.startsWith(prefix + "/");
export function violations(run, policy) {
  return run.trace.events.flatMap((event) => {
    let rule;
    if (event.type === "network") rule = "network-denied";
    if (
      event.type === "file-read" &&
      policy.deniedReads.some((p) => under(event.target, p))
    )
      rule = "read-denied";
    if (
      event.type === "process" &&
      policy.allowedProcesses &&
      !policy.allowedProcesses.includes(event.target)
    )
      rule = "process-not-allowed";
    return rule ? [{ rule, ...event }] : [];
  });
}
export function significantNewEvent(event, policy, allowedWrites) {
  if (
    event.type === "file-read" &&
    policy.allowNewReads &&
    !policy.deniedReads.some((p) => under(event.target, p))
  )
    return false;
  if (
    event.type === "process" &&
    policy.allowNewProcesses &&
    (!policy.allowedProcesses || policy.allowedProcesses.includes(event.target))
  )
    return false;
  if (
    event.type === "file-write" &&
    allowedWrites.some((p) => event.target === "/workspace/" + p)
  )
    return false;
  return true;
}
