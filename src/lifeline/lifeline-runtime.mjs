export class LifelineRuntime {
  constructor({
    id = "main",
    injector,
    bindingStore = injector?.bindingStore,
    modules = {},
    metadata = {},
  } = {}) {
    if (!id || typeof id !== "string") throw new Error("LifelineRuntime 需要 id");
    if (!injector) throw new Error("LifelineRuntime 需要 injector");

    this.id = id;
    this.injector = injector;
    this.bindingStore = bindingStore;
    this.modules = new Map(Object.entries(modules));
    this.metadata = { ...metadata };
    this.createdAt = Date.now();
  }

  get primarySessionId() {
    return this.bindingStore?.getPrimarySessionId?.() || this.injector.sessionId || null;
  }

  get ocBase() {
    return this.injector.serverConfig?.base || null;
  }

  listBoundSessionIds() {
    if (this.bindingStore?.listBoundSessionIds) return this.bindingStore.listBoundSessionIds();
    if (this.injector.listBoundSessions) return this.injector.listBoundSessions();
    return this.injector.sessionId ? [this.injector.sessionId] : [];
  }

  bindSession(sessionId, options = {}) {
    if (this.injector.bindSession) return this.injector.bindSession(sessionId, options);
    throw new Error("injector 不支持 bindSession");
  }

  unbindSession(sessionId, options = {}) {
    if (this.injector.unbindSession) return this.injector.unbindSession(sessionId, options);
    throw new Error("injector 不支持 unbindSession");
  }

  async inject(text, options = {}) {
    return await this.injector.inject(text, options);
  }

  async silentInject(text, options = {}) {
    return await this.injector.silentInject(text, options);
  }

  async injectAndWait(text, onProgress = null, options = {}) {
    return await this.injector.injectAndWait(text, onProgress, options);
  }

  registerModule(name, module) {
    if (!name || typeof name !== "string") throw new Error("module name 必填");
    this.modules.set(name, module);
    return { ok: true, name, total: this.modules.size };
  }

  getModule(name) {
    return this.modules.get(name) || null;
  }

  listModules() {
    return Array.from(this.modules.keys()).sort();
  }

  status() {
    return {
      id: this.id,
      ocBase: this.ocBase,
      primarySessionId: this.primarySessionId,
      boundSessionIds: this.listBoundSessionIds(),
      modules: this.listModules(),
      createdAt: this.createdAt,
      metadata: { ...this.metadata },
    };
  }
}
