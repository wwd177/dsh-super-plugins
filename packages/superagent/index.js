import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'superagent-menu';

const BUNDLED_SKILL_RANK = 600;
const PROVIDER_NAME = 'dsh-superagent-bundled';
const SKILLS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills');
const SKILL_NAMES = ['superagent-workflow', 'workflow-quality', 'development-handoff'];

function parseSkillMarkdown(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match) return null;
  const frontmatter = match[1];
  const descMatch = /^description:\s*(.+)$/mu.exec(frontmatter);
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
      const candidates = [];
      for (const skillName of SKILL_NAMES) {
        const skillDir = path.join(SKILLS_ROOT, skillName);
        const mdPath = path.join(skillDir, 'SKILL.md');
        try {
          const raw = await fs.readFile(mdPath, 'utf8');
          const parsed = parseSkillMarkdown(raw);
          if (!parsed) continue;
          candidates.push({
            name: skillName,
            description: parsed.description,
            invocation: { modelInvocable: true, userInvocable: true },
            provider: PROVIDER_NAME,
            source: 'bundled',
            resourceBase: { kind: 'directory', path: skillDir },
            rank: BUNDLED_SKILL_RANK,
            locator: pathToFileURL(mdPath),
          });
        } catch {}
      }
      return candidates;
    },
    async get(candidate) {
      const skillName = candidate?.name;
      if (!SKILL_NAMES.includes(skillName)) return undefined;
      const skillDir = path.join(SKILLS_ROOT, skillName);
      const mdPath = path.join(skillDir, 'SKILL.md');
      try {
        const raw = await fs.readFile(mdPath, 'utf8');
        const parsed = parseSkillMarkdown(raw);
        if (!parsed) return undefined;
        return {
          name: skillName,
          description: parsed.description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: PROVIDER_NAME,
          source: 'bundled',
          resourceBase: { kind: 'directory', path: skillDir },
          content: parsed.content,
        };
      } catch {
        return undefined;
      }
    },
  };
}

export function apply(ctx) {
  ctx?.inject?.(['skills'], sctx => {
    const provider = createBundledSkillProvider();
    sctx.skills.registerProvider(() => provider);
  });
}
