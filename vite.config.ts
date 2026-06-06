import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" keeps asset paths relative so the same build works locally,
// on GitHub Pages project subpaths, and any static host.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
