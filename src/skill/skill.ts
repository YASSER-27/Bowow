const isElectron = typeof process !== 'undefined' && process.versions?.electron

export interface SkillInfo {
  name: string
  description?: string
  location: string
  content: string
  frontmatter: Record<string, any>
}

export interface SkillConfig {
  name: string
  description?: string
  match?: string[]
  instructions?: string
}

const SKILL_FILENAME = 'SKILL.md'
const CLAUDE_DIR = '.claude'
const AGENTS_DIR = '.agents'

function parseFrontmatter(text: string): { frontmatter: Record<string, any>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: text }

  const frontmatter: Record<string, any> = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    let value: any = line.slice(colon + 1).trim()
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (/^\d+$/.test(value)) value = parseInt(value, 10)
    else value = value.replace(/^["']|["']$/g, '')
    frontmatter[key] = value
  }

  return { frontmatter, body: match[2].trim() }
}

export class SkillManager {
  private skills: Map<string, SkillInfo> = new Map()

  discover(workDir: string): SkillInfo[] {
    if (!isElectron) return []
    const fs = require('fs')
    const path = require('path')
    const found: SkillInfo[] = []
    const searchDirs = [
      workDir,
      path.join(workDir, CLAUDE_DIR),
      path.join(workDir, AGENTS_DIR),
      path.join(workDir, 'skills'),
      path.join(workDir, '.skills'),
    ]

    for (const dir of searchDirs) {
      try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
      this.walkForSkills(dir, found, fs, path)
    }

    for (const skill of found) this.skills.set(skill.name, skill)
    return found
  }

  private walkForSkills(dir: string, found: SkillInfo[], fs: any, path: any): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          this.walkForSkills(fullPath, found, fs, path)
        } else if (entry.name === SKILL_FILENAME) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8')
            const { frontmatter, body } = parseFrontmatter(content)
            const skillName = frontmatter.name || path.basename(path.dirname(fullPath))
            found.push({
              name: skillName,
              description: frontmatter.description,
              location: fullPath,
              content: body,
              frontmatter,
            })
          } catch {}
        }
      }
    } catch {}
  }

  get(name: string): SkillInfo | undefined {
    return this.skills.get(name)
  }

  list(): SkillInfo[] {
    return Array.from(this.skills.values())
  }

  findRelevant(filepath: string): SkillInfo[] {
    const results: SkillInfo[] = []
    for (const skill of this.skills.values()) {
      if (skill.frontmatter.match) {
        const patterns = Array.isArray(skill.frontmatter.match)
          ? skill.frontmatter.match
          : [skill.frontmatter.match]
        for (const pattern of patterns) {
          if (filepath.includes(pattern.replace(/\*/g, ''))) {
            results.push(skill)
            break
          }
        }
      }
    }
    return results
  }

  buildGuidance(relevantSkills: SkillInfo[]): string {
    if (relevantSkills.length === 0) return ''
    const parts = relevantSkills.map(s => {
      const header = `## Skill: ${s.name}${s.description ? ` — ${s.description}` : ''}`
      return `${header}\n${s.content}`
    })
    return parts.join('\n\n')
  }

  registerBuiltin(name: string, content: string, description?: string, match?: string[]): void {
    this.skills.set(name, {
      name,
      description,
      location: '(built-in)',
      content,
      frontmatter: { name, description, match },
    })
  }
}

export const defaultSkillManager = new SkillManager()
