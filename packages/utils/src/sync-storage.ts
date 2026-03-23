import type { CredentialStorage } from "@tempojs/client";
import { type Credential, parseCredential, stringifyCredential } from "@tempojs/common";
import { storage } from "webextension-polyfill";

export class SyncStorageStrategy implements CredentialStorage {
  async getCredential(key: string): Promise<Credential | undefined> {
    let credentials = await storage.sync.get(key);
    if (!credentials[key]) return undefined;
    return parseCredential(credentials[key] as string);
  }

  async storeCredential(key: string, _credential: Credential): Promise<void> {
    await storage.sync.set({ [key]: stringifyCredential(_credential) });
  }

  async removeCredential(key: string): Promise<void> {
    await storage.sync.remove(key);
  }
}
