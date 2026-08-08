#!/usr/bin/env node

const healthUrl = process.env.WORKER_HEALTH_URL;
if (!healthUrl) {
  console.error("WORKER_HEALTH_URL is not configured");
  process.exit(1);
}

for (let attempt = 1; attempt <= 6; attempt += 1) {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      console.log(`Health check passed on attempt ${attempt}`);
      process.exit(0);
    }
  } catch {
    // Endpoint and response details stay out of public workflow logs.
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
}

console.error("Health check failed after 30 seconds; endpoint details suppressed");
process.exit(1);
