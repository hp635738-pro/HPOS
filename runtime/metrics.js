/**
 * Basic process metrics for the runtime (M1 — Step 4).
 *
 * Only numbers that describe the daemon itself are reported — never the
 * process list, environment, command lines, paths or network state. If a
 * metric cannot be measured reliably on this platform it is reported as
 * `null` (the UI says "unavailable") rather than inventing a value.
 *
 * No dependencies, Node 18+.
 */

/** Report what process.cpuUsage() / process.memoryUsage() safely allow. */
export function measureRuntimeMetrics({ pid = process.pid, cpuUsage = null, memoryUsage = null } = {}) {
  let cpu = null
  let memory = null

  try {
    const use = cpuUsage || process.cpuUsage()
    if (use && Number.isInteger(use.user) && Number.isInteger(use.system)) {
      cpu = {
        userUs: Math.max(0, use.user),
        systemUs: Math.max(0, use.system),
      }
    }
  } catch {
    cpu = null /* unavailable — never guess */
  }

  try {
    const mem = memoryUsage || process.memoryUsage()
    if (mem && Number.isInteger(mem.rss) && Number.isInteger(mem.heapUsed) && Number.isInteger(mem.heapTotal)) {
      memory = {
        rssBytes: Math.max(0, mem.rss),
        heapUsedBytes: Math.max(0, mem.heapUsed),
        heapTotalBytes: Math.max(0, mem.heapTotal),
      }
    }
  } catch {
    memory = null /* unavailable — never guess */
  }

  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    cpu,
    memory,
  }
}

/** uptime in ms from a start timestamp, never negative. */
export function uptimeMs(startedAt, now = () => Date.now()) {
  return Math.max(0, Math.trunc(now() - startedAt))
}
