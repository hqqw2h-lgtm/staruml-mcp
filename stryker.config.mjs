// Mutation testing (https://stryker-mutator.io): every mutant of src/ runs against the tests that
// cover it (vitest-runner measures coverage per test). A score under `break` fails the run, which
// .github/workflows/mutation.yml runs weekly and `npm run test:mutation` locally.
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  mutate: ["src/**/*.ts"],
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 90, low: 85, break: 85 },
  // The HTTP tests start servers and the fixtures bind ports; a mutant that hangs one is a timeout.
  timeoutMS: 20_000,
  tempDirName: ".stryker-tmp",
};
