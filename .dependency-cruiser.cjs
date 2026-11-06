/** ADR-01：只有 packages/runtime-pi 可以 import @earendil-works/*；业务包不得依赖 runtime-pi。 */
module.exports = {
  forbidden: [
    {
      name: "earendil-only-in-runtime-pi",
      severity: "error",
      comment: "ADR-01：@earendil-works/* 只能由 packages/runtime-pi 引入",
      from: { path: "^(packages|apps)/", pathNot: "^packages/runtime-pi/" },
      to: { path: "(^|/)@earendil-works/" },
    },
    {
      name: "business-not-on-runtime-pi",
      severity: "error",
      comment: "ADR-01：业务包不依赖 runtime-pi；只有组合根（apps/*）可以",
      from: { path: "^packages/", pathNot: "^packages/runtime-pi/" },
      to: { path: "^packages/runtime-pi/" },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)tests/fixtures/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
