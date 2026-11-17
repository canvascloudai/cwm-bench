#!/usr/bin/env node
import { noLoadAcceptance } from './lib/adapter/oci.mjs';
console.log(JSON.stringify({ ok: true, mocked: true, cloudCalls: 0, checks: noLoadAcceptance() }, null, 2));
