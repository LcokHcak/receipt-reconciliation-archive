const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = path.join(WORKSPACE_ROOT, 'ppocrlabel', 'training', 'receipt_store_family_config.json');

const DEFAULT_CONFIG = Object.freeze({
  families: [
    {
      key: 'SHILLA_IPARK',
      display_name: 'SHILLA IPARK',
      priority: 40,
      aliases: ['SHILLA IPARK', 'SHILLAIPARK', 'IPARK', 'IPARK DUTY FREE'],
    },
    {
      key: 'LOTTE',
      display_name: 'LOTTE',
      priority: 30,
      aliases: ['LOTTE', 'LOTTE DUTY FREE'],
    },
    {
      key: 'THE_SHILLA',
      display_name: 'THE SHILLA',
      priority: 20,
      aliases: ['THE SHILLA', 'THESHILLA', 'THESHILLA', 'THESLLLLA', 'THESH1LLA', 'SH1LLA', 'SHILLA DUTY FREE', 'THE SHIELA', 'SHIELA', 'SHILLA'],
    },
  ],
});

let cachedConfig = null;

function normalizeAlphaNumUpper(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeConfig(rawConfig) {
  const families = Array.isArray(rawConfig?.families)
    ? rawConfig.families
    : DEFAULT_CONFIG.families;

  return {
    families: families
      .map((family) => {
        const aliases = Array.isArray(family?.aliases)
          ? family.aliases.map((alias) => normalizeAlphaNumUpper(alias)).filter(Boolean)
          : [];

        return {
          key: String(family?.key || '').trim(),
          displayName: String(family?.display_name || family?.displayName || '').trim(),
          priority: Number(family?.priority || 0),
          aliases: [...new Set(aliases)].sort((left, right) => right.length - left.length),
        };
      })
      .filter((family) => family.displayName && family.aliases.length)
      .sort((left, right) => right.priority - left.priority),
  };
}

function getReceiptStoreFamilyConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  let rawConfig = DEFAULT_CONFIG;
  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    try {
      rawConfig = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
    } catch (_error) {
      rawConfig = DEFAULT_CONFIG;
    }
  }

  cachedConfig = normalizeConfig(rawConfig);
  return cachedConfig;
}

function buildSearchTexts({ lines = [], joinedText = '' } = {}) {
  const texts = [];
  const pushText = (value) => {
    const normalized = String(value || '').trim();
    if (normalized) {
      texts.push(normalized);
    }
  };

  if (Array.isArray(lines)) {
    lines.forEach((line) => pushText(line?.text));
  }
  pushText(joinedText);

  return [...new Set(texts)];
}

function detectReceiptStoreFamily(input = {}) {
  const searchTexts = buildSearchTexts(input);
  if (!searchTexts.length) {
    return { key: '', displayName: '', matchedAlias: '', matchedText: '' };
  }

  const config = getReceiptStoreFamilyConfig();
  let bestMatch = null;

  for (const text of searchTexts) {
    const compactText = normalizeAlphaNumUpper(text);
    if (!compactText) {
      continue;
    }

    for (const family of config.families) {
      for (const alias of family.aliases) {
        if (!alias || !compactText.includes(alias)) {
          continue;
        }

        const score = family.priority * 1000 + alias.length;
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = {
            score,
            key: family.key,
            displayName: family.displayName,
            matchedAlias: alias,
            matchedText: text,
          };
        }
        break;
      }
    }
  }

  return bestMatch || { key: '', displayName: '', matchedAlias: '', matchedText: '' };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  detectReceiptStoreFamily,
  getReceiptStoreFamilyConfig,
};
