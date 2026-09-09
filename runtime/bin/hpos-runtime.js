#!/usr/bin/env node
/**
 * hpos-runtime — entrypoint. Thin wrapper over daemon.js so the binary
 * surface stays boring: parse nothing, import, run.
 */
import { main } from '../daemon.js'

main().catch((err) => {
  console.error('hpos-runtime: ' + (err && err.message ? err.message : String(err)))
  process.exit(1)
})
