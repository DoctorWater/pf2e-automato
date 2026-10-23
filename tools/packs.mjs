// Чтение паков pf2e: LevelDB 8.6.1 через classic-level из установки Foundry (в репозиторий не добавляется), иначе json 8.4.1.
import { readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DATA, PACKS, readJson } from "./lib.mjs";

const FOUNDRY_MODULES = process.env.FOUNDRY_NODE_MODULES ?? "E:/Foundry VTT v14.366/app/resources/app/node_modules/";
const SYSTEM = join(DATA, "systems/pf2e");

export function classicLevel() {
  try { return createRequire(FOUNDRY_MODULES).call ? createRequire(FOUNDRY_MODULES)(join(FOUNDRY_MODULES, "classic-level")).ClassicLevel : null; } catch { return null; }
}

/** -> { version, source: "leveldb"|"json", packs: async iterator {pack, isActor, docs[]} } */
export async function openPacks({ prefer = process.env.PF2E_SOURCE ?? "leveldb" } = {}) {
  const CL = prefer === "leveldb" && existsSync(join(SYSTEM, "system.json")) ? classicLevel() : null;
  if (CL) {
    const sys = readJson(join(SYSTEM, "system.json"));
    return {
      version: sys.version, source: "leveldb",
      async *packs() {
        for (const p of sys.packs) {
          if (!["Item", "Actor"].includes(p.type)) continue;
          const db = new CL(join(SYSTEM, p.path), { keyEncoding: "utf8", valueEncoding: "utf8" });
          await db.open();
          const docs = [], key = p.type === "Actor" ? "!actors!" : "!items!";
          for await (const [k, v] of db.iterator({ gte: key, lt: key + "\xff" })) docs.push(JSON.parse(v));
          if (p.type === "Actor") {   // встроенные предметы лежат отдельными ключами, в документе — только их id
            const emb = new Map();
            for await (const [k, v] of db.iterator({ gte: "!actors.items!", lt: "!actors.items!\xff" })) {
              const [aid, iid] = k.slice("!actors.items!".length).split(".");
              (emb.get(aid) ?? emb.set(aid, new Map()).get(aid)).set(iid, JSON.parse(v));
            }
            for (const d of docs) d.items = (d.items ?? []).map((x) => (typeof x === "string" ? emb.get(d._id)?.get(x) : x)).filter(Boolean);
          }
          await db.close();
          yield { pack: p.name, isActor: p.type === "Actor", docs };
        }
      }
    };
  }
  let version = null;
  return {
    get version() { return version; }, source: "json",
    async *packs() {
      for (const f of readdirSync(PACKS).filter((x) => x.endsWith(".json") && !x.endsWith("_folders.json"))) {
        const docs = readJson(join(PACKS, f));
        const cs = docs[0]?._stats?.compendiumSource?.split(".");
        if (!cs) continue;
        version ??= docs[0]._stats.systemVersion;
        yield { pack: cs[2], isActor: cs[3] === "Actor", docs };
      }
    }
  };
}
