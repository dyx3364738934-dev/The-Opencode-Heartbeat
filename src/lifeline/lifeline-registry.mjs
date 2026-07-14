export class LifelineRegistry {
  constructor() {
    this.lifelines = new Map();
    this.primaryId = null;
  }

  register(lifeline, options = {}) {
    if (!lifeline?.id) throw new Error("lifeline.id 必填");
    const exists = this.lifelines.has(lifeline.id);
    if (exists && !options.replace) {
      throw new Error(`lifeline 已存在: ${lifeline.id}`);
    }

    this.lifelines.set(lifeline.id, lifeline);
    if (options.primary || !this.primaryId) this.primaryId = lifeline.id;

    return {
      ok: true,
      id: lifeline.id,
      replaced: exists,
      primaryId: this.primaryId,
      total: this.lifelines.size,
    };
  }

  unregister(id) {
    if (!this.lifelines.has(id)) return { ok: false, error: `lifeline 不存在: ${id}` };
    this.lifelines.delete(id);

    if (this.primaryId === id) {
      this.primaryId = this.lifelines.size ? this.lifelines.keys().next().value : null;
    }

    return { ok: true, id, primaryId: this.primaryId, total: this.lifelines.size };
  }

  get(id) {
    return this.lifelines.get(id) || null;
  }

  getPrimary() {
    return this.primaryId ? this.get(this.primaryId) : null;
  }

  setPrimary(id) {
    if (!this.lifelines.has(id)) return { ok: false, error: `lifeline 不存在: ${id}` };
    this.primaryId = id;
    return { ok: true, primaryId: id };
  }

  list() {
    return Array.from(this.lifelines.values()).map((lifeline) => lifeline.status());
  }

  ids() {
    return Array.from(this.lifelines.keys()).sort();
  }
}
