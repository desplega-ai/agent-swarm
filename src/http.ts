/**
 * HTTP Server Entry Point
 *
 * This file is a thin entry point that delegates to the modular route handlers
 * in src/http/. All route logic lives in dedicated modules under that directory.
 *
 * Run: bun src/http.ts
 */
import "./http/index";
