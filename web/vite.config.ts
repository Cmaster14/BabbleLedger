import { defineConfig } from "vite";

// BASE is set by the Pages workflow (e.g. "/BabbleLedger/") so asset URLs work
// when the site is served from a repo sub-path. Locally it stays "/".
export default defineConfig({
  base: process.env.BASE ?? "/",
  build: { target: "es2022" },
});
