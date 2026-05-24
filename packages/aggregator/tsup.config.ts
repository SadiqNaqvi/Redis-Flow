import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],

  outDir: "dist",

  format: ["esm", "cjs"],

  dts: true,

  clean: true,

  splitting: false,

  sourcemap: true,

  treeshake: true
});