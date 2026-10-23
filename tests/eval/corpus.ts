import type { FixtureMemory, Fixtures } from "./fixtures";
import {
  createWorld,
  type PluginUnderTest,
  projectDirs,
  type StoreArguments,
  type StoreOutcome,
  type World,
  WorldWriter,
} from "./world";

const NOOP_ACTION = "noop";

export interface Loaded {
  readonly fixtureId: string;
  readonly projectKey: string;
  readonly outcome: StoreOutcome;
}

export interface StoredWorld {
  readonly world: World;
  readonly loaded: readonly Loaded[];
  readonly owners: ReadonlyMap<string, string>;
  readonly loadMs: number;
}

export interface MemoryPlacement {
  readonly memory: FixtureMemory;
  readonly projectKey: string;
}

export function storeArguments(memory: FixtureMemory): StoreArguments {
  return {
    title: memory.title,
    content: memory.content,
    type: memory.type,
    scope: memory.scope,
    kind: memory.kind,
    conflict_key: memory.conflict_key,
    cardinality: memory.cardinality,
    value_text: memory.value_text,
    keywords: memory.keywords,
    anchors: memory.anchors,
    questions: memory.questions,
  };
}

export function ownersOf(loaded: readonly Loaded[]): ReadonlyMap<string, string> {
  return new Map(
    loaded
      .filter((entry) => entry.outcome.action !== NOOP_ACTION)
      .map((entry) => [entry.fixtureId, entry.outcome.id]),
  );
}

export async function storeAll(
  writer: WorldWriter,
  world: World,
  items: readonly MemoryPlacement[],
): Promise<Loaded[]> {
  const loaded: Loaded[] = [];
  for (const { memory, projectKey } of items) {
    const cwd = projectDirs(world, projectKey).root;
    loaded.push({
      fixtureId: memory.id,
      projectKey,
      outcome: await writer.store(cwd, storeArguments(memory)),
    });
  }
  return loaded;
}

export function projectKeys(fixtures: Fixtures): string[] {
  return fixtures.corpus.projects.map((project) => project.key);
}

export async function buildCorpusWorld(
  plugin: PluginUnderTest,
  fixtures: Fixtures,
  modelCacheDir: string,
  disposables: string[],
): Promise<StoredWorld> {
  const keys = projectKeys(fixtures);
  const [defaultKey] = keys;
  if (defaultKey === undefined) {
    throw new Error("corpus declares no projects");
  }
  const world = await createWorld(keys, modelCacheDir);
  disposables.push(world.base);
  const writer = new WorldWriter(plugin, world);
  const startedAt = performance.now();
  try {
    const loaded = await storeAll(
      writer,
      world,
      fixtures.corpus.memories.map((memory) => ({
        memory,
        projectKey: memory.project ?? defaultKey,
      })),
    );
    return { world, loaded, owners: ownersOf(loaded), loadMs: performance.now() - startedAt };
  } finally {
    await writer.close();
  }
}
