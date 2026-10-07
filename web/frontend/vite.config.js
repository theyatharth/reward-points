import { defineConfig } from "vite";
import { dirname } from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";

// The built index.html carries the app's PUBLIC API key in a <meta> tag that App
// Bridge reads. Building without it bakes in a useless page, so any `vite build`
// (not only `npm run build`) must fail without SHOPIFY_API_KEY. CI is exempt:
// there the placeholder is left in the HTML and web/index.js fills it in at runtime.
function assertApiKeyForBuild(command) {
  if (command === "build" && !process.env.CI && !process.env.SHOPIFY_API_KEY) {
    throw new Error(
      "\n\nThe frontend build will not work without an API key. Set the SHOPIFY_API_KEY environment variable when running the build command, for example:" +
        "\n\nSHOPIFY_API_KEY=<your-api-key> npm run build\n"
    );
  }
}

// Only set it when it is defined: assigning undefined to process.env stores the
// string "undefined", which Vite then writes into index.html.
if (process.env.SHOPIFY_API_KEY) {
  process.env.VITE_SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
}

const proxyOptions = {
  target: `http://127.0.0.1:${process.env.BACKEND_PORT}`,
  changeOrigin: false,
  secure: true,
  ws: false,
};

const host = process.env.HOST
  ? process.env.HOST.replace(/https?:\/\//, "")
  : "localhost";

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: process.env.FRONTEND_PORT,
    clientPort: 443,
  };
}

const config = {
  base: (process.env.APP_BASE_PATH || "/reward-points").replace(/\/$/, "") + "/",
  root: dirname(fileURLToPath(import.meta.url)),
  plugins: [react()],
  resolve: {
    preserveSymlinks: true,
  },
  server: {
    host: "localhost",
    port: process.env.FRONTEND_PORT,
    hmr: hmrConfig,
    proxy: {
      "^/(\\?.*)?$": proxyOptions,
      "^/api(/|(\\?.*)?$)": proxyOptions,
    },
  },
};

export default defineConfig(({ command }) => {
  assertApiKeyForBuild(command);
  return config;
});
