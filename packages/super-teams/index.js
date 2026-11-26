import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DshSuperTeamsRuntime, primaryToolSchemas, legacyToolSchemas } from './src/runtime.mjs';

export const name = 'super-teams';
export const inject = ['tools'];

const BUNDLED_SKILL_RANK = 600;
const PROVIDER_NAME = 'dsh-super-teams-bundled';
const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills', 'super-teams');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');

const READ_ONLY_TOOLS = new Set([
  'engine_overview',
  'engine_evidence',
  'teams_engine',
  'teams_read',
  'teams_task_packet',
]);

function parseSkillMarkdown(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match) return null;
  const descMatch = /^description:\s*(.+)$/mu.exec(match[1]);
  const description = descMatch ? descMatch[1].trim().replace(/^['"]|['"]$/g, '') : '';
  if (!description) return null;
  return {
    description,
    content: raw.slice(match[0].length).trim(),
  };
}

function createBundledSkillProvider() {
  return {
    name: PROVIDER_NAME,
    async list() {
      try {
        const raw = await fs.readFile(SKILL_MD, 'utf8');
        const parsed = parseSkillMarkdown(raw);
        if (!parsed) return [];
        return [{
          name: 'super-teams',
          description: parsed.description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: PROVIDER_NAME,
          source: 'bundled',
          resourceBase: { kind: 'directory', path: SKILL_DIR },
          rank: BUNDLED_SKILL_RANK,
          locator: pathToFileURL(SKILL_MD),
        }];
      } catch {
        return [];
      }
    },
    async get(candidate) {
      if (candidate?.name !== 'super-teams') return undefined;
      try {
        const raw = await fs.readFile(SKILL_MD, 'utf8');
        const parsed = parseSkillMarkdown(raw);
        if (!parsed) return undefined;
        return {
          name: 'super-teams',
          description: parsed.description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: PROVIDER_NAME,
          source: 'bundled',
          resourceBase: { kind: 'directory', path: SKILL_DIR },
          content: parsed.content,
        };
      } catch {
        return undefined;
      }
    },
  };
}

// R1：按规范化 dataDir 维护进程内唯一调度所有者注册表，确保新旧入口同时打开同一数据目录时只存在单一调度实例
const activeRuntimeOwners = new Map();

function acquireRuntimeOwner({ ctx, dataDir }) {
  const probe = new DshSuperTeamsRuntime({ ctx, ...(dataDir ? { dataDir } : {}) });
  const key = process.platform === 'win32' ? probe.dataDir.toLowerCase() : probe.dataDir;
  const existing = activeRuntimeOwners.get(key);
  if (existing && !existing.runtime.closed) {
    existing.refCount++;
    return {
      runtime: existing.runtime,
      release() {
        existing.refCount--;
        if (existing.refCount <= 0) {
          activeRuntimeOwners.delete(key);
          return existing.runtime.close();
        }
        return undefined;
      },
    };
  }
  const entry = { runtime: probe, refCount: 1 };
  activeRuntimeOwners.set(key, entry);
  return {
    runtime: probe,
    release() {
      entry.refCount--;
      if (entry.refCount <= 0) {
        activeRuntimeOwners.delete(key);
        return entry.runtime.close();
      }
      return undefined;
    },
  };
}

export function apply(ctx, config = {}) {
  const ownership = acquireRuntimeOwner({
    ctx,
    dataDir: config?.dataDir,
  });
  const runtime = ownership.runtime;

  const enableLegacyBoard = config?.enableLegacyBoard === true || process.env.DSH_SUPER_TEAMS_LEGACY === '1';
  const activeSchemas = enableLegacyBoard
    ? [...primaryToolSchemas, ...legacyToolSchemas]
    : primaryToolSchemas;

  // By default, expose ONLY the single unified SQLite-persisted engine surface (7 engine_* + read-only teams_engine).
  for (const definition of activeSchemas) {
    const isSafeRead = READ_ONLY_TOOLS.has(definition.name);
    ctx.tools.register({
      ...definition,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => isSafeRead,
      execute(args, exec) {
        exec.signal?.throwIfAborted?.();
        return runtime.executeTool(definition.name, args, exec);
      },
    });
  }

  // Register bundled skill fallback (rank 600) so skills work even if installed without copying ~/.dsh/skills
  ctx.inject?.(['skills'], sctx => {
    const provider = createBundledSkillProvider();
    sctx.skills.registerProvider(() => provider);
  });

  ctx.inject?.(['webServer'], wctx => {
    wctx.effect(() => {
      let active = true;
      let unregisterRoute = null;
      runtime.ensureStarted()
        .then(() => {
          if (!active || !runtime.router) return;
          unregisterRoute = wctx.webServer.register({
            kind: 'prefix',
            path: '/superagent-engine',
            handler: runtime.router.handler,
          });
        })
        .catch(err => {
          wctx.logger?.warn?.(`super-teams: failed to start workbench router: ${err?.message ?? err}`);
        });
      return () => {
        active = false;
        try { unregisterRoute?.(); } catch {}
      };
    }, 'super-teams: /superagent-engine route');
  });

  ctx.effect?.(() => {
    return () => ownership.release();
  }, 'super-teams: runtime disposal');
}
