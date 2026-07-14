/**
 * src/core/http-router.mjs
 *
 * v0.9: 统一 HTTP 路由
 *
 * 插件通过 router.get()/router.post() 注册端点，不直接碰 http server。
 * 路由器负责：认证、body 解析、错误处理、统一响应。
 *
 * 认证：Basic auth（oc-password.txt），缓存 + timingSafeEqual（v0.8.7 修复）
 */

import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const PASSWORD_FILE = join(LOGS_DIR, "oc-password.txt");
const MAX_BODY_SIZE = 1024 * 1024;

export class HTTPRouter {
  constructor({ port = 9999 } = {}) {
    this.port = port;
    this.server = null;
    this.routes = []; // [{ method, path, handler }]
    this._cachedPassword = null;
  }

  /**
   * 注册路由
   * @param {string} method - GET/POST/PUT/DELETE
   * @param {string} path - 路径（如 "/status"、"/inject"）
   * @param {Function} handler - async (body, req, res) => any
   */
  register(method, path, handler) {
    this.routes.push({ method: method.toUpperCase(), path, handler });
  }

  get(path, handler) { this.register("GET", path, handler); }
  post(path, handler) { this.register("POST", path, handler); }
  put(path, handler) { this.register("PUT", path, handler); }
  delete(path, handler) { this.register("DELETE", path, handler); }

  listRoutes() {
    return this.routes
      .map(({ method, path }) => ({ method, path }))
      .sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  }

  start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.listen(this.port, "127.0.0.1", () => {
      console.log(`[http] HTTP server 已启动: http://127.0.0.1:${this.port}/`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // ===== 内部方法 =====

  _getPassword() {
    try {
      const st = statSync(PASSWORD_FILE);
      const mtime = st.mtimeMs;
      if (this._cachedPassword && this._cachedPassword.mtime === mtime) {
        return this._cachedPassword.value;
      }
      const data = JSON.parse(readFileSync(PASSWORD_FILE, "utf-8"));
      this._cachedPassword = { value: data.password, mtime };
      return data.password;
    } catch {
      this._cachedPassword = null;
      return null;
    }
  }

  _checkAuth(req) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Basic ")) return false;
    const password = this._getPassword();
    if (!password) return false;
    const expected = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    const authBuf = Buffer.from(auth);
    const expBuf = Buffer.from(expected);
    if (authBuf.length !== expBuf.length) return false;
    return timingSafeEqual(authBuf, expBuf);
  }

  async _readBody(req) {
    return new Promise((resolve) => {
      let data = "";
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return;
        data += chunk;
        if (data.length > MAX_BODY_SIZE) {
          tooLarge = true;
          resolve(null);
        }
      });
      req.on("end", () => {
        if (tooLarge) return;
        try { resolve(data ? JSON.parse(data) : null); }
        catch { resolve(null); }
      });
      req.on("error", () => resolve(null));
    });
  }

  async _handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // v0.9.3: 健康检查端点免认证（sidecar 探测 korina 不需要密码）
    const NO_AUTH_PATHS = new Set(["/status", "/sidecars/ping"]);
    const method = req.method;

    // 认证
    if (!NO_AUTH_PATHS.has(path) && !this._checkAuth(req)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // 查找路由
    const route = this.routes.find(r => r.method === method && r.path === path);
    if (!route) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: `Not Found: ${method} ${path}` }));
      return;
    }

    // 解析 body
    let body = null;
    if (method === "POST" || method === "PUT") {
      body = await this._readBody(req);
    } else if (method === "GET" && url.searchParams.toString()) {
      body = Object.fromEntries(url.searchParams.entries());
    }

    // 调用 handler
    try {
      const result = await route.handler(body, req, res);
      if (res.writableEnded) return; // handler 已直接响应
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result, null, 2));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: e.message }));
    }
  }
}
