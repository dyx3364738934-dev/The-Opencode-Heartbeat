/**
 * src/core/plugin-loader.mjs
 *
 * v0.9: 插件加载器
 *
 * 扫描 plugins/ 目录，加载所有 plugin.mjs，按依赖顺序 init。
 * 提供 shutdown() 按逆序 destroy 所有插件。
 *
 * 插件接口：
 *   export default {
 *     name: "xxx",
 *     dependencies: ["oc-injector"],  // 可选：依赖的其他插件名
 *     init(ctx) { ... },              // 初始化，返回 true 或 throw
 *     destroy() { ... },              // 清理资源
 *   }
 *
 * ctx 包含：
 *   queue     - 事件队列（push/subscribe/start/stop）
 *   bus       - 事件总线（on/emit/once）
 *   http      - HTTP 路由（get/post/register）
 *   presets   - 配置系统（get/set/onReload）
 *   log       - 日志函数（(msg) => void）
 *   korina    - 全局共享对象（插件间放引用，如 korina.injector）
 *   config    - 从 config/plugins.json 读的插件配置
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(__dirname, "..", "..", "plugins");

export class PluginLoader {
  constructor({ queue, bus, http, presets }) {
    this.queue = queue;
    this.bus = bus;
    this.http = http;
    this.presets = presets;
    this.plugins = new Map(); // name -> { module, instance, ctx }
    this.loadOrder = []; // 按依赖排序的插件名
    this.korina = {}; // 全局共享对象
  }

  /**
   * 扫描 plugins/ 目录，加载所有 plugin.mjs
   */
  async loadAll() {
    if (!existsSync(PLUGINS_DIR)) {
      console.log("[loader] plugins/ 目录不存在，无插件加载");
      return;
    }

    const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginFile = join(PLUGINS_DIR, entry.name, "plugin.mjs");
      if (!existsSync(pluginFile)) continue;

      try {
        const mod = await import(`file://${pluginFile}`);
        const plugin = mod.default;
        if (!plugin || !plugin.name) {
          console.warn(`[loader] ${entry.name}/plugin.mjs: 缺少 name 字段，跳过`);
          continue;
        }
        this.plugins.set(plugin.name, { module: plugin, instance: null, ctx: null });
        console.log(`[loader] 已加载插件: ${plugin.name}`);
      } catch (e) {
        console.error(`[loader] 加载 ${entry.name}/plugin.mjs 失败: ${e.message}`);
      }
    }

    // 拓扑排序（按依赖）
    this._topoSort();
  }

  /**
   * 拓扑排序：按 dependencies 排列 init 顺序
   */
  _topoSort() {
    const visited = new Set();
    const result = [];

    const visit = (name, stack = []) => {
      if (visited.has(name)) return;
      if (stack.includes(name)) {
        console.warn(`[loader] 循环依赖: ${stack.join(" -> ")} -> ${name}`);
        return;
      }
      const plugin = this.plugins.get(name);
      if (!plugin) return;

      const deps = plugin.module.dependencies || [];
      for (const dep of deps) {
        visit(dep, [...stack, name]);
      }

      if (!visited.has(name)) {
        visited.add(name);
        result.push(name);
      }
    };

    for (const name of this.plugins.keys()) {
      visit(name);
    }

    this.loadOrder = result;
    console.log(`[loader] 加载顺序: ${result.join(" -> ")}`);
  }

  /**
   * 按顺序 init 所有插件
   */
  async initAll() {
    for (const name of this.loadOrder) {
      const plugin = this.plugins.get(name);
      const ctx = {
        queue: this.queue,
        bus: this.bus,
        http: this.http,
        presets: this.presets,
        log: (msg) => console.log(`[${name}] ${msg}`),
        korina: this.korina,
        config: this._loadPluginConfig(name),
      };

      try {
        console.log(`[loader] 初始化插件: ${name}...`);
        const instance = await plugin.module.init(ctx);
        plugin.instance = instance;
        plugin.ctx = ctx;
        console.log(`[loader] ${name} 初始化完成`);
      } catch (e) {
        console.error(`[loader] ${name} 初始化失败: ${e.message}`);
        console.error(e.stack?.split("\n").slice(0, 3).join("\n"));
        // 不 throw -- 允许部分插件失败，其他继续
      }
    }
  }

  /**
   * 从 config/plugins.json 加载插件配置
   */
  _loadPluginConfig(name) {
    try {
      const file = join(__dirname, "..", "..", "config", "plugins.json");
      if (!existsSync(file)) return {};
      const data = JSON.parse(readFileSync(file, "utf-8"));
      return data[name] || {};
    } catch {
      return {};
    }
  }

  /**
   * 按逆序 destroy 所有插件
   */
  async shutdown() {
    console.log("[loader] 开始关闭插件...");
    const reverseOrder = [...this.loadOrder].reverse();
    for (const name of reverseOrder) {
      const plugin = this.plugins.get(name);
      if (!plugin?.instance) continue;
      try {
        if (plugin.module.destroy) {
          // v0.9.2: bind this -> instance（让 destroy 内 this.xxx 访问实例属性）
          // 之前 plugin.module.destroy() 直接调用，this 指向 plugin.module，
          // 无法访问 init 返回的 instance 字段（sseListener / _cleanupInterval 等）
          await plugin.module.destroy.call(plugin.instance);
        }
        console.log(`[loader] ${name} 已关闭`);
      } catch (e) {
        console.warn(`[loader] ${name} 关闭异常: ${e.message}`);
      }
    }
    console.log("[loader] 所有插件已关闭");
  }

  /**
   * 获取插件实例
   */
  get(name) {
    return this.plugins.get(name)?.instance;
  }

  /**
   * 列出所有插件状态
   */
  list() {
    return this.loadOrder.map(name => {
      const p = this.plugins.get(name);
      return {
        name,
        loaded: !!p?.instance,
        dependencies: p?.module.dependencies || [],
      };
    });
  }
}
