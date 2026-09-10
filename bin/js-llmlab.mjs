#!/usr/bin/env node
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("tsx/esm", pathToFileURL(import.meta.url));
await import("../src/cli.ts");
