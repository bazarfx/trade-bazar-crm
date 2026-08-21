/**
 * Seed data — spec v3.0.
 *
 * EVERYTHING here is a starting point, not a fixture. The Admin can rename,
 * recolour, re-tag, reorder, delete and create every status, option and field
 * below. If any value in this file is referenced by name anywhere in the
 * application code, that reference is a bug — read the `tag` instead.
 */

export const LEAD_STATUSES = [
  // union of the Figma set and the Phase 1 planning document
  { name: 'New',                       tag: 'NEUTRAL',   color: '#6b7280', isSystem: false },
  { name: 'No Answer / Attempted',     tag: 'NEUTRAL',   color: '#9ca3af', isSystem: false },
  { name: 'Contacted',                 tag: 'WARM',      color: '#ff8d28', isSystem: false },
  { name: 'Follow-Up Scheduled',       tag: 'WARM',      color: '#f59e0b', isSystem: false },
  { name: 'Demo Request',              tag: 'WARM',      color: '#eab308', isSystem: false },
  { name: 'Interested',                tag: 'HOT',       color: '#16a34a', isSystem: false },
  { name: 'RM-Not Active',             tag: 'COLD',      color: '#0088ff', isSystem: false },
  // set by the ARK webhook when an account exists but no deposit has arrived
  { name: 'Signed Up',                 tag: 'SIGNED_UP', color: '#34c759', isSystem: true  },
  { name: 'Account Opened',            tag: 'HOT',       color: '#22c55e', isSystem: false },
  { name: 'Telesales Account Opened',  tag: 'HOT',       color: '#15803d', isSystem: false },
  { name: 'Not Interested',            tag: 'LOST',      color: '#ef4444', isSystem: false },
  { name: 'Wrong / Invalid Number',    tag: 'INVALID',   color: '#b91c1c', isSystem: false },
  // set by the ARK webhook at the conversion moment
  { name: 'Converted',                 tag: 'CONVERTED', color: '#0f7a37', isSystem: true  },
] as const;

export const DEAL_STATUSES = [
  { name: 'New FTD',      tag: 'HOT',     color: '#16a34a', isSystem: true  },
  { name: 'Active',       tag: 'HOT',     color: '#22c55e', isSystem: false },
  { name: 'Re-Deposited', tag: 'HOT',     color: '#15803d', isSystem: false },
  { name: 'Dormant',      tag: 'COLD',    color: '#6b7280', isSystem: false },
  { name: 'Withdrawn',    tag: 'LOST',    color: '#ff8d28', isSystem: false },
  { name: 'Closed',       tag: 'LOST',    color: '#ef4444', isSystem: false },
] as const;

export const LANGUAGES = [
  'English', 'Hindi', 'Tamil', 'Telugu', 'Urdu', 'Malayalam', 'Gujarati',
] as const;

/**
 * The `Lead.source` column is the `LeadSource` ENUM, not free text, so these
 * two values are the only ones the database can store — a third option would
 * be written straight into a Prisma enum violation. They are seeded as
 * FieldOption rows anyway so the generic form reads them like any other
 * dropdown; they must stay in step with `enum LeadSource` in schema.prisma.
 */
export const LEAD_SOURCES = [
  { value: 'CAMPAIGN', label: 'Campaign' },
  { value: 'ARK_TERMINAL', label: 'ARK Terminal' },
] as const;

export const PICKLISTS = {
  leadCategory:    ['Hot', 'Warm', 'Cold', 'Junk', 'Engaged Leads', 'High Potential'],
  leadSourceName:  ['A-One', 'ACC TBM', 'Account', 'Account Center', 'Account Join TB', 'Account Prime'],
  preferredMarket: ['NSE Futures', 'MCX', 'NSE Options', 'MCX Options', 'Forex', 'US Stocks'],
  contactMethod:   ['WhatsApp', 'Phone'],
  salutation:      ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Engr.'],
  gender:          ['Male', 'Female', 'Other'],
} as const;

/** Suggested roles. NOT system roles — the Admin creates and edits these freely. */
export const SUGGESTED_ROLES = [
  'Senior Tele Sales', 'Tele Sales', 'Relationship Manager', 'Back Office', 'Floor Manager',
] as const;

export const DEPARTMENTS = ['Sales', 'Back Office', 'Compliance'] as const;

type Field = {
  key: string; label: string; type: string;
  systemColumn?: string; isSystem?: boolean; isRequired?: boolean;
  isUnique?: boolean; isIndexed?: boolean; section: string;
  /** A bare string is a value that reads well as its own label; the pair form is
   *  for options whose stored value is a machine token (an enum member). */
  options?: readonly (string | { value: string; label: string })[];
  /** RECORD_LINK target, as a MODULE SLUG the seed resolves to an id.
   *  `FieldDefinition.relatedModuleId` is how the engine (and campaign
   *  intake's link discovery) knows what a link field points at. */
  relatedModule?: string;
  /** `FieldDefinition.defaultValue` — applied by the record engine when a
   *  create omits the key. */
  defaultValue?: unknown;
};

export const LEAD_SECTIONS = ['Lead Information', 'Personal Information', 'ARK Information'] as const;

/**
 * Union of the Figma Create Lead screen and the planning document.
 * `systemColumn` = mapped to a real column; everything else lives in `custom` JSONB.
 */
export const LEAD_FIELDS: Field[] = [
  // ── Lead Information ──────────────────────────────────────────────
  { key: 'fullName',     label: 'Full Name',      type: 'SINGLE_LINE',     systemColumn: 'fullName',     isSystem: true, isRequired: true, section: 'Lead Information' },
  { key: 'phone',        label: 'Phone No.',      type: 'PHONE',           systemColumn: 'phone',        isSystem: true, isRequired: true, isIndexed: true, section: 'Lead Information' },
  { key: 'altPhone',     label: 'Alternate Phone',type: 'PHONE',           systemColumn: 'altPhone',     section: 'Lead Information' },
  { key: 'whatsapp',     label: 'WhatsApp No.',   type: 'PHONE',           systemColumn: 'whatsapp',     section: 'Lead Information' },
  { key: 'email',        label: 'Email',          type: 'EMAIL',           systemColumn: 'email',        section: 'Lead Information' },
  { key: 'language',     label: 'Language',       type: 'DROPDOWN',        systemColumn: 'language',     isSystem: true, isRequired: true, section: 'Lead Information', options: LANGUAGES },
  { key: 'source',       label: 'Source',         type: 'DROPDOWN',        systemColumn: 'source',       isSystem: true, isRequired: true, section: 'Lead Information', options: LEAD_SOURCES },
  { key: 'statusId',     label: 'Lead Status',    type: 'DROPDOWN',        systemColumn: 'statusId',     isSystem: true, isRequired: true, section: 'Lead Information' },
  { key: 'ownerId',      label: 'Lead Owner',     type: 'USER_LOOKUP',     systemColumn: 'ownerId',      isSystem: true, isRequired: true, section: 'Lead Information' },
  { key: 'groupId',      label: 'Group',          type: 'RECORD_LINK',     systemColumn: 'groupId',      section: 'Lead Information' },
  { key: 'campaignId',   label: 'Campaign',       type: 'RECORD_LINK',     systemColumn: 'campaignId',   section: 'Lead Information', relatedModule: 'campaigns' },
  { key: 'referralCode', label: 'Referral Code',  type: 'SINGLE_LINE',     systemColumn: 'referralCode', section: 'Lead Information' },
  { key: 'salutation',   label: 'Salutation',     type: 'DROPDOWN',        section: 'Lead Information', options: PICKLISTS.salutation },
  { key: 'location',     label: 'Location',       type: 'SINGLE_LINE',     section: 'Lead Information' },
  { key: 'country',      label: 'Country / City', type: 'SINGLE_LINE',     section: 'Lead Information' },
  { key: 'leadCategory', label: 'Lead Category',  type: 'DROPDOWN',        section: 'Lead Information', options: PICKLISTS.leadCategory },
  { key: 'leadSource',   label: 'Lead Source',    type: 'DROPDOWN',        section: 'Lead Information', options: PICKLISTS.leadSourceName },
  { key: 'contactMethod',label: 'Contact Method', type: 'DROPDOWN',        section: 'Lead Information', options: PICKLISTS.contactMethod },
  { key: 'amount',       label: 'Amount',         type: 'CURRENCY',        section: 'Lead Information' },
  { key: 'notes',        label: 'Notes',          type: 'MULTI_LINE',      section: 'Lead Information' },
  { key: 'lastContacted',label: 'Last Contacted', type: 'DATE_TIME',       systemColumn: 'lastContacted', section: 'Lead Information' },

  // ── Personal Information ──────────────────────────────────────────
  { key: 'gender',       label: 'Gender',                     type: 'DROPDOWN', section: 'Personal Information', options: PICKLISTS.gender },
  { key: 'consentDate',  label: 'Date of consent by Customer',type: 'DATE',     section: 'Personal Information' },

  // ── ARK Information ───────────────────────────────────────────────
  { key: 'arkUserName',      label: 'ARK User Name',                type: 'SINGLE_LINE', section: 'ARK Information' },
  { key: 'arkAccountNo',     label: 'ARK Account Number',           type: 'SINGLE_LINE', systemColumn: 'arkAccountNo', isIndexed: true, section: 'ARK Information' },
  { key: 'accountOpenDate',  label: 'Account Open Date',            type: 'DATE',        section: 'ARK Information' },
  { key: 'ftdDateTime',      label: 'FTD Date Time',                type: 'DATE_TIME',   section: 'ARK Information' },
  { key: 'preferredMarket',  label: 'Preferred Market',             type: 'MULTI_SELECT',section: 'ARK Information', options: PICKLISTS.preferredMarket },
  { key: 'currentPlatform',  label: 'Current Platform',             type: 'SINGLE_LINE', section: 'ARK Information' },
  { key: 'whenToTrade',      label: 'When To Trade',                type: 'SINGLE_LINE', section: 'ARK Information' },
  { key: 'issue',            label: 'Issue',                        type: 'MULTI_LINE',  section: 'ARK Information' },
  { key: 'lastTerminalDate', label: 'Last Terminal Activity Date',  type: 'DATE',        section: 'ARK Information' },
  { key: 'coldDate',         label: 'Cold Date',                    type: 'DATE',        section: 'ARK Information' },
];

export const USER_FIELDS: Field[] = [
  { key: 'fullName',      label: 'Full Name',         type: 'SINGLE_LINE',     systemColumn: 'fullName',     isSystem: true, isRequired: true, section: 'User Information' },
  { key: 'email',         label: 'Email (login)',     type: 'EMAIL',           systemColumn: 'email',        isSystem: true, isRequired: true, isUnique: true, section: 'User Information' },
  { key: 'phone',         label: 'Phone',             type: 'PHONE',           systemColumn: 'phone',        section: 'User Information' },
  { key: 'roleId',        label: 'Role',              type: 'DROPDOWN',        systemColumn: 'roleId',       isSystem: true, isRequired: true, section: 'User Information' },
  { key: 'departmentId',  label: 'Department',        type: 'DROPDOWN',        systemColumn: 'departmentId', section: 'User Information' },
  { key: 'groups',        label: 'Groups',            type: 'MULTI_SELECT',    section: 'User Information' },
  { key: 'languages',     label: 'Languages Spoken',  type: 'LANGUAGE_PICKER', systemColumn: 'languages',    section: 'User Information', options: LANGUAGES },
  { key: 'employeeId',    label: 'Employee ID',       type: 'SINGLE_LINE',     section: 'User Information' },
  { key: 'reportingManagerId', label: 'Reporting Manager', type: 'USER_LOOKUP', systemColumn: 'reportingManagerId', section: 'User Information' },
  { key: 'isActive',      label: 'Status',            type: 'TOGGLE',          systemColumn: 'isActive',     isSystem: true, section: 'User Information' },
  { key: 'dateOfJoining', label: 'Date of Joining',   type: 'DATE',            section: 'User Information' },
  { key: 'profilePhoto',  label: 'Profile Photo',     type: 'IMAGE',           section: 'User Information' },
];

export const DEAL_FIELDS: Field[] = [
  { key: 'leadId',         label: 'Linked Lead',        type: 'RECORD_LINK', systemColumn: 'leadId',         isSystem: true, isRequired: true, section: 'Deal Information', relatedModule: 'leads' },
  { key: 'arkAccountNo',   label: 'ARK Account Number', type: 'SINGLE_LINE', systemColumn: 'arkAccountNo',   isSystem: true, isRequired: true, isIndexed: true, section: 'Deal Information' },
  { key: 'closedById',     label: 'Closed By',          type: 'USER_LOOKUP', systemColumn: 'closedById',     isSystem: true, isRequired: true, section: 'Deal Information' },
  { key: 'ownerId',        label: 'Deal Owner',         type: 'USER_LOOKUP', systemColumn: 'ownerId',        isSystem: true, isRequired: true, section: 'Deal Information' },
  { key: 'statusId',       label: 'Deal Status',        type: 'DROPDOWN',    systemColumn: 'statusId',       isSystem: true, isRequired: true, section: 'Deal Information' },
  { key: 'language',       label: 'Language',           type: 'DROPDOWN',    systemColumn: 'language',       isSystem: true, section: 'Deal Information', options: LANGUAGES },
  { key: 'ftdAmount',      label: 'FTD Amount',         type: 'CURRENCY',    systemColumn: 'ftdAmount',      section: 'Deal Information' },
  { key: 'ftdDate',        label: 'FTD Date',           type: 'DATE_TIME',   systemColumn: 'ftdDate',        section: 'Deal Information' },
  { key: 'totalDeposited', label: 'Total Deposited',    type: 'CURRENCY',    systemColumn: 'totalDeposited', isSystem: true, section: 'Deal Information' },
  { key: 'depositCount',   label: 'Deposit Count',      type: 'NUMBER',      systemColumn: 'depositCount',   isSystem: true, section: 'Deal Information' },
  { key: 'campaignId',     label: 'Campaign of Origin', type: 'RECORD_LINK', systemColumn: 'campaignId',     section: 'Deal Information', relatedModule: 'campaigns' },
  { key: 'notes',          label: 'Notes',              type: 'MULTI_LINE',  section: 'Deal Information' },
];

/**
 * Campaign records (spec §9): name, platform, details, tracking parameters.
 *
 * Seeded so campaign intake can find-or-create a Campaign THROUGH the record
 * engine the moment a payload names one — a module with no fields has no
 * write contract, and the engine (rightly) cannot insert into it.
 *
 * `platform` is NOT NULL in the Campaign table, so it carries a defaultValue:
 * intake only ever learns a campaign NAME from a payload (the Integrately
 * shape is still unknown), and "Unknown" is seed DATA the Admin can edit —
 * both the default and the record — rather than a guess baked into code.
 */
export const CAMPAIGN_FIELDS: Field[] = [
  { key: 'name',     label: 'Campaign Name', type: 'SINGLE_LINE', systemColumn: 'name',     isSystem: true, isRequired: true, section: 'Campaign Information' },
  { key: 'platform', label: 'Platform',      type: 'SINGLE_LINE', systemColumn: 'platform', isSystem: true, isRequired: true, section: 'Campaign Information', defaultValue: 'Unknown' },
  { key: 'details',  label: 'Details',       type: 'MULTI_LINE',  systemColumn: 'details',  section: 'Campaign Information' },
  { key: 'spend',    label: 'Spend',         type: 'CURRENCY',    systemColumn: 'spend',    section: 'Campaign Information' },
];

export const MODULES = [
  { slug: 'leads',     label: 'Lead',     labelPlural: 'Leads',     isCore: true,  isSystem: true, navOrder: 2, recordTitleField: 'fullName', icon: 'users' },
  { slug: 'deals',     label: 'Deal',     labelPlural: 'Deals',     isCore: true,  isSystem: true, navOrder: 3, recordTitleField: 'arkAccountNo', icon: 'handshake' },
  { slug: 'campaigns', label: 'Campaign', labelPlural: 'Campaigns', isCore: true,  isSystem: true, navOrder: 4, recordTitleField: 'name', icon: 'megaphone' },
  { slug: 'users',     label: 'User',     labelPlural: 'Users',     isCore: true,  isSystem: true, navOrder: 5, recordTitleField: 'fullName', icon: 'user-cog' },
  { slug: 'deposits',  label: 'Deposit',  labelPlural: 'Deposits',  isCore: true,  isSystem: true, navOrder: 6, recordTitleField: 'amount', icon: 'banknote' },
] as const;
