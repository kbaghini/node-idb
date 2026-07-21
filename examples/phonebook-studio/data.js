const DAY_MS = 24 * 60 * 60 * 1_000
const BASE_TIME = Date.UTC(2026, 6, 21, 12, 0, 0)

export const DEFAULT_PHONEBOOK_CONFIG = Object.freeze({
  seed: 20_260_721,
  companyCount: 60,
  groupCount: 16,
  contactCount: 1_500,
  membershipCount: 3_200,
  interactionCount: 7_500,
})

const configLimits = Object.freeze({
  companyCount: 500,
  groupCount: 200,
  contactCount: 10_000,
  membershipCount: 50_000,
  interactionCount: 50_000,
})

const firstNames = [
  'Ada', 'Amir', 'Anita', 'Arman', 'Clara', 'Daniel', 'Darya', 'Elena',
  'Farid', 'Grace', 'Hana', 'Iris', 'James', 'Kamran', 'Layla', 'Lina',
  'Maya', 'Nadia', 'Nima', 'Omid', 'Parisa', 'Roya', 'Sam', 'Sara',
  'Sofia', 'Tara', 'Victor', 'Yara', 'Zahra', 'Zubin',
]

const lastNames = [
  'Abbasi', 'Bennett', 'Chen', 'Davis', 'Ebrahimi', 'Farrell', 'Garcia',
  'Haddad', 'Ibrahim', 'Johnson', 'Karimi', 'Khan', 'Lee', 'Martin',
  'Moradi', 'Nouri', 'Petrov', 'Rahimi', 'Rivera', 'Rossi', 'Shah',
  'Taylor', 'Walker', 'Williams', 'Yousefi',
]

const companyPrefixes = [
  'Atlas', 'Bluebird', 'Caspian', 'Cedar', 'Cirrus', 'Evergreen', 'Faraday',
  'Horizon', 'Juniper', 'Keystone', 'Lumina', 'Meridian', 'Nimbus', 'Northstar',
  'Orchid', 'Pioneer', 'Quartz', 'Redwood', 'Solstice', 'Summit', 'Vertex',
]

const companySuffixes = [
  'Analytics', 'Design', 'Foods', 'Health', 'Industries', 'Labs', 'Logistics',
  'Media', 'Networks', 'Partners', 'Robotics', 'Software', 'Systems', 'Works',
]

const industries = [
  'education', 'energy', 'finance', 'healthcare', 'hospitality', 'logistics',
  'manufacturing', 'media', 'retail', 'software', 'telecommunications',
]

const cities = [
  ['Tehran', 'Tehran', 'Iran'],
  ['Shiraz', 'Fars', 'Iran'],
  ['Tabriz', 'East Azerbaijan', 'Iran'],
  ['London', 'England', 'United Kingdom'],
  ['Berlin', 'Berlin', 'Germany'],
  ['Toronto', 'Ontario', 'Canada'],
  ['New York', 'New York', 'United States'],
  ['Seattle', 'Washington', 'United States'],
  ['Paris', 'Ile-de-France', 'France'],
  ['Dubai', 'Dubai', 'United Arab Emirates'],
  ['Istanbul', 'Istanbul', 'Turkey'],
  ['Tokyo', 'Tokyo', 'Japan'],
]

const groupNames = [
  'Board members', 'Community partners', 'Customers', 'Engineering',
  'Event guests', 'Family', 'Finance', 'Friends', 'Leads', 'Marketing',
  'Operations', 'Press contacts', 'Product', 'Suppliers', 'VIP', 'Volunteers',
]

const jobTitles = [
  'Account Manager', 'Architect', 'Consultant', 'Customer Success Lead',
  'Data Analyst', 'Designer', 'Developer', 'Director', 'Engineer',
  'Founder', 'Operations Manager', 'Product Manager', 'Researcher',
  'Sales Manager', 'Support Specialist', 'Vice President',
]

const interactionSubjects = [
  'Annual contract', 'Budget review', 'Conference invitation',
  'Customer feedback', 'Delivery schedule', 'Design review', 'Introduction',
  'Invoice question', 'New opportunity', 'Onboarding', 'Partnership proposal',
  'Product demonstration', 'Project status', 'Renewal planning',
  'Support follow-up', 'Training session',
]

/** @param {number} value */
function uint32(value) {
  return value >>> 0
}

/** @param {number} seed @param {number} salt */
function mixedSeed(seed, salt) {
  let value = uint32(seed ^ salt)
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad)
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97)
  return uint32(value ^ (value >>> 15))
}

/** A compact deterministic generator; it is intentionally not cryptographic. */
export function createSeededRandom(seed) {
  let state = uint32(seed)
  return Object.freeze({
    next() {
      state = uint32(state + 0x6d2b79f5)
      let value = state
      value = Math.imul(value ^ (value >>> 15), value | 1)
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
      return uint32(value ^ (value >>> 14)) / 4_294_967_296
    },
    integer(maximum) {
      if (!Number.isSafeInteger(maximum) || maximum < 1) {
        throw new RangeError('random maximum must be a positive safe integer')
      }
      return Math.floor(this.next() * maximum)
    },
    boolean(probability = 0.5) {
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new RangeError('random probability must be a number from 0 through 1')
      }
      return this.next() < probability
    },
  })
}

/** @template T @param {{integer(maximum: number): number}} random @param {readonly T[]} values */
function pick(random, values) {
  return values[random.integer(values.length)]
}

/** @param {unknown} overrides */
export function validatePhonebookConfig(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('phonebook config must be an object')
  }
  const source = /** @type {Record<string, unknown>} */ (overrides)
  const allowed = ['seed', ...Object.keys(configLimits)]
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new TypeError(`Unknown phonebook config option: ${unknown.join(', ')}`)

  const config = { ...DEFAULT_PHONEBOOK_CONFIG, ...source }
  if (!Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 0xffff_ffff) {
    throw new RangeError('seed must be an integer from 0 through 4294967295')
  }
  for (const [key, maximum] of Object.entries(configLimits)) {
    const value = config[key]
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new RangeError(`${key} must be an integer from 1 through ${maximum}`)
    }
  }
  if (config.membershipCount > config.contactCount * config.groupCount) {
    throw new RangeError('membershipCount cannot exceed contactCount multiplied by groupCount')
  }
  return Object.freeze(/** @type {typeof DEFAULT_PHONEBOOK_CONFIG} */ (config))
}

/** @param {string} collection @param {number} objectId */
function reference(collection, objectId) {
  return { collection, objectId }
}

/** @param {readonly number[]} ids @param {string} label */
function assertObjectIds(ids, label) {
  if (!Array.isArray(ids) || !ids.length) {
    throw new TypeError(`${label} must contain positive node-idb object IDs`)
  }
  const seen = new Set()
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]
    if (
      !Object.hasOwn(ids, index) ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      seen.has(id)
    ) {
      throw new TypeError(`${label} must contain unique positive node-idb object IDs`)
    }
    seen.add(id)
  }
}

/** @param {ReturnType<typeof validatePhonebookConfig>} config */
export function generateCompanies(config) {
  const random = createSeededRandom(mixedSeed(config.seed, 0xc011ab1e))
  return Array.from({ length: config.companyCount }, (_, index) => {
    const [city, region, country] = pick(random, cities)
    const code = `COM-${String(index + 1).padStart(4, '0')}`
    const name = `${pick(random, companyPrefixes)} ${pick(random, companySuffixes)}`
    const domain = `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${index + 1}.example.test`
    return {
      companyCode: code,
      name,
      industry: pick(random, industries),
      status: random.boolean(0.9) ? 'active' : 'prospect',
      website: `https://${domain}`,
      emailDomain: domain,
      employeeBand: pick(random, ['1-10', '11-50', '51-200', '201-1000', '1000+']),
      annualRevenue: BigInt(250_000 + random.integer(200_000_000)),
      foundedAt: new Date(Date.UTC(1975 + random.integer(48), random.integer(12), 1 + random.integer(27))),
      address: {
        line1: `${100 + random.integer(8_900)} ${pick(random, ['Market', 'Oak', 'Park', 'River', 'Sunset'])} Street`,
        city,
        region,
        country,
        postalCode: `${10000 + random.integer(89999)}`,
        coordinates: {
          latitude: Number((-60 + random.next() * 120).toFixed(5)),
          longitude: Number((-170 + random.next() * 340).toFixed(5)),
        },
      },
      labels: [pick(random, ['customer', 'partner', 'prospect']), pick(random, industries)],
      logoBytes: Buffer.from([index & 255, random.integer(256), random.integer(256), 255]),
      createdAt: new Date(BASE_TIME - (300 + random.integer(2_000)) * DAY_MS),
    }
  })
}

/** @param {ReturnType<typeof validatePhonebookConfig>} config @param {readonly number[]} companyIds */
export function generateGroups(config, companyIds) {
  assertObjectIds(companyIds, 'companyIds')
  const random = createSeededRandom(mixedSeed(config.seed, 0x6a09e667))
  return Array.from({ length: config.groupCount }, (_, index) => ({
    groupCode: `GRP-${String(index + 1).padStart(3, '0')}`,
    name: index < groupNames.length ? groupNames[index] : `Contact group ${index + 1}`,
    category: pick(random, ['business', 'community', 'personal', 'team']),
    color: `#${random.integer(0x1000000).toString(16).padStart(6, '0')}`,
    description: `Deterministic sample group ${index + 1} for Studio filtering and relationship review.`,
    sponsorCompanyRef: random.boolean(0.45)
      ? reference('companies', companyIds[random.integer(companyIds.length)])
      : null,
    settings: {
      visible: random.boolean(0.92),
      defaultChannel: pick(random, ['email', 'phone', 'sms']),
      reminderDays: [1, 3, 7].slice(0, 1 + random.integer(3)),
    },
    createdAt: new Date(BASE_TIME - (50 + random.integer(1_200)) * DAY_MS),
  }))
}

/** @param {ReturnType<typeof validatePhonebookConfig>} config @param {readonly number[]} companyIds */
export function generateContacts(config, companyIds) {
  assertObjectIds(companyIds, 'companyIds')
  const random = createSeededRandom(mixedSeed(config.seed, 0xbb67ae85))
  return Array.from({ length: config.contactCount }, (_, index) => {
    const firstName = pick(random, firstNames)
    const lastName = pick(random, lastNames)
    const [city, region, country] = pick(random, cities)
    const companyId = companyIds[random.integer(companyIds.length)]
    const contactCode = `PER-${String(index + 1).padStart(6, '0')}`
    const phoneCount = 1 + random.integer(3)
    const createdDaysAgo = 30 + random.integer(1_800)
    return {
      contactCode,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      email: `${firstName}.${lastName}.${index + 1}@contacts.example.test`.toLowerCase(),
      status: pick(random, ['active', 'active', 'active', 'inactive', 'lead']),
      companyRef: reference('companies', companyId),
      job: {
        title: pick(random, jobTitles),
        department: pick(random, ['Engineering', 'Executive', 'Finance', 'Marketing', 'Operations', 'Product', 'Sales']),
        isDecisionMaker: random.boolean(0.22),
      },
      phones: Array.from({ length: phoneCount }, (_, phoneIndex) => ({
        type: phoneIndex === 0 ? 'mobile' : pick(random, ['home', 'office', 'mobile']),
        number: `+${1 + random.integer(98)}-${100 + random.integer(899)}-${1000 + random.integer(8999)}-${1000 + random.integer(8999)}`,
        preferred: phoneIndex === 0,
      })),
      address: {
        line1: `${1 + random.integer(999)} ${pick(random, ['Azadi', 'Cedar', 'Lake', 'Maple', 'Valley'])} Avenue`,
        city,
        region,
        country,
        postalCode: `${10000 + random.integer(89999)}`,
      },
      tags: Array.from(new Set([
        pick(random, ['customer', 'lead', 'partner', 'speaker', 'supplier']),
        pick(random, ['newsletter', 'priority', 'remote', 'technical', 'traveler']),
      ])),
      preferences: {
        language: pick(random, ['de', 'en', 'fa', 'fr', 'tr']),
        preferredChannel: pick(random, ['email', 'phone', 'sms']),
        marketingAllowed: random.boolean(0.7),
        quietHours: { from: '21:00', to: '08:00' },
      },
      birthday: new Date(Date.UTC(1955 + random.integer(48), random.integer(12), 1 + random.integer(27))),
      rating: 1 + random.integer(5),
      notes: index % 19 === 0
        ? 'Prefers a concise written summary after meetings; this longer text exercises Studio previews.'
        : null,
      createdAt: new Date(BASE_TIME - createdDaysAgo * DAY_MS),
      lastSeenAt: new Date(BASE_TIME - random.integer(Math.min(createdDaysAgo, 365)) * DAY_MS),
    }
  })
}

/**
 * @param {ReturnType<typeof validatePhonebookConfig>} config
 * @param {readonly number[]} contactIds
 * @param {readonly number[]} groupIds
 */
export function generateGroupMemberships(config, contactIds, groupIds) {
  assertObjectIds(contactIds, 'contactIds')
  assertObjectIds(groupIds, 'groupIds')
  if (config.membershipCount > contactIds.length * groupIds.length) {
    throw new RangeError('membershipCount exceeds the available contact/group pairs')
  }
  const random = createSeededRandom(mixedSeed(config.seed, 0x3c6ef372))
  const usedByContact = Array.from({ length: contactIds.length }, () => new Set())
  return Array.from({ length: config.membershipCount }, (_, index) => {
    const contactIndex = index % contactIds.length
    const used = usedByContact[contactIndex]
    let groupIndex = random.integer(groupIds.length)
    while (used.has(groupIndex)) groupIndex = (groupIndex + 1) % groupIds.length
    used.add(groupIndex)
    return {
      membershipCode: `MEM-${String(index + 1).padStart(7, '0')}`,
      contactRef: reference('contacts', contactIds[contactIndex]),
      groupRef: reference('groups', groupIds[groupIndex]),
      role: pick(random, ['member', 'member', 'member', 'coordinator', 'owner']),
      notifications: {
        email: random.boolean(0.74),
        sms: random.boolean(0.24),
      },
      joinedAt: new Date(BASE_TIME - random.integer(1_200) * DAY_MS),
    }
  })
}

/**
 * @param {ReturnType<typeof validatePhonebookConfig>} config
 * @param {readonly Record<string, any>[]} contacts
 * @param {readonly number[]} contactIds
 */
export function generateInteractions(config, contacts, contactIds) {
  assertObjectIds(contactIds, 'contactIds')
  if (!Array.isArray(contacts) || contacts.length !== contactIds.length) {
    throw new TypeError('contacts and contactIds must have equal lengths')
  }
  for (let index = 0; index < contacts.length; index++) {
    const companyRef = contacts[index]?.companyRef
    if (
      !companyRef ||
      companyRef.collection !== 'companies' ||
      !Number.isSafeInteger(companyRef.objectId) ||
      companyRef.objectId < 1
    ) {
      throw new TypeError(`contacts[${index}].companyRef must point to a positive companies object ID`)
    }
  }
  const random = createSeededRandom(mixedSeed(config.seed, 0xa54ff53a))
  return Array.from({ length: config.interactionCount }, (_, index) => {
    const contactIndex = (index * 17 + random.integer(contactIds.length)) % contactIds.length
    const contact = contacts[contactIndex]
    const type = pick(random, ['call', 'email', 'meeting', 'note', 'sms'])
    const occurredDaysAgo = random.integer(730)
    const followUpRequired = random.boolean(0.18)
    return {
      interactionCode: `INT-${String(index + 1).padStart(8, '0')}`,
      contactRef: reference('contacts', contactIds[contactIndex]),
      companyRef: { ...contact.companyRef },
      type,
      direction: type === 'note' ? 'internal' : pick(random, ['inbound', 'outbound']),
      subject: pick(random, interactionSubjects),
      summary: `Sample ${type} ${index + 1}; generated deterministically for querying and paging in Studio.`,
      outcome: pick(random, ['completed', 'follow-up', 'no-answer', 'scheduled', 'sent']),
      durationSeconds: ['call', 'meeting'].includes(type) ? 60 + random.integer(7_140) : null,
      occurredAt: new Date(BASE_TIME - occurredDaysAgo * DAY_MS - random.integer(DAY_MS)),
      followUp: followUpRequired
        ? {
            required: true,
            dueAt: new Date(BASE_TIME + (1 + random.integer(45)) * DAY_MS),
            owner: pick(random, ['account-team', 'sales', 'support']),
          }
        : { required: false, dueAt: null, owner: null },
      channelDetails: {
        device: pick(random, ['desktop', 'mobile', 'office-phone', 'web']),
        campaign: random.boolean(0.28) ? pick(random, ['renewal-2026', 'summer-event', 'welcome']) : null,
      },
      attachments: random.boolean(0.08)
        ? [{ name: `summary-${index + 1}.txt`, bytes: 500 + random.integer(50_000) }]
        : [],
    }
  })
}
