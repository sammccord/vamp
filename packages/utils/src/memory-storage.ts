import type { CredentialStorage } from "@tempojs/client";
import { type Credential, parseCredential, stringifyCredential } from "@tempojs/common";

export class MemoryStorageStrategy implements CredentialStorage {
  storage = new Map<string, string>();
  async getCredential(key: string): Promise<Credential | undefined> {
    let credentials = await this.storage.get(key);
    if (!credentials) return undefined;
    return parseCredential(credentials as string);
  }

  async storeCredential(key: string, _credential: Credential): Promise<void> {
    await this.storage.set(key, stringifyCredential(_credential));
  }

  async removeCredential(key: string): Promise<void> {
    await this.storage.delete(key);
  }
}
