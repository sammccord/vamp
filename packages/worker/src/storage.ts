import { type BaseEntity } from "@framework/ecs";
import { type Env } from "cloudflare:workers";
import type { YDocStorage } from "y-durablestream";
import { DurableObjectSqlStorage, YStreamProvider } from "y-durablestream";

export class ECSStorage<E extends BaseEntity = BaseEntity> extends YStreamProvider<Env> {
  protected override createStorage(): YDocStorage {
    return new DurableObjectSqlStorage(this.ctx.storage, {
      maxBytes: 20 * 1024,
      maxUpdates: 1000,
    });
  }

  entity(id: string): E {
    return this.doc.getMap(id).toJSON() as E;
  }
}
