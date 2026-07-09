/**
 * Infer software tool categories from name, description, and URL.
 */
import { SEED_CATEGORIES } from './tool-library-store.js';

/** @type {{ category: string, patterns: RegExp[] }[]} */
const CATEGORY_RULES = [
  {
    category: '3D modeling',
    patterns: [
      /\b3d\s*(?:cad|model|modeling|print|design)\b/i,
      /\bcad\b/i,
      /\bcam\b/i,
      /\bcae\b/i,
      /\bsolidworks\b/i,
      /\bfusion\s*360\b/i,
      /\bfreecad\b/i,
      /\bonshape\b/i,
      /\binventor\b/i,
      /\bcatia\b/i,
      /\brhino(?:3d)?\b/i,
      /\bblender\b/i,
      /\bsketchup\b/i,
      /\bbricscad\b/i,
      /\bsolid\s*edge\b/i,
      /\bparametric\b/i,
    ],
  },
  {
    category: 'video',
    patterns: [
      /\bvideo\s*edit/i,
      /\bnon[-\s]?linear\b/i,
      /\bkdenlive\b/i,
      /\bpremiere\b/i,
      /\bdavinci\b/i,
      /\bfinal\s*cut\b/i,
      /\bffmpeg\b/i,
      /\bscreen\s*record/i,
      /\bvideo\s*production\b/i,
    ],
  },
  {
    category: 'audio',
    patterns: [
      /\baudio\s*edit/i,
      /\bdaw\b/i,
      /\baudacity\b/i,
      /\breaper\b/i,
      /\bfl\s*studio\b/i,
      /\bsound\s*design\b/i,
      /\bpodcast\b/i,
    ],
  },
  {
    category: 'design',
    patterns: [
      /\bui\s*design\b/i,
      /\bux\s*design\b/i,
      /\bfigma\b/i,
      /\bsketch\b/i,
      /\bgraphic\s*design\b/i,
      /\billustrator\b/i,
      /\bphotoshop\b/i,
      /\bcanva\b/i,
    ],
  },
  {
    category: 'development',
    patterns: [
      /\bide\b/i,
      /\bcode\s*edit/i,
      /\bdeveloper\s*tool/i,
      /\bprogramming\b/i,
      /\bgithub\b/i,
      /\bgitlab\b/i,
      /\bvs\s*code\b/i,
      /\bcompiler\b/i,
      /\bapi\s*client\b/i,
    ],
  },
  {
    category: 'project mgmt',
    patterns: [
      /\bproject\s*management\b/i,
      /\btask\s*track/i,
      /\bkanban\b/i,
      /\btrello\b/i,
      /\basana\b/i,
      /\bnotion\b/i,
      /\bjira\b/i,
    ],
  },
  {
    category: 'writing',
    patterns: [
      /\bwriting\b/i,
      /\bword\s*process/i,
      /\bmarkdown\s*edit/i,
      /\bobsidian\b/i,
      /\bscrivener\b/i,
      /\bdocument\s*edit/i,
    ],
  },
  {
    category: 'automation',
    patterns: [
      /\bautomation\b/i,
      /\bworkflow\b/i,
      /\bzapier\b/i,
      /\bmake\.com\b/i,
      /\bn8n\b/i,
      /\bscripting\b/i,
    ],
  },
  {
    category: 'AI',
    patterns: [
      /\bartificial\s*intelligence\b/i,
      /\bmachine\s*learning\b/i,
      /\bllm\b/i,
      /\bchatgpt\b/i,
      /\bopenai\b/i,
      /\bclaude\b/i,
      /\bcopilot\b/i,
    ],
  },
  {
    category: 'notes',
    patterns: [
      /\bnote[-\s]?taking\b/i,
      /\bnotes?\s*app\b/i,
      /\bevernote\b/i,
      /\bbear\s*app\b/i,
      /\bobsidian\b/i,
    ],
  },
  {
    category: 'communication',
    patterns: [
      /\bchat\b/i,
      /\bmessaging\b/i,
      /\bslack\b/i,
      /\bdiscord\b/i,
      /\bteams\b/i,
      /\bzoom\b/i,
      /\bvideo\s*conferenc/i,
    ],
  },
  {
    category: 'finance',
    patterns: [
      /\baccounting\b/i,
      /\bfinance\b/i,
      /\binvoic/i,
      /\bbookkeep/i,
      /\bquickbooks\b/i,
    ],
  },
  {
    category: 'security',
    patterns: [
      /\bsecurity\b/i,
      /\bvpn\b/i,
      /\bpassword\s*manager\b/i,
      /\b1password\b/i,
      /\blastpass\b/i,
      /\bantivirus\b/i,
    ],
  },
];

/**
 * @param {{ name?: string, description?: string, url?: string, host?: string }} input
 * @returns {string[]}
 */
export function inferToolCategories(input) {
  const name = String(input?.name || '').trim();
  const description = String(input?.description || '').trim();
  const host = String(input?.host || '').trim();
  const url = String(input?.url || '').trim();
  const blob = `${name} ${description} ${host} ${url}`.toLowerCase();

  /** @type {string[]} */
  const matched = [];
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((re) => re.test(blob))) {
      matched.push(rule.category);
    }
  }

  if (matched.length) return [...new Set(matched)].slice(0, 3);

  const seedHit = SEED_CATEGORIES.find((c) => new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i').test(blob));
  if (seedHit) return [seedHit];

  const generated = generateCategoryFromText(blob);
  return generated ? [generated] : ['utilities'];
}

/**
 * @param {string} blob
 */
function generateCategoryFromText(blob) {
  if (/\b(edit|editor)\b/.test(blob)) return 'utilities';
  if (/\bcloud\b/.test(blob)) return 'utilities';
  return '';
}

/**
 * @param {string} s
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} title
 */
export function cleanToolName(title) {
  const raw = decodeHtmlEntities(String(title || '').trim());
  if (!raw) return '';
  let cleaned = raw.replace(/^what is\s+/i, '').replace(/\?+$/, '').trim();
  cleaned = cleaned.replace(/^octave\s+/i, '').replace(/\s+software$/i, '').trim();
  const parts = cleaned.split(/\s*[|\-–—:]\s*/);
  const first = parts[0]?.trim() || cleaned;
  return first.replace(/\s+/g, ' ').slice(0, 80);
}

/**
 * @param {string} s
 */
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
