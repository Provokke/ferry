export function diffManifests(local, remote) {
  const add = [];
  const update = [];
  const remove = [];
  const same = [];
  for (const path of Object.keys(local).sort()) {
    const there = remote[path];
    if (!there) add.push(path);
    else if (there.hash !== local[path].hash) update.push(path);
    else same.push(path);
  }
  for (const path of Object.keys(remote).sort()) {
    if (!local[path]) remove.push(path);
  }
  return { add, update, remove, same };
}

export function summarise(plan, { prune = false } = {}) {
  const lines = [];
  for (const path of plan.add) lines.push(`+ ${path}`);
  for (const path of plan.update) lines.push(`~ ${path}`);
  if (prune) for (const path of plan.remove) lines.push(`- ${path}`);
  return lines;
}
